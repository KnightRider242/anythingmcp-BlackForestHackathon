// SPDX-License-Identifier: AGPL-3.0-only
// Configure ONLY the official CODEBOUND kit's isolated Alpha supplier tool.
// Usage: node scripts/configure-codebound-kit-processors.mjs <kit>/.codebound/state.json
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const stateFile = process.argv[2];
if (!stateFile) {
  console.error('Usage: node scripts/configure-codebound-kit-processors.mjs <path-to-kit>/.codebound/state.json');
  process.exit(2);
}

const state = JSON.parse(readFileSync(resolve(stateFile), 'utf8'));
const url = new URL(state.url);
if (url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !url.port || url.port === '4000' ||
    state.workspaces?.A?.name !== 'Alpha (CODEBOUND workspace A)' ||
    !state.users?.alice?.email?.endsWith('@alpha.codebound.test')) {
  throw new Error('Refusing configuration: expected isolated local CODEBOUND test backend and Alpha workspace, not the development instance');
}

const supplierId = state.workspaces.A.connectorIds?.supplier;
const offersId = state.workspaces.A.toolIds?.mock_supplier_list_offers;
if (!supplierId || !offersId) throw new Error('Run official kit setup before configuring processors');

async function request(endpoint, token, method = 'GET', body) {
  const result = await fetch(new URL(endpoint, url), {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!result.ok) throw new Error(`${method} ${endpoint}: HTTP ${result.status}`);
  return result.json();
}

const login = await request('/api/auth/login', null, 'POST', {
  email: state.users.alice.email, password: state.users.alice.password,
});
if (!login.accessToken) throw new Error('Alpha admin login returned no access token');
const token = login.accessToken;
const listing = await request(`/api/connectors/${encodeURIComponent(supplierId)}/tools`, token);
const tools = Array.isArray(listing) ? listing : listing.items ?? listing.data ?? [];
const offers = tools.find((tool) => tool.id === offersId && tool.connectorId === supplierId &&
  tool.name === 'mock_supplier_list_offers');
if (!offers) throw new Error('The official Alpha mock_supplier_list_offers tool was not found');

const chain = {
  itemsField: 'items',
  steps: [
    { operation: 'multiply', input: 'price_usd', output: 'price_eur', factor: 0.92, decimals: 2, mode: 'add' },
    { operation: 'multiply', input: 'price_eur', output: 'price_eur_gross', factor: 1.19, decimals: 2, mode: 'add' },
    { operation: 'normalizeWhitespace', input: 'description', output: 'description', mode: 'replace' },
  ],
};
const existing = offers.responseMapping && typeof offers.responseMapping === 'object' &&
  !Array.isArray(offers.responseMapping) ? offers.responseMapping : {};
await request(
  `/api/connectors/${encodeURIComponent(supplierId)}/tools/${encodeURIComponent(offersId)}`,
  token, 'PUT', { responseMapping: { ...existing, processorChain: chain } },
);
console.log('Configured processor chain on Alpha mock_supplier_list_offers only. Existing response mapping preserved.');
console.log('Run: npm run check -- --card P1 --card P2  (from codebound-kit)');
