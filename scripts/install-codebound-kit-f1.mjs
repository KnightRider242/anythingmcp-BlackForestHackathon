// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Install ONLY the CODEBOUND kit F1 typed-tool fixtures into the isolated Alpha
 * workspace using the authenticated AnythingMCP API and live approved bindings.
 * This does not install F2-F4 workflow implementations.
 *
 * Usage: node scripts/install-codebound-kit-f1.mjs E:\\Projs\\codebound-kit\\.codebound\\state.json
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const filename = process.argv[2];
if (!filename) {
  console.error('Usage: node scripts/install-codebound-kit-f1.mjs <codebound-kit/.codebound/state.json>');
  process.exit(2);
}
const state = JSON.parse(readFileSync(resolve(filename), 'utf8'));
const base = new URL(state.url);
if (base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname) ||
    base.port !== '4001' || state.workspaces?.A?.name !== 'Alpha (CODEBOUND workspace A)' ||
    !state.users?.alice?.email?.endsWith('@alpha.codebound.test')) {
  throw new Error('Refusing to install scripts outside the isolated localhost:4001 Alpha kit workspace');
}

async function request(path, token, method = 'GET', payload) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      accept: 'application/json',
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  // Never include a response body in errors; APIs can echo auth credentials.
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return response.json();
}
const auth = await request('/api/auth/login', null, 'POST', {
  email: state.users.alice.email,
  password: state.users.alice.password,
});
if (typeof auth.accessToken !== 'string') throw new Error('Kit Alpha login returned no access token');
const token = auth.accessToken;

const bindings = await request('/api/codebound/bindings', token);
if (!bindings.ok || !Array.isArray(bindings.value?.items)) throw new Error('Cannot load approved CODEBOUND bindings');
const existing = await request('/api/codebound/scripts', token);
if (!existing.ok || !Array.isArray(existing.value)) throw new Error('Cannot load Alpha scripts');

const definitions = [
  {
    name: 'price_drift_check',
    description: 'F1 typed-tool fixture: ERP first-page access. F2 price drift workflow pending.',
    tool: 'mock_erp_list_articles',
    inputSchema: { type: 'object', properties: {
      threshold: { type: 'number', description: 'Price drift threshold in percent' },
    }, required: ['threshold'], additionalProperties: false },
    source: 'async function main(input, api) { const page = await api.read({status:"active",page:1,pageSize:100}); return {articlesChecked: Array.isArray(page.items) ? page.items.length : 0, complete:false}; }',
  },
  {
    name: 'catalogue_total',
    description: 'F1 typed-tool fixture: supplier first-page access. F3 pagination workflow pending.',
    tool: 'mock_supplier_list_catalogue',
    inputSchema: { type: 'object', properties: {
      category: { type: 'string', description: 'Supplier category' },
    }, required: ['category'], additionalProperties: false },
    source: 'async function main(input, api) { const page = await api.read({category:input.category,page:1}); return {total:Array.isArray(page.items) ? page.items.length : 0, complete:false}; }',
  },
  {
    name: 'stuck_orders',
    description: 'F1 typed-tool fixture: ERP first-page access. F4 carrier join workflow pending.',
    tool: 'mock_erp_list_orders',
    inputSchema: { type: 'object', properties: {
      days: { type: 'number', description: 'Minimum age in days' },
      as_of: { type: 'string', description: 'Reference date YYYY-MM-DD' },
    }, required: ['days', 'as_of'], additionalProperties: false },
    source: 'async function main(input, api) { const page = await api.read({status:"shipped",page:1,pageSize:50}); return {ordersChecked:Array.isArray(page.items) ? page.items.length : 0, complete:false}; }',
  },
];

for (const definition of definitions) {
  const already = existing.value.find(script => script.name === definition.name);
  if (already) {
    console.log(`Already installed: ${definition.name}; existing definition left untouched`);
    continue;
  }
  const candidate = bindings.value.items.find(item => item.toolName === definition.tool);
  if (!candidate) {
    throw new Error(`Missing authorized binding for ${definition.tool}; run official kit setup first`);
  }
  const saved = await request('/api/codebound/scripts', token, 'POST', {
    definition: {
      name: definition.name,
      description: definition.description,
      source: definition.source,
      inputSchema: definition.inputSchema,
      outputSchema: { type: 'object' },
      binding: candidate.binding,
    },
  });
  if (!saved.ok || saved.value?.name !== definition.name) {
    throw new Error(`Cannot save typed script: ${definition.name}`);
  }
  console.log(`Installed typed script: ${definition.name}`);
}
console.log('Next: cd E:\\Projs\\codebound-kit; npm run check -- --card F1');
console.log('F2-F4 still require additional authorized connector calls and full workflows.');
