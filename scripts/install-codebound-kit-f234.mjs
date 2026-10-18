// SPDX-License-Identifier: AGPL-3.0-only
// Upgrade only Alice's existing F1 scripts; no setup, direct DB writes or resets.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { workflows } from './codebound-kit-workflows.mjs';

const filename = process.argv[2];
if (!filename) throw new Error('Usage: node scripts/install-codebound-kit-f234.mjs <kit-state.json>');
const state = JSON.parse(readFileSync(resolve(filename), 'utf8'));
const base = new URL(state.url);
if (base.href !== 'http://localhost:4001/' || state.mode !== 'host' ||
    state.workspaces?.A?.name !== 'Alpha (CODEBOUND workspace A)' ||
    state.users?.alice?.email !== 'alice@alpha.codebound.test' || !state.users.alice.password) {
  throw new Error('Refusing upgrade outside the existing localhost:4001 Alpha kit workspace');
}
async function request(path, token, method = 'GET', payload) {
  const response = await fetch(new URL(path, base), { method,
    headers: { accept: 'application/json', ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Upgrade API returned HTTP ${response.status}`);
  return response.json();
}
const auth = await request('/api/auth/login', null, 'POST', { email: state.users.alice.email, password: state.users.alice.password });
if (typeof auth.accessToken !== 'string') throw new Error('Alice login failed');
const token = auth.accessToken;
const bindings = [];
let afterId;
for (let page = 0; page < 16; page++) {
  const result = await request('/api/codebound/bindings' + (afterId ? '?afterId=' + encodeURIComponent(afterId) : ''), token);
  if (!result.ok || !Array.isArray(result.value?.items)) throw new Error('Cannot resolve approved bindings');
  bindings.push(...result.value.items);
  afterId = result.value.nextCursor;
  if (!afterId) break;
  if (page === 15) throw new Error('Binding pagination limit reached');
}
const scripts = [];
afterId = undefined;
for (let page = 0; page < 16; page++) {
  const result = await request('/api/codebound/scripts' + (afterId ? '?afterId=' + encodeURIComponent(afterId) : ''), token);
  if (!result.ok || !Array.isArray(result.value)) throw new Error('Cannot load Alice scripts');
  scripts.push(...result.value);
  if (result.value.length < 20) break;
  afterId = result.value.at(-1).id;
  if (page === 15) throw new Error('Script pagination limit reached');
}
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sort(item)]));
  return value;
}
// Resolve and validate the entire upgrade before any revision is changed.
const upgrades = workflows.map(workflow => {
  const candidates = scripts.filter(script => script.name === workflow.name);
  if (candidates.length !== 1) throw new Error(`Expected exactly one existing Alice script: ${workflow.name}`);
  const current = candidates[0];
  if (current.organizationId !== state.workspaces.A.organizationId) throw new Error('Script workspace mismatch');
  const expectedInputs = workflow.name === 'price_drift_check' ? { threshold: 'number' }
    : workflow.name === 'catalogue_total' ? { category: 'string' } : { days: 'number', as_of: 'string' };
  for (const [name, type] of Object.entries(expectedInputs)) {
    if (current.inputSchema?.properties?.[name]?.type !== type || !current.inputSchema.required?.includes(name)) {
      throw new Error(`Existing typed schema is invalid: ${workflow.name}`);
    }
  }
  const approved = workflow.tools.map(name => {
    const matches = bindings.filter(item => item.toolName === name);
    if (matches.length !== 1) throw new Error(`Missing or ambiguous approved tool: ${name}`);
    return matches[0].binding;
  });
  const definition = { name: current.name, description: workflow.description, source: workflow.source,
    inputSchema: current.inputSchema, outputSchema: workflow.outputSchema,
    binding: approved[0], additionalBindings: approved.slice(1) };
  return { current, definition };
});
for (const { current, definition } of upgrades) {
  const previous = Object.fromEntries(Object.keys(definition).map(key => [key, current[key] ?? (key === 'additionalBindings' ? [] : undefined)]));
  if (canonical(previous) === canonical(definition)) { console.log(`Unchanged: ${current.name} (revision ${current.revision})`); continue; }
  const saved = await request('/api/codebound/scripts/' + encodeURIComponent(current.id), token, 'PUT', {
    expectedRevision: current.revision, definition,
  });
  if (!saved.ok || saved.value?.revision !== current.revision + 1 || saved.value.name !== current.name) throw new Error('Revision-aware upgrade failed');
  console.log(`Upgraded: ${current.name} (revision ${saved.value.revision})`);
}
