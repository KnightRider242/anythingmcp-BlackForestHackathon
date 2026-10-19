// SPDX-License-Identifier: AGPL-3.0-only
// Explicitly opt-in installer using authenticated, public AnythingMCP APIs.
// Never opens raw connector URLs inside the sandbox, mutates existing scripts,
// resets any database, or reads kit state / credentials.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { connector, workflow, defaults } from './codebound-openfoodfacts-workflow.mjs';

const args = new Set(process.argv.slice(2));
if ([...args].some(value => !['--install', '--dry-run', '--update', '--skip-server', '--help'].includes(value)) ||
    args.has('--install') && args.has('--dry-run') || args.has('--update') && !args.has('--install')) {
  throw new Error('Usage: node scripts/install-codebound-openfoodfacts.mjs --dry-run | --install [--update] [--skip-server]');
}
if (args.has('--help')) {
  console.log('Usage: node scripts/install-codebound-openfoodfacts.mjs --dry-run | --install [--update] [--skip-server]');
  process.exit(0);
}
if (!args.has('--install')) {
  console.log('DRY RUN: would import one HTTPS read-only connector with two bounded Open Food Facts GET tools.');
  console.log('DRY RUN: would save ' + workflow.name + ', and create a dedicated MCP server (unless --skip-server).');
  console.log('DRY RUN: no network calls, credentials or database changes. Defaults: ' + JSON.stringify(defaults));
  process.exit(0);
}

const env = parseEnv(readFileSync(resolve('.env'), 'utf8'));
if (env.NODE_ENV !== 'development' || !env.PORT || !/^\d{1,5}$/.test(env.PORT)) {
  throw new Error('Installer requires an existing local development .env with PORT. Do not use against production or kit fixtures.');
}
const base = new URL(process.env.CODEBOUND_DEMO_URL ?? 'http://127.0.0.1:' + env.PORT);
if (base.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(base.hostname) ||
    base.port !== env.PORT || base.pathname !== '/' || base.search || base.hash || base.username || base.password) {
  throw new Error('CODEBOUND_DEMO_URL must be http://127.0.0.1:PORT/ or localhost using the PORT in root .env.');
}
const accessToken = process.env.CODEBOUND_DEMO_TOKEN;
const email = process.env.CODEBOUND_DEMO_EMAIL;
const password = process.env.CODEBOUND_DEMO_PASSWORD;
delete process.env.CODEBOUND_DEMO_PASSWORD;
delete process.env.CODEBOUND_DEMO_TOKEN;
if (!accessToken && (!email || !password)) {
  throw new Error('Set CODEBOUND_DEMO_TOKEN or both CODEBOUND_DEMO_EMAIL and CODEBOUND_DEMO_PASSWORD in this shell (not in .env).');
}

async function request(path, token, method = 'GET', payload) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      accept: 'application/json',
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(method + ' ' + path.split('?')[0] + ': HTTP ' + response.status);
  return response.json();
}
const login = accessToken ? null :
  await request('/api/auth/login', undefined, 'POST', { email, password });
const token = accessToken ?? login?.accessToken;
if (!token || typeof token !== 'string') throw new Error('Missing dashboard access token');

// Read before import: there must be no ambiguous existing connector of this name.
async function listAll(path, limit, maxPages = 20) {
  const rows = [];
  for (let offset = 0; offset < maxPages * limit; offset += limit) {
    const page = await request(path + (path.includes('?') ? '&' : '?') +
      'limit=' + limit + '&offset=' + offset, token);
    if (!Array.isArray(page)) throw new Error('Unexpected paginated API response for ' + path);
    rows.push(...page);
    if (page.length < limit) return rows;
  }
  throw new Error('Pagination limit reached for ' + path);
}
const existingConnectors = await listAll('/api/connectors', 100);
const matches = existingConnectors.filter(item => item.name === connector.name);
if (matches.length > 1) throw new Error('More than one existing demo connector; resolve duplicates manually.');
if (!matches.length) {
  const imported = await request('/api/connectors/import-all', token, 'POST', { connectors: [connector] });
  if (imported.created !== 1 || imported.tools !== connector.tools.length ||
      !Array.isArray(imported.errors) || imported.errors.length !== 0) {
    throw new Error('Import did not create exactly one connector and both tools; inspect the connector UI.');
  }
  console.log('Created demo connector and two read-only tools.');
}
const nowConnectors = await listAll('/api/connectors', 100);
const installed = nowConnectors.filter(item => item.name === connector.name);
if (installed.length !== 1) throw new Error('Cannot locate the single demo connector.');
const current = await request('/api/connectors/' + encodeURIComponent(installed[0].id), token);
if (current.baseUrl !== connector.baseUrl || current.type !== 'REST' || current.authType !== 'NONE' ||
    !current.isActive || !Array.isArray(current.tools)) {
  throw new Error('Existing connector is not the approved public HTTPS read-only demo. Refusing to overwrite it.');
}
for (const expected of connector.tools) {
  const toolMatches = current.tools.filter(tool => tool.name === expected.name);
  if (toolMatches.length !== 1 ||
      JSON.stringify(toolMatches[0].endpointMapping) !== JSON.stringify(expected.endpointMapping) ||
      toolMatches[0].isEnabled !== true) {
    throw new Error('Missing or modified approved tool: ' + expected.name + '. Refusing to overwrite existing definitions.');
  }
}

