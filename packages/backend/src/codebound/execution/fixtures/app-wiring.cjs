// SPDX-License-Identifier: AGPL-3.0-only
// Fixture-only: run through app-wiring.integration.spec.ts after npm run build.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { resolve } = require('node:path');
const { existsSync } = require('node:fs');
const built = existsSync(resolve(process.cwd(), 'dist/src/app.module.js')) ? 'dist/src' : 'dist';
const load = path => require(resolve(process.cwd(), built, path));

async function main() {
  assert(process.env.CODEBOUND_TEST_DATABASE_URL && process.env.DATABASE_URL === process.env.CODEBOUND_TEST_DATABASE_URL,
    'DATABASE_URL must match the dedicated CODEBOUND_TEST_DATABASE_URL');
  assert.equal(process.env.DEPLOYMENT_MODE, 'self-hosted');
  assert.equal(process.env.MCP_AUTH_MODE, 'none');
  const { NestFactory } = require('@nestjs/core');
  const { ValidationPipe } = require('@nestjs/common');
  const { JwtService } = require('@nestjs/jwt');
  const { AppModule } = load('app.module');
  const { PrismaService } = load('common/prisma.service');
  const { ScriptExecutionService } = load('codebound/execution/script-execution.service');
  const { ScriptPersistenceService } = load('codebound/persistence/script-persistence.service');
  const { AuthorizedConnectorGatewayService } = load('codebound/gateway/authorized-connector-gateway.service');
  const { DockerSandboxRunner } = load('codebound/sandbox/docker-sandbox-runner');
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  let db; let userId; let organizationId;
  try {
    app.use(require('cookie-parser')());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    db = app.get(PrismaService);
    organizationId = randomUUID(); userId = randomUUID();
    await db.organization.create({ data: { id: organizationId, name: 'CODEBOUND application smoke' } });
    await db.user.create({ data: { id: userId, email: `${userId}@example.invalid`, role: 'ADMIN', organizationId,
      memberships: { create: { organizationId, role: 'ADMIN' } } } });
    for (const provider of [ScriptExecutionService, ScriptPersistenceService, AuthorizedConnectorGatewayService, DockerSandboxRunner]) {
      assert(app.get(provider) instanceof provider);
    }
    const post = (body, token) => fetch(`${base}/api/codebound/scripts/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const body = { scriptId: 'missing-script', expectedRevision: 1, input: {} };
    assert.equal((await post(body)).status, 401);
    // A stale/foreign organization claim must not override live JwtStrategy scope.
    const token = app.get(JwtService).sign({ sub: userId, email: `${userId}@example.invalid`, role: 'ADMIN', organizationId: 'untrusted-claim-org',
      tokenUse: 'dashboard' });
    const response = await post(body, token);
    assert.equal(response.status, 404);
    const result = await response.json();
    assert.equal(result.ok, false); assert.equal(result.error.code, 'NOT_FOUND');
    assert.equal((await post({ ...body, organizationId: 'attacker-org' }, token)).status, 400);

    // Real management routes, real JWT strategy, real authorization and PostgreSQL.
    const call = async (path, method = 'GET', body, auth = token) => {
      const response = await fetch(`${base}/api/codebound/${path}`, { method,
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await call('scripts', 'GET', undefined, '')).status, 401);
    const connector = await db.connector.create({ data: { name: 'Management fixture', organizationId, userId,
      type: 'REST', baseUrl: 'https://example.invalid', authType: 'NONE',
      tools: { create: [{ name: 'fixture_get', description: 'Read', parameters: {}, endpointMapping: { method: 'GET', path: '/' } },
        { name: 'fixture_post', description: 'Write', parameters: {}, endpointMapping: { method: 'POST', path: '/' } }] } }, include: { tools: true } });
    const bindings = await call('bindings');
    assert.equal(bindings.status, 200); assert.equal(bindings.body.value.items.length, 1);
    assert.equal(bindings.body.value.items[0].toolName, 'fixture_get');
    assert(!JSON.stringify(bindings.body).includes('authConfig'));
    assert(!JSON.stringify(bindings.body).includes('example.invalid'));
    const definition = { name: 'Example', description: '', source: 'async function main(input, api) { return {}; }',
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, binding: bindings.body.value.items[0].binding };
    assert.equal((await call('scripts', 'POST', { definition, userId: 'forged' })).status, 400);
    assert.equal((await call('scripts', 'POST', { definition: { ...definition, extra: true } })).status, 400);
    assert.equal((await call('scripts', 'POST', { definition: { ...definition,
      binding: { ...definition.binding, definitionSha256: '0'.repeat(64) } } })).status, 403);
    const created = await call('scripts', 'POST', { definition });
    assert.equal(created.status, 201); const script = created.body.value;
    assert.equal(script.organizationId, organizationId); assert.equal(script.ownerUserId, userId); assert.equal(script.revision, 1);
    assert.equal((await call(`scripts/${script.id}`)).body.value.source, definition.source);
    assert.equal((await call('scripts')).body.value.length, 1);
    assert.equal((await call('scripts?organizationId=forged')).status, 400);
    const changed = await call(`scripts/${script.id}`, 'PUT', { expectedRevision: 1, definition: { ...definition, name: 'Updated' } });
    assert.equal(changed.status, 200); assert.equal(changed.body.value.revision, 2);
    assert.equal((await call(`scripts/${script.id}`, 'PUT', { expectedRevision: 1, definition })).status, 409);
    assert.equal((await call(`scripts/${script.id}`, 'DELETE', { expectedRevision: 1 })).status, 409);
    assert.equal((await call(`scripts/${script.id}`, 'DELETE', {})).status, 400);
    // A second user in the same organization has no ownership authority.
    const otherId = randomUUID();
    await db.user.create({ data: { id: otherId, email: `${otherId}@example.invalid`, organizationId,
      memberships: { create: { organizationId, role: 'ADMIN' } } } });
    try {
      const otherToken = app.get(JwtService).sign({ sub: otherId, tokenUse: 'dashboard' });
      assert.equal((await call('scripts', 'GET', undefined, otherToken)).body.value.length, 0);
      assert.equal((await call('bindings', 'GET', undefined, otherToken)).body.value.items.length, 0);
      for (const [method, payload] of [['GET', undefined], ['PUT', { expectedRevision: 2, definition }], ['DELETE', { expectedRevision: 2 }]]) {
        const denied = await call(`scripts/${script.id}`, method, payload, otherToken);
        assert([403, 404].includes(denied.status));
      }
      assert.equal((await call('scripts', 'POST', { definition }, otherToken)).status, 403);
      // Move active organization while retaining the original membership: live JWT scope must win.
      const otherOrg = await db.organization.create({ data: { name: 'Foreign management fixture' } });
      try {
        await db.organizationMember.create({ data: { userId, organizationId: otherOrg.id, role: 'ADMIN' } });
        await db.user.update({ where: { id: userId }, data: { organizationId: otherOrg.id } });
        assert.equal((await call('scripts')).body.value.length, 0);
        assert.equal((await call(`scripts/${script.id}`)).status, 404);
        assert.equal((await call(`scripts/${script.id}`, 'PUT', { expectedRevision: 2, definition })).status, 403);
        assert.equal((await call('bindings')).body.value.items.length, 0);
        assert.equal((await call(`scripts/${script.id}`, 'DELETE', { expectedRevision: 2 })).status, 404);
        assert.equal((await call('scripts', 'POST', { definition })).status, 403);
      } finally {
        await db.user.update({ where: { id: userId }, data: { organizationId } });
        await db.organization.delete({ where: { id: otherOrg.id } });
      }
    } finally { await db.user.delete({ where: { id: otherId } }); }
    await db.mcpTool.update({ where: { id: definition.binding.toolId }, data: { isEnabled: false } });
    assert.equal((await call('bindings')).body.value.items.length, 0);
    assert.equal((await call(`scripts/${script.id}`, 'PUT', { expectedRevision: 2, definition })).status, 403);
    assert.equal((await call(`scripts/${script.id}`, 'DELETE', { expectedRevision: 2 })).status, 200);
    assert.equal((await call(`scripts/${script.id}`)).status, 404);
    process.stdout.write('CODEBOUND_MANAGEMENT_SMOKE_OK\n');
  } finally {
    if (db && userId) await db.user.deleteMany({ where: { id: userId } });
    if (db && organizationId) await db.organization.deleteMany({ where: { id: organizationId } });
    await app.close();
  }
  process.stdout.write('CODEBOUND_APP_SMOKE_OK\n');
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
