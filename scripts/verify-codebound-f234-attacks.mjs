// SPDX-License-Identifier: AGPL-3.0-only
// Live attack probes against the existing isolated kit. No reset or key changes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const filename = resolve(process.argv[2] ?? '');
const state = JSON.parse(readFileSync(filename, 'utf8'));
assert.equal(state.url, 'http://localhost:4001');
const kit = resolve(dirname(filename), '..');
const { McpClient } = await import(pathToFileURL(resolve(kit, 'harness/mcp.mjs')).href);
async function request(path, token, method = 'GET', body) {
  const response = await fetch(state.url + path, { method, signal: AbortSignal.timeout(40_000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function login(user) {
  const response = await request('/api/auth/login', null, 'POST', { email: user.email, password: user.password });
  assert.equal(response.status, 200);
  assert.equal(typeof response.data.accessToken, 'string');
  return response.data.accessToken;
}
const bob = await login(state.users.bob);
const alice = await login(state.users.alice);
const bobBindings = (await request('/api/codebound/bindings', bob)).data.value.items;
const aliceBindings = (await request('/api/codebound/bindings', alice)).data.value.items;
const ping = bobBindings.find(item => item.toolName === 'mock_erp_ping').binding;
const payroll = aliceBindings.find(item => item.toolName === 'mock_payroll_list_salaries').binding;
function scan() {
  const result = execFileSync(process.execPath, [resolve(kit, 'harness/cli.mjs'), 'check', '--card', 'S2'],
    { cwd: kit, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.match(result, /✔ S2/);
}
async function attack(name, source, expected, input = {}) {
  const nonce = randomUUID();
  const definition = { name: `security_probe_${name}_${nonce}`, description: 'Temporary CODEBOUND security probe',
    source: `async function main(input, api) { await api.read({nonce:input.nonce}); ${source} }`,
    inputSchema: { type: 'object' }, outputSchema: {}, binding: ping };
  const saved = await request('/api/codebound/scripts', bob, 'POST', { definition });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.ok, true);
  const script = saved.data.value;
  try {
    const response = await request('/api/codebound/scripts/execute', bob, 'POST', {
      scriptId: script.id, expectedRevision: script.revision, input: { nonce, ...input },
    });
    assert.equal(response.data.ok, true);
    const result = response.data.value;
    assert.equal(result.status, expected.status);
    if (expected.code) assert.equal(result.error.code, expected.code);
    if (expected.output) assert.deepEqual(result.output, expected.output);
    const log = await (await fetch('http://127.0.0.1:4180/__log')).json();
    assert.ok(log.entries.some(entry => entry.query?.nonce === nonce), 'Attack must first reach the ERP ping');
    // The source and inputs contain no connector credentials. Check all runtime
    // output against the actual kit canaries without ever printing a canary.
    const serialized = JSON.stringify(result);
    for (const values of Object.values(state.canaries.connectors)) for (const value of Object.values(values)) {
      assert.equal(serialized.includes(value), false);
    }
    scan();
    console.log(`${name}: ${result.status}${result.error ? '/' + result.error.code : ''}; nonce verified; S2 PASS`);
  } finally {
    const removed = await request('/api/codebound/scripts/' + encodeURIComponent(script.id), bob, 'DELETE', { expectedRevision: script.revision });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.ok, true);
  }
}
await attack('A1_foreign_tool_name', `return await api.call('mock_payroll_list_salaries', {});`, { status: 'failed', code: 'FORBIDDEN' });
await attack('A2_foreign_internal_id', `return await api.call(input.tool, {});`, { status: 'failed', code: 'FORBIDDEN' },
  { tool: state.workspaces.A.toolIds.mock_erp_list_articles });
await attack('A3_host_file', `let readable=false; try { process.getBuiltinModule('fs').readFileSync(input.path); readable=true; } catch {} return {readable};`,
  { status: 'succeeded', output: { readable: false } }, { path: state.canaries.hostFilePath });
await attack('A4_host_env_stderr', `console.error(JSON.stringify(process.env)); return {hasHostCanary:!!process.env.CODEBOUND_HOST_CANARY};`,
  { status: 'succeeded', output: { hasHostCanary: false } });
const outsideBefore = await (await fetch('http://127.0.0.1:4181/__health')).json();
await attack('A5_outside', `let reachable=false; try { await fetch('http://codebound-outside:4199/probe', {signal:AbortSignal.timeout(500)}); reachable=true; } catch {} return {reachable};`,
  { status: 'succeeded', output: { reachable: false } });
const outsideAfter = await (await fetch('http://127.0.0.1:4181/__health')).json();
assert.equal(outsideAfter.seq, outsideBefore.seq);
await attack('stdout_env', `console.log(process.env); return {};`, { status: 'failed', code: 'SCRIPT_ERROR' });
await attack('thrown_env', `throw new Error(JSON.stringify(process.env));`, { status: 'failed', code: 'SCRIPT_ERROR' });
await attack('A10_call_budget', `for(let i=0;i<1000000;i++) await api.read({nonce:input.nonce}); return {};`,
  { status: 'failed', code: 'RESOURCE_LIMIT' });
// A forged cross-workspace manifest is rejected before any script is stored.
const denied = await request('/api/codebound/scripts', bob, 'POST', { definition: {
  name: 'foreign_manifest_probe', description: '', source: 'async function main(){return {};}', inputSchema: {}, outputSchema: {}, binding: payroll,
} });
assert.equal(denied.status, 403);
scan();
console.log('Foreign binding manifest: HTTP 403; S2 PASS');
const carol = new McpClient(`${state.url}/mcp/${state.workspaces.A.serverId}`, state.users.carol.key);
const result = await carol.callTool('mock_payroll_list_salaries');
assert.equal(result.ok, false);
scan();
console.log('A11 Carol Staff Payroll: refused through authenticated MCP; S2 PASS');
console.log('Temporary probe scripts removed; workflow scripts and credentials unchanged.');
