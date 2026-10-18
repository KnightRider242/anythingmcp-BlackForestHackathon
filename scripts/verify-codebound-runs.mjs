// SPDX-License-Identifier: AGPL-3.0-only
// Read-only CODEBOUND receipt visibility/metric smoke test against the isolated kit.
// Usage: node scripts/verify-codebound-runs.mjs E:/Projs/codebound-kit/.codebound/state.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const filename = process.argv[2];
if (!filename) throw new Error('Provide the private CODEBOUND kit state.json path');
const state = JSON.parse(readFileSync(filename, 'utf8'));
if (state.url !== 'http://localhost:4001' || state.mode !== 'host' ||
    state.users?.alice?.email !== 'alice@alpha.codebound.test' ||
    state.users?.bob?.email !== 'bob@beta.codebound.test') {
  throw new Error('Refusing to test a non-local or unexpected CODEBOUND kit');
}
async function login(user) {
  const response = await fetch(state.url + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 201 === response.status ? 201 : 200, 'Kit login must succeed');
  const body = await response.json();
  assert.equal(typeof body.accessToken, 'string');
  return body.accessToken;
}
async function get(path, token) {
  const response = await fetch(state.url + '/api/codebound/' + path, {
    headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
}
const [alice, bob] = await Promise.all([login(state.users.alice), login(state.users.bob)]);
const [alpha, beta] = await Promise.all([get('runs', alice), get('runs', bob)]);
assert.equal(alpha.status, 200);
assert.equal(beta.status, 200);
assert.equal(alpha.body.ok, true);
assert.equal(beta.body.ok, true);
assert.ok(Array.isArray(alpha.body.value.items));
assert.ok(Array.isArray(beta.body.value.items));

const aliceRuns = alpha.body.value.items;
const bobRuns = beta.body.value.items;
const seen = new Set(aliceRuns.map(run => run.executionId));
for (const run of bobRuns) assert.ok(!seen.has(run.executionId), 'Cross-workspace receipt leaked');
for (const run of [...aliceRuns, ...bobRuns]) {
  assert.equal(typeof run.executionId, 'string');
  for (const unsafe of ['input', 'source', 'output', 'errorMessage', 'authorization', 'headers', 'connectorConfig']) {
    assert.ok(!(unsafe in run), 'Receipt exposed unexpected field: ' + unsafe);
  }
}
if (aliceRuns.length) {
  const denied = await get('runs?afterId=' + encodeURIComponent(aliceRuns[0].executionId), bob);
  assert.equal(denied.status, 404, 'Bob must not paginate through an Alice cursor');
}
const completed = aliceRuns.filter(run => run.status === 'SUCCEEDED');
const incoming = completed.reduce((total, run) => total + run.connectorResponseBytes, 0);
const outgoing = completed.reduce((total, run) => total + run.outputBytes, 0);
const avoided = completed.reduce((total, run) => total + Math.max(0, run.connectorResponseBytes - run.outputBytes), 0);
console.log('CODEBOUND receipt smoke test: PASS');
console.log('Alice visible runs:', aliceRuns.length, '| Bob visible runs:', bobRuns.length);
console.log('Successful Alice runs:', completed.length);
console.log('Connector bytes:', incoming, '| Output bytes:', outgoing, '| Potential reduction bytes:', avoided);
console.log('No credentials, tokens or raw API responses printed.');
