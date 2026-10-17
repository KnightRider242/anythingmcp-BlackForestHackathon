// SPDX-License-Identifier: AGPL-3.0-only
// Dedicated DB only. Actual AppModule/providers; controlled fixture changes only the local catalog's base URL.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const https = require('node:https');
const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const built = existsSync(resolve('dist/src/app.module.js')) ? 'dist/src' : 'dist';
const load = path => require(resolve(built, path));

async function main() {
  assert(process.env.CODEBOUND_TEST_DATABASE_URL && process.env.DATABASE_URL === process.env.CODEBOUND_TEST_DATABASE_URL);
  assert.equal(process.env.DEPLOYMENT_MODE, 'self-hosted'); assert.equal(process.env.MCP_AUTH_MODE, 'legacy');
  process.env.MCP_BEARER_TOKEN = 'cb-public-marketplace-static-fixture-token';
  process.env.MCP_STATEFUL_SESSIONS = 'false'; process.env.MCP_STREAMABLE_JSON_RESPONSE = 'true'; process.env.KG_MCP_TOOL = 'off';
  process.env.SSRF_GUARD = 'enabled'; delete process.env.SSRF_ALLOW_LOCALHOST; delete process.env.SSRF_ALLOW_PRIVATE;
  const publicLive = process.env.RUN_CODEBOUND_MARKETPLACE_PUBLIC === '1';
  const { NestFactory } = require('@nestjs/core'); const { ValidationPipe } = require('@nestjs/common');
  const { JwtService } = require('@nestjs/jwt');
  const { AppModule } = load('app.module'); const { PrismaService } = load('common/prisma.service');
  const { getAdapter } = load('adapters/catalog');
  const { fingerprintReadTool } = load('codebound/gateway/bound-read-authorization.service');
  const { scriptToolName } = load('codebound/mcp/codebound-mcp-tools.service');
  const catalog = getAdapter('hackernews'); const originalUrl = catalog.connector.baseUrl;
  const originalTool = catalog.codeboundScripts[0].toolName;
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  const users = []; const orgs = []; let db; let tls; let hits = 0;
  try {
    if (!publicLive) {
      process.env.SSRF_ALLOWED_HOSTS = 'localhost';
      tls = https.createServer({ key: readFileSync(resolve('src/codebound/gateway/fixtures/localhost.key.pem')),
        cert: readFileSync(resolve('src/codebound/gateway/fixtures/localhost.cert.pem')) }, (req, res) => {
        hits++; assert.equal(req.method, 'GET');
        assert.equal(req.headers.authorization, undefined);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Array.from({ length: 500 }, (_, i) => 1001 + i)));
      });
      await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
      catalog.connector.baseUrl = `https://localhost:${tls.address().port}/v0`;
    }
    app.use(require('cookie-parser')());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl(); db = app.get(PrismaService);
    const org = async () => { const id = randomUUID(); orgs.push(id); await db.organization.create({ data: { id, name: 'Marketplace fixture' } }); return id; };
    const organizationId = await org(); const foreignOrg = await org();
    const user = async organizationId => {
      const id = randomUUID(); users.push(id); await db.user.create({ data: { id, organizationId, email: `${id}@example.invalid`, role: 'ADMIN',
        memberships: { create: { organizationId, role: 'ADMIN' } } } }); return id;
    };
    const owner = await user(organizationId); const other = await user(organizationId); const foreign = await user(foreignOrg);
    await db.mcpServerConfig.create({ data: { userId: owner, organizationId, name: 'Marketplace demo', slug: randomUUID() } });
    const jwt = app.get(JwtService);
    const token = sub => jwt.sign({ sub, tokenUse: 'dashboard' }, { expiresIn: 300 });
    const request = async (path, body, sub = owner, method = 'POST') => {
      const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(sub)}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    const install = (body = {}, sub = owner) => request('/api/adapters/hackernews/import', body, sub);
    const count = () => db.connector.count({ where: { organizationId, userId: owner } });
    // Invalid local template fails before insertion; HTTP-supplied source/templates are never used.
    catalog.codeboundScripts[0].toolName = 'missing';
    assert.equal((await install()).status, 400); assert.equal(await count(), 0);
    catalog.codeboundScripts[0].toolName = originalTool;
    // A duplicate unbound catalog tool forces a real createMany constraint failure AFTER connector creation.
    // The referenced top-stories tool is still unique, so template validation does not short-circuit this path.
    catalog.tools.push(catalog.tools[1]);
    try {
      const failed = await install({ credentials: { FIXTURE_SECRET: 'private-install-canary' } });
      assert.equal(failed.status, 500);
      assert(!JSON.stringify(failed.body).match(/private-install-canary|createMany|INSERT INTO/));
      assert.equal(await count(), 0);
      assert.equal(await db.codeboundScript.count({ where: { organizationId, ownerUserId: owner } }), 0);
    } finally { catalog.tools.pop(); }
    // Persistence rejects a known connector variable pasted in source. This fails AFTER tool creation and rolls back everything.
    assert.equal((await install({ credentials: { FIXTURE_SECRET: 'async function' } })).status, 400);
    assert.equal(await count(), 0);
    assert.equal(await db.codeboundScript.count({ where: { organizationId, ownerUserId: owner } }), 0);
    const [installed, retry] = await Promise.all([install({ codeboundScripts: [{ source: 'untrusted ignored' }] }), install()]);
    assert.equal(installed.status, 201); assert.equal(retry.status, 201);
    assert.equal(installed.body.connectorId, retry.body.connectorId); assert.equal(await count(), 1);
    const connectorId = installed.body.connectorId;
    const script = await db.codeboundScript.findFirstOrThrow({ where: { organizationId, ownerUserId: owner, connectorId } });
    const tool = await db.mcpTool.findFirstOrThrow({ where: { id: script.toolId, connectorId, connector: { organizationId, userId: owner } }, include: { connector: true } });
    assert.equal(tool.name, originalTool); assert.equal(script.definitionSha256, fingerprintReadTool(tool));
    assert.equal(script.source, catalog.codeboundScripts[0].source); assert.equal(script.revision, 1); assert.equal(hits, 0);
    const list = await request('/api/codebound/scripts', undefined, owner, 'GET');
    assert(list.body.value.some(s => s.id === script.id));
    for (const sub of [other, foreign]) {
      assert.equal((await request('/api/codebound/scripts', undefined, sub, 'GET')).body.value.length, 0);
      assert.equal((await request(`/api/codebound/scripts/${script.id}`, undefined, sub, 'GET')).status, 404);
      assert.equal((await request('/api/codebound/scripts/execute', { scriptId: script.id, expectedRevision: 1, input: {} }, sub)).status, 404);
    }
    const result = await request('/api/codebound/scripts/execute', { scriptId: script.id, expectedRevision: 1, input: {} });
    assert.equal(result.status, 200); assert.equal(result.body.value.status, 'succeeded', JSON.stringify(result.body));
    const output = result.body.value.output;
    if (!publicLive) assert.deepEqual(output, { returnedCount: 500, topIds: Array.from({ length: 10 }, (_, i) => 1001 + i) });
    else { assert(output.returnedCount >= output.topIds.length); assert(output.topIds.length > 0 && output.topIds.length <= 10); }
    const serverId = installed.body.attachedToServer?.id ?? retry.body.attachedToServer?.id; assert(serverId);
    const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
    const client = new Client({ name: 'Marketplace live fixture', version: '1.0' });
    const mcpToken = sub => jwt.sign({ sub, organizationId, type: 'access', azp: 'marketplace-fixture' }, { expiresIn: 300 });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${serverId}`), { authProvider: { token: async () => mcpToken(owner) } }));
      const name = scriptToolName(script.id);
      const tools = (await client.listTools()).tools;
      assert(tools.some(t => t.name === name)); assert(!JSON.stringify(tools.find(t => t.name === name)).includes(script.source));
      const called = await client.callTool({ name, arguments: {} }); assert(!called.isError, JSON.stringify(called));
      const mcpOutput = JSON.parse(called.content[0].text);
      if (!publicLive) assert.deepEqual(mcpOutput, output); else assert(mcpOutput.topIds.length <= 10);
      const executionId = called._meta['codebound/executionId'];
      const run = await db.codeboundScriptRun.findFirstOrThrow({ where: { executionId, organizationId, ownerUserId: owner } });
      assert.equal(run.status, 'SUCCEEDED');
      assert.equal(await db.toolInvocation.count({ where: { organizationId, userId: owner, clientInfo: `codebound/${executionId}` } }), 1);
    } finally { await client.close(); }
    for (const sub of [other, foreign]) {
      const denied = new Client({ name: 'Denied marketplace fixture', version: '1.0' });
      try {
        await denied.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${serverId}`), { authProvider: { token: async () => mcpToken(sub) } }));
        assert(!(await denied.listTools()).tools.some(t => t.name === scriptToolName(script.id)));
        const result = await denied.callTool({ name: scriptToolName(script.id), arguments: {} }); assert(result.isError);
      } catch (error) {
        // Never swallow assertions, network failures or internal server errors as an authorization success.
        if (![401, 403, -32601, -32602].includes(error.code)) throw error;
      }
      finally { await denied.close(); }
    }
    // Retrying does not duplicate or overwrite an owner's edits. Deleting the script is respected.
    const definition = { name: 'Owner edit', description: script.description, source: script.source, inputSchema: script.inputSchema, outputSchema: script.outputSchema,
      binding: { connectorId, toolId: tool.id, definitionSha256: script.definitionSha256 } };
    assert.equal((await request(`/api/codebound/scripts/${script.id}`, { expectedRevision: 1, definition }, owner, 'PUT')).status, 200);
    assert.equal((await install()).body.connectorId, connectorId);
    assert.equal((await request(`/api/codebound/scripts/${script.id}`, undefined, owner, 'GET')).body.value.name, 'Owner edit');
    assert.equal((await request(`/api/codebound/scripts/${script.id}`, { expectedRevision: 2 }, owner, 'DELETE')).status, 200);
    assert.equal((await install()).body.connectorId, connectorId);
    assert.equal(await db.codeboundScript.count({ where: { organizationId, ownerUserId: owner } }), 0);
    // Another owner gets an independent connector and binding, never the previous owner's installation.
    const ownInstall = await install({}, other); assert.equal(ownInstall.status, 201); assert.notEqual(ownInstall.body.connectorId, connectorId);
    assert.equal(await db.codeboundScript.count({ where: { organizationId, ownerUserId: other, connectorId: ownInstall.body.connectorId } }), 1);
    if (!publicLive) {
      const ordinary = getAdapter('openplz'); const url = ordinary.connector.baseUrl;
      try {
        ordinary.connector.baseUrl = catalog.connector.baseUrl;
        const plain = await request('/api/adapters/openplz/import', {});
        assert.equal(plain.status, 201); assert(plain.body.toolsCreated > 0); assert.equal(plain.body.scriptsInstalled, undefined);
        assert.equal(await db.codeboundScript.count({ where: { organizationId, connectorId: plain.body.connectorId } }), 0);
      } finally { ordinary.connector.baseUrl = url; }
    }
    assert.equal(execFileSync('docker', ['ps', '-aq', '--filter', 'label=codebound.sandbox=true'], { encoding: 'utf8', windowsHide: true }).trim(), '');
    process.stdout.write(`CODEBOUND_MARKETPLACE_OK:${publicLive ? 'public' : 'controlled'}\n`);
  } finally {
    catalog.connector.baseUrl = originalUrl; catalog.codeboundScripts[0].toolName = originalTool;
    if (db) { await db.user.deleteMany({ where: { id: { in: users } } }); await db.organization.deleteMany({ where: { id: { in: orgs } } }); }
    if (tls) { tls.closeAllConnections(); await new Promise(resolve => tls.close(resolve)); }
    await app.close();
  }
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
