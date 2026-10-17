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
  } finally {
    if (db && userId) await db.user.deleteMany({ where: { id: userId } });
    if (db && organizationId) await db.organization.deleteMany({ where: { id: organizationId } });
    await app.close();
  }
  process.stdout.write('CODEBOUND_APP_SMOKE_OK\n');
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
