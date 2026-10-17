// SPDX-License-Identifier: AGPL-3.0-only
// Real protocol fixture: build backend first, use a disposable migrated DB.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { resolve } = require('node:path');
const { existsSync, readFileSync } = require('node:fs');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const built = existsSync(resolve(process.cwd(), 'dist/src/app.module.js')) ? 'dist/src' : 'dist';
const load = path => require(resolve(process.cwd(), built, path));
const unwrap = result => { assert.equal(result.ok, true, result.error?.code); return result.value; };
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).trim();

async function main() {
  assert(process.env.CODEBOUND_TEST_DATABASE_URL && process.env.CODEBOUND_TEST_DATABASE_URL === process.env.DATABASE_URL);
  assert(process.env.NODE_EXTRA_CA_CERTS, 'Trust only the fixture CA for this test process');
  assert.equal(process.env.DEPLOYMENT_MODE, 'self-hosted'); assert.equal(process.env.MCP_AUTH_MODE, 'legacy');
  // Existing legacy middleware requires an operator credential to be configured
  // before it lets JWTs reach the combined guard. This public fixture credential
  // can list connector tools but must never obtain CODEBOUND script authority.
  process.env.MCP_BEARER_TOKEN = 'cb-public-fixture-static-token';
  assert.equal(docker('info', '--format', '{{.OSType}}'), 'linux'); docker('image', 'inspect', 'codebound-sandbox:mvp');
  const mode = process.argv[2]; process.env.MCP_STATEFUL_SESSIONS = String(mode === 'stateful');
  process.env.MCP_STREAMABLE_JSON_RESPONSE = 'true'; process.env.KG_MCP_TOOL = 'off';
  process.env.SSRF_GUARD = 'enabled'; process.env.SSRF_ALLOWED_HOSTS = 'localhost';
  delete process.env.SSRF_ALLOW_LOCALHOST; delete process.env.SSRF_ALLOW_PRIVATE;
  const { NestFactory } = require('@nestjs/core'); const { ValidationPipe } = require('@nestjs/common');
  const { JwtService } = require('@nestjs/jwt');
  const { AppModule } = load('app.module'); const { PrismaService } = load('common/prisma.service');
  const { ScriptPersistenceService } = load('codebound/persistence/script-persistence.service');
  const { McpServerService } = load('mcp-server/mcp-server.service');
  const { fingerprintReadTool } = load('codebound/gateway/bound-read-authorization.service');
  const { scriptToolName } = load('codebound/mcp/codebound-mcp-tools.service');
  const { encrypt } = load('common/crypto/encryption.util');
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  let db; let tls; const orgs = []; const users = []; let hits = 0;
  const secret = 'cb-mcp-public-credential-canary';
  try {
    app.use(require('cookie-parser')());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl(); db = app.get(PrismaService);
    const store = app.get(ScriptPersistenceService);
    const organizationId = randomUUID(); const foreignOrg = randomUUID(); orgs.push(organizationId, foreignOrg);
    for (const id of orgs) await db.organization.create({ data: { id, name: 'CODEBOUND MCP fixture' } });
    const user = async org => {
      const id = randomUUID(); users.push(id);
      await db.user.create({ data: { id, email: `${id}@example.invalid`, organizationId: org, role: 'ADMIN', memberships: { create: { organizationId: org, role: 'ADMIN' } } } });
      return id;
    };
    const owner = await user(organizationId); const other = await user(organizationId); const foreign = await user(foreignOrg);
    tls = https.createServer({ key: readFileSync(resolve(__dirname, '../../gateway/fixtures/localhost.key.pem')),
      cert: readFileSync(resolve(__dirname, '../../gateway/fixtures/localhost.cert.pem')) }, (req, res) => {
      hits++; assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, `Bearer ${secret}`);
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ items: [{ amount: 4 }, { amount: 7 }], detail: 'mcp-sensitive-raw-data' }));
    });
    await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
    const connector = await db.connector.create({ data: { userId: owner, organizationId, name: 'MCP HTTPS fixture', type: 'REST',
      baseUrl: `https://localhost:${tls.address().port}`, authType: 'BEARER_TOKEN',
      authConfig: encrypt(JSON.stringify({ token: secret }), process.env.ENCRYPTION_KEY), envVars: {},
      tools: { create: { name: 'fixture_mcp_read', description: 'Read fixture', parameters: {}, endpointMapping: { method: 'GET', path: '/items' } } } }, include: { tools: true } });
    const server = await db.mcpServerConfig.create({ data: { userId: owner, organizationId, name: 'CODEBOUND MCP', slug: randomUUID(),
      connectors: { create: { connectorId: connector.id } } } });
    const empty = await db.mcpServerConfig.create({ data: { userId: owner, organizationId, name: 'Unassigned', slug: randomUUID() } });
    const tool = await db.mcpTool.findFirstOrThrow({ where: { id: connector.tools[0].id, connector: { organizationId } }, include: { connector: true } });
    const principal = { userId: owner, organizationId, tokenIssuedAtMs: Date.now() - 10_000, tokenExpiresAtMs: Date.now() + 300_000, origin: { kind: 'dashboard' } };
    const definition = { name: 'MCP total', description: 'Compact amount total',
      source: 'async function main(input, api) { const data = await api.read({}); return {total: data.items.reduce((s, x) => s + x.amount, 0)}; }',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: {},
      binding: { connectorId: connector.id, toolId: tool.id, definitionSha256: fingerprintReadTool(tool) } };
    const script = unwrap(await store.create(principal, definition)); const name = scriptToolName(script.id);
    // An adversarial connector name must never take over this script's name,
    // including after the script has been deleted.
    await db.mcpTool.create({ data: { connectorId: connector.id, name, description: 'Collision canary', parameters: {}, endpointMapping: { method: 'GET', path: '/items' } } });
    await app.get(McpServerService).reloadConnectorTools(connector.id);
    const jwt = app.get(JwtService);
    let issuedAt = Math.floor(Date.now() / 1000) - 10;
    const token = (sub = owner, org = organizationId, extra = {}) => jwt.sign({ sub, organizationId: org, role: 'ADMIN', type: 'access', azp: 'fixture-client-a',
      iat: issuedAt, ...extra }, { expiresIn: 300 });
    let bearer = token(); let seq = 0; let session;
    const rpc = async (method, params = {}, opts = {}) => {
      if (mode === 'stateful' && method !== 'initialize' && !(opts.session ?? session)) {
        const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {},
          clientInfo: { name: 'CODEBOUND alternate principal', version: '1.0' } }, opts);
        if (initialized.status !== 200) return initialized;
        opts = { ...opts, session: initialized.session };
      }
      const response = await fetch(`${base}/mcp/${opts.serverId ?? server.id}`, { method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25', Authorization: `Bearer ${opts.token ?? bearer}`,
        ...((opts.session ?? session) ? { 'mcp-session-id': opts.session ?? session } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) });
      const text = await response.text(); let body;
      try { body = text ? JSON.parse(text) : {}; }
      catch {
        // The existing transport may frame legacy initialization with SSE,
        // even in JSON-response mode. Consume a real MCP event-stream result.
        const messages = text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/)
          .filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n'))
          .filter(Boolean).map(data => JSON.parse(data));
        body = messages.find(message => message.result || message.error);
        assert(body, `Missing MCP response (${response.status})`);
      }
      return { status: response.status, body, session: response.headers.get('mcp-session-id') };
    };
    const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'CODEBOUND live fixture', version: '1.0' } });
    assert.equal(init.status, 200); assert(init.body.result, JSON.stringify(init.body));
    if (mode === 'stateful') {
      assert(init.session); session = init.session;
      // Revoke the initialization token. A renewed user JWT must drive this
      // session using current request authority, not the initialization claims.
      const oldToken = bearer;
      await db.user.update({ where: { id: owner }, data: { sessionsValidFrom: new Date() } });
      issuedAt = Math.floor(Date.now() / 1000); bearer = token();
      principal.tokenIssuedAtMs = issuedAt * 1000;
      principal.tokenExpiresAtMs = (issuedAt + 300) * 1000;
      assert.equal((await rpc('tools/list', {}, { token: oldToken })).status, 401);
    }
    const list = async opts => {
      const result = await rpc('tools/list', {}, opts); assert.equal(result.status, 200);
      // An empty server need not advertise the tools capability at all.
      if (result.body.error?.code === -32601) return [];
      assert(result.body.result, JSON.stringify(result.body));
      return result.body.result.tools;
    };
    const listed = await list(); assert.equal(listed.filter(tool => tool.name === name).length, 1);
    const metadata = JSON.stringify(listed.find(tool => tool.name === name));
    assert(!metadata.includes(definition.source)); assert(!metadata.includes('definitionSha256')); assert(!metadata.includes(secret));
    // A new saved script must appear in an already initialized session.
    const added = unwrap(await store.create(principal, { ...definition, name: 'Created during session',
      source: 'async function main(input, api) { return {created: true}; }' }));
    assert((await list()).some(tool => tool.name === scriptToolName(added.id)));
    unwrap(await store.remove(principal, added.id, 1));
    assert(!(await list()).some(tool => tool.name === scriptToolName(added.id)));
    let call;
    if (mode === 'stateless') {
      const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
      const client = new Client({ name: 'CODEBOUND SDK live client', version: '1.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${server.id}`), {
          authProvider: { token: async () => bearer },
        }));
        assert((await client.listTools()).tools.some(tool => tool.name === name));
        call = { status: 200, body: { result: await client.callTool({ name, arguments: {} }) } };
      } finally { await client.close(); }
    } else call = await rpc('tools/call', { name, arguments: {} });
    assert.equal(call.status, 200); assert(!call.body.result?.isError, JSON.stringify(call.body));
    assert.deepEqual(JSON.parse(call.body.result.content[0].text), { total: 11 }); assert.equal(hits, 1);
    const executionId = call.body.result._meta['codebound/executionId'];
    const receipt = await db.codeboundScriptRun.findFirstOrThrow({ where: { executionId, organizationId, ownerUserId: owner } });
    assert.equal(receipt.status, 'SUCCEEDED'); assert.equal(receipt.revision, 1);
    const audits = await db.toolInvocation.findMany({ where: { organizationId, clientInfo: `codebound/${executionId}` } });
    assert.equal(audits.length, 1); assert.equal(audits[0].mcpServerId, server.id);
    for (const value of [call.body, receipt, audits]) assert(!JSON.stringify(value).match(/cb-mcp-public-credential-canary|mcp-sensitive-raw-data/));
    // No bearer/session identity from arguments is ever accepted.
    const spoof = await rpc('tools/call', { name, arguments: { userId: other, organizationId: foreignOrg } });
    assert(spoof.body.error || spoof.body.result?.isError); assert.equal(hits, 1);
    assert.equal((await rpc('tools/list', {}, { token: bearer + 'forged' })).status, 401);
    // Use a separate stateless request even when the owner's session is active.
    const ownerSession = session; session = undefined;
    assert(!(await list({ token: token(other) })).some(tool => tool.name === name));
    assert(!(await list({ token: process.env.MCP_BEARER_TOKEN })).some(tool => tool.name === name));
    const deniedCall = await rpc('tools/call', { name, arguments: {} }, { token: token(other) });
    assert(deniedCall.body.error || deniedCall.body.result?.isError); assert.equal(hits, 1);
    assert.equal((await rpc('tools/list', {}, { token: token(foreign, foreignOrg) })).status, 403);
    assert(!(await list({ serverId: empty.id })).some(tool => tool.name === name));
    assert(!(await list({ token: token(owner, organizationId, { type: 'refresh' }) })).some(tool => tool.name === name));
    session = ownerSession;
    if (session) assert.equal((await rpc('tools/list', {}, { token: token(owner, organizationId, { azp: 'other-client' }) })).status, 404);
    const grant = await db.mcpConnectionGrant.create({ data: { clientId: 'fixture-client-a', userId: owner, serverIds: [empty.id] } });
    assert(!(await list()).some(tool => tool.name === name));
    await db.mcpConnectionGrant.update({ where: { id: grant.id }, data: { serverIds: [server.id] } });
    assert((await list()).some(tool => tool.name === name));
    await db.mcpConnectionGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date() } });
    assert(!(await list()).some(tool => tool.name === name));
    const revoked = await rpc('tools/call', { name, arguments: {} }); assert(revoked.body.error || revoked.body.result?.isError); assert.equal(hits, 1);
    await db.mcpConnectionGrant.update({ where: { id: grant.id }, data: { revokedAt: null } });
    // A tool edit changes the exact fingerprint; an old script cannot run.
    await db.mcpTool.update({ where: { id: tool.id }, data: { isEnabled: false } });
    assert(!(await list()).some(tool => tool.name === name));
    const changed = await rpc('tools/call', { name, arguments: {} }); assert(changed.body.error || changed.body.result?.isError); assert.equal(hits, 1);
    await db.mcpTool.update({ where: { id: tool.id }, data: { isEnabled: true } });
    // Fault injection only: lifecycle notifications fail, but invocation-time
    // reads and request reconciliation must still reject stale registrations.
    const { McpSessionManager } = load('mcp-servers/mcp-session.manager');
    const sessionManager = app.get(McpSessionManager);
    sessionManager.notifyToolsChanged = async () => { throw new Error('fixture notification unavailable'); };
    // Persisted revision update refreshes the same stable name in active sessions.
    unwrap(await store.update(principal, script.id, 1, { ...definition,
      source: 'async function main(input, api) { const d = await api.read({}); return {total: d.items.reduce((s, x) => s + x.amount, 0) * 2}; }' }));
    assert((await list()).some(tool => tool.name === name));
    const updated = await rpc('tools/call', { name, arguments: {} });
    assert.deepEqual(JSON.parse(updated.body.result.content[0].text), { total: 22 });
    assert.equal(updated.body.result._meta['codebound/revision'], 2); assert.equal(hits, 2);
    const role = await db.role.create({ data: { name: 'No MCP tools', organizationId } });
    await db.userRoleAssignment.create({ data: { userId: owner, roleId: role.id, organizationId } });
    await db.organizationMember.update({ where: { userId_organizationId: { userId: owner, organizationId } }, data: { role: 'VIEWER' } });
    assert(!(await list()).some(tool => tool.name === name));
    const roleDenied = await rpc('tools/call', { name, arguments: {} }); assert(roleDenied.body.error || roleDenied.body.result?.isError); assert.equal(hits, 2);
    await db.organizationMember.update({ where: { userId_organizationId: { userId: owner, organizationId } }, data: { role: 'ADMIN' } });
    unwrap(await store.remove(principal, script.id, 2));
    assert(!(await list()).some(tool => tool.name === name));
    const deleted = await rpc('tools/call', { name, arguments: {} }); assert(deleted.body.error || deleted.body.result?.isError); assert.equal(hits, 2);
    await db.user.update({ where: { id: owner }, data: { sessionsValidFrom: new Date(Date.now() + 1000) } });
    assert.equal((await rpc('tools/list')).status, 401);
    assert.equal(docker('ps', '-aq', '--filter', 'label=codebound.sandbox=true'), '');
    process.stdout.write(`CODEBOUND_MCP_OK:${mode}\n`);
  } finally {
    if (db) {
      await db.user.deleteMany({ where: { id: { in: users } } });
      await db.organization.deleteMany({ where: { id: { in: orgs } } });
    }
    if (tls) { tls.closeAllConnections(); await new Promise(resolve => tls.close(resolve)); }
    await app.close();
  }
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