// Bind using live fingerprints returned by the backend, not invented IDs/hashes.
async function listBindings() {
  const found = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const data = await request('/api/codebound/bindings' +
      (cursor ? '?afterId=' + encodeURIComponent(cursor) : ''), token);
    if (data?.ok !== true || !Array.isArray(data.value?.items)) throw new Error('Cannot load approved bindings.');
    found.push(...data.value.items);
    cursor = data.value.nextCursor;
    if (!cursor) return found;
  }
  throw new Error('Binding pagination ceiling reached.');
}
const bindings = await listBindings();
const approved = workflow.tools.map(toolName => {
  const hits = bindings.filter(item => item.toolName === toolName &&
    item.binding?.connectorId === current.id);
  if (hits.length !== 1) throw new Error('Missing or ambiguous authorized tool: ' + toolName +
    '. Verify ownership, permissions and HTTPS gateway approval.');
  return hits[0].binding;
});
const definition = {
  name: workflow.name, description: workflow.description,
  source: workflow.source, inputSchema: workflow.inputSchema,
  outputSchema: workflow.outputSchema,
  binding: approved[0], additionalBindings: approved.slice(1),
};
const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, v]) => [name, normalize(v)]));
  }
  return value;
}
async function listScripts() {
  const scripts = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const data = await request('/api/codebound/scripts' +
      (cursor ? '?afterId=' + encodeURIComponent(cursor) : ''), token);
    if (data?.ok !== true || !Array.isArray(data.value)) throw new Error('Cannot list saved scripts');
    scripts.push(...data.value);
    if (data.value.length < 20) return scripts;
    cursor = data.value.at(-1).id;
  }
  throw new Error('Script pagination ceiling reached.');
}
const existingScripts = (await listScripts()).filter(script => script.name === workflow.name);
if (existingScripts.length > 1) throw new Error('Ambiguous existing workflow names.');
if (existingScripts.length === 0) {
  const saved = await request('/api/codebound/scripts', token, 'POST', { definition });
  if (!saved?.ok || saved.value?.name !== workflow.name) throw new Error('Could not save demo workflow');
  console.log('Created CODEBOUND workflow ' + workflow.name + '.');
} else {
  const script = existingScripts[0];
  const previous = Object.fromEntries(Object.keys(definition).map(k =>
    [k, script[k] ?? (k === 'additionalBindings' ? [] : undefined)]));
  if (canonical(previous) === canonical(definition)) {
    console.log('Workflow definition unchanged (revision ' + script.revision + ').');
  } else if (args.has('--update')) {
    const saved = await request('/api/codebound/scripts/' + encodeURIComponent(script.id),
      token, 'PUT', { expectedRevision: script.revision, definition });
    if (!saved?.ok || saved.value?.revision !== script.revision + 1) throw new Error('Workflow update failed');
    console.log('Updated workflow with revision check: ' + saved.value.revision + '.');
  } else {
    throw new Error('A workflow with this name differs. Nothing was overwritten; review it, then use --update if intended.');
  }
}

// A dedicated server avoids silently replacing connector grants on the
// user's current MCP servers. --skip-server is available for dashboard-only use.
if (!args.has('--skip-server')) {
  const slug = 'codebound-public-catalogue';
  const servers = await listAll('/api/mcp-servers', 100);
  const found = servers.filter(server => server.slug === slug);
  if (found.length > 1) throw new Error('Ambiguous demo MCP servers.');
  let server = found[0];
  if (!server) {
    server = await request('/api/mcp-servers', token, 'POST', {
      name: 'CODEBOUND Public Catalogue',
      slug,
      description: 'Read-only sampled live Open Food Facts workflow demo.',
    });
    if (!server.id) throw new Error('MCP server creation returned no ID');
  } else if (server.name !== 'CODEBOUND Public Catalogue') {
    throw new Error('Existing MCP server slug is used by another configuration.');
  }
  const details = await request('/api/mcp-servers/' + encodeURIComponent(server.id), token);
  const ids = Array.isArray(details.connectors)
    ? details.connectors.map(value => value.connectorId ?? value.connector?.id) : null;
  if (!ids) throw new Error('Cannot inspect MCP server assignments safely.');
  if (ids.length === 0) {
    await request('/api/mcp-servers/' + encodeURIComponent(server.id) + '/connectors',
      token, 'PUT', { connectorIds: [current.id] });
  } else if (ids.length !== 1 || ids[0] !== current.id) {
    throw new Error('Existing demo server contains other connectors. Refusing to replace its assignments.');
  }
  console.log('Demo MCP server ready at ' + base.origin + '/mcp/' + server.id);
}
console.log('Ready: open /scripts and execute ' + workflow.name + ' with ' + JSON.stringify(defaults));
console.log('Live calls happen only when you explicitly run the saved workflow.');
