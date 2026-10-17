// SPDX-License-Identifier: AGPL-3.0-only
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { DeploymentService } from '../../common/deployment.service';
import { encrypt } from '../../common/crypto/encryption.util';
import { ConnectorsService } from '../../connectors/connectors.service';
import { AuthService } from '../../auth/auth.service';
import { JwtStrategy } from '../../auth/jwt.strategy';
import { RolesService } from '../../roles/roles.service';
import { LicenseGuardService } from '../../license/license-guard.service';
import { McpConnectionGrantService } from '../../mcp-servers/mcp-connection-grant.service';
import { AuditService } from '../../audit/audit.service';
import { AuthorizedConnectorGatewayService } from '../gateway/authorized-connector-gateway.service';
import { BoundReadAuthorization, fingerprintReadTool } from '../gateway/bound-read-authorization.service';
import { BoundRestExecutor } from '../gateway/bound-rest-executor.service';
import { DockerSandboxRunner } from '../sandbox/docker-sandbox-runner';
import { ScriptPersistenceService } from '../persistence/script-persistence.service';
import type { ExecutionPrincipal, Outcome, ScriptDefinition, ScriptExecutionResult } from '../contracts';
import { ScriptExecutionService } from './script-execution.service';
import { ScriptExecutionController } from './script-execution.controller';

const live = process.env.RUN_CODEBOUND_EXECUTION_LIVE === '1' ? describe : describe.skip;
const unwrap = <T>(result: Outcome<T>): T => {
  if (!result.ok) throw new Error(`Fixture failed: ${result.error.code}`);
  return result.value;
};
const docker = (...args: string[]) => execFileSync('docker', args, { windowsHide: true, encoding: 'utf8', timeout: 20_000 }).trim();

live('CODEBOUND execution: real JWT HTTP, PostgreSQL, Docker and HTTPS', () => {
  let db: PrismaClient; let persistence: ScriptPersistenceService; let execution: ScriptExecutionService;
  let audit: AuditService; let app: INestApplication; let tls: https.Server; let apiUrl: string; let connectorUrl: string;
  let owner: ExecutionPrincipal; let foreign: ExecutionPrincipal; let definition: ScriptDefinition; let toolId: string;
  let hits: string[]; let reply: string;
  const orgs: string[] = []; const users: string[] = [];
  const jwt = new JwtService({ secret: 'codebound-public-test-jwt-secret-only' });
  const encryptionKey = 'codebound-public-test-key-32-bytes';
  const canary = 'cb-fixture-credential-canary';
  const envKeys = ['SSRF_GUARD', 'SSRF_ALLOW_LOCALHOST', 'SSRF_ALLOW_PRIVATE', 'SSRF_ALLOWED_HOSTS', 'DEPLOYMENT_MODE'];
  let savedEnv: (string | undefined)[];

  beforeAll(async () => {
    if (!process.env.CODEBOUND_TEST_DATABASE_URL) throw new Error('Dedicated CODEBOUND_TEST_DATABASE_URL required');
    if (!process.env.NODE_EXTRA_CA_CERTS) throw new Error('Start Node with NODE_EXTRA_CA_CERTS pointing at the fixture certificate');
    expect(docker('info', '--format', '{{.OSType}}')).toBe('linux');
    docker('image', 'inspect', 'codebound-sandbox:mvp');
    savedEnv = envKeys.map(key => process.env[key]);
    delete process.env.SSRF_ALLOW_LOCALHOST; delete process.env.SSRF_ALLOW_PRIVATE;
    process.env.SSRF_GUARD = 'enabled'; process.env.SSRF_ALLOWED_HOSTS = 'localhost'; process.env.DEPLOYMENT_MODE = 'self-hosted';
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.CODEBOUND_TEST_DATABASE_URL }) });
    await db.$connect();
    // Real TLS verification, real guarded transport; no Agent/request/DNS mocks.
    tls = https.createServer({ key: readFileSync(join(__dirname, '../gateway/fixtures/localhost.key.pem')),
      cert: readFileSync(join(__dirname, '../gateway/fixtures/localhost.cert.pem')) }, (req, res) => {
      hits.push(req.headers.authorization ?? ''); res.setHeader('Content-Type', 'application/json'); res.end(reply);
    });
    await new Promise<void>(resolve => tls.listen(0, '127.0.0.1', resolve));
    connectorUrl = `https://localhost:${(tls.address() as AddressInfo).port}`;
    const config = new ConfigService({ ENCRYPTION_KEY: encryptionKey, JWT_SECRET: 'codebound-public-test-jwt-secret-only' });
    const license = new LicenseGuardService(db as any, undefined as any, new DeploymentService());
    const authorization = new BoundReadAuthorization(db as any, new RolesService(db as any), new McpConnectionGrantService(db as any), license);
    // Only getDecryptedAuthConfig is used; engine dependencies are not invoked.
    const connectors = new ConnectorsService(db as any, config, undefined as any, undefined as any, undefined as any, undefined as any, undefined as any);
    persistence = new ScriptPersistenceService(db as any, authorization);
    audit = new AuditService(db as any);
    execution = new ScriptExecutionService(persistence, new AuthorizedConnectorGatewayService(authorization, new BoundRestExecutor(connectors)), new DockerSandboxRunner(), audit);
    const module = await Test.createTestingModule({ controllers: [ScriptExecutionController], providers: [
      { provide: ScriptExecutionService, useValue: execution }, { provide: PrismaService, useValue: db },
      { provide: ConfigService, useValue: config }, { provide: JwtService, useValue: jwt }, AuthService, JwtStrategy,
    ] }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1'); apiUrl = await app.getUrl();
  }, 60_000);

  beforeEach(async () => {
    hits = []; reply = JSON.stringify({ items: [{ amount: 4 }, { amount: 7 }], privateDetail: 'fixture-raw-response' });
    const principal = async (): Promise<ExecutionPrincipal> => {
      const organizationId = randomUUID(); const userId = randomUUID(); orgs.push(organizationId); users.push(userId);
      await db.organization.create({ data: { id: organizationId, name: 'CODEBOUND execution fixture' } });
      await db.user.create({ data: { id: userId, email: `${userId}@example.invalid`, role: 'ADMIN', organizationId,
        memberships: { create: { organizationId, role: 'ADMIN' } } } });
      return { userId, organizationId, tokenIssuedAtMs: Math.floor(Date.now() / 1000) * 1000 - 10_000,
        tokenExpiresAtMs: Date.now() + 120_000, origin: { kind: 'dashboard' } };
    };
    owner = await principal(); foreign = await principal();
    const connector = await db.connector.create({ data: { organizationId: owner.organizationId, userId: owner.userId,
      name: 'Controlled HTTPS', type: 'REST', baseUrl: connectorUrl, authType: 'BEARER_TOKEN',
      authConfig: encrypt(JSON.stringify({ token: canary }), encryptionKey), envVars: {},
      tools: { create: { name: 'fixture_read', description: 'Read', parameters: {}, endpointMapping: { method: 'GET', path: '/items' } } } }, include: { tools: true } });
    toolId = connector.tools[0].id;
    const tool = await db.mcpTool.findFirstOrThrow({ where: { id: toolId, connector: { organizationId: owner.organizationId } }, include: { connector: true } });
    definition = { name: 'Sum amounts', description: '', source: 'async function main(input, api) { const data = await api.read({}); return {total: data.items.reduce((sum, item) => sum + item.amount, 0)}; }',
      inputSchema: {}, outputSchema: {}, binding: { connectorId: connector.id, toolId, definitionSha256: fingerprintReadTool(tool) } };
  });
  afterEach(() => { expect(docker('ps', '-aq', '--filter', 'label=codebound.sandbox=true')).toBe(''); });
  afterAll(async () => {
    await app?.close();
    await audit?.onModuleDestroy();
    if (tls) { tls.closeAllConnections(); await new Promise<void>(resolve => tls.close(() => resolve())); }
    if (db) {
      await db.user.deleteMany({ where: { id: { in: users } } });
      await db.organization.deleteMany({ where: { id: { in: orgs } } }); await db.$disconnect();
    }
    if (savedEnv) envKeys.forEach((key, i) => { if (savedEnv[i] === undefined) delete process.env[key]; else process.env[key] = savedEnv[i]; });
  });

  const token = (p = owner, extra = {}) => jwt.sign({ sub: p.userId, email: 'fixture@example.invalid', role: 'ADMIN', organizationId: p.organizationId,
    iat: Math.floor(p.tokenIssuedAtMs / 1000), exp: Math.floor(p.tokenExpiresAtMs / 1000), ...extra });
  const post = async (body: unknown, bearer = token()) => {
    const response = await fetch(`${apiUrl}/api/codebound/scripts/execute`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const saved = async (source = definition.source) => unwrap(await persistence.create(owner, { ...definition, source }));
  const execute = async (source = definition.source, signal = new AbortController().signal) => {
    const script = await saved(source);
    return unwrap(await execution.execute(owner, { scriptId: script.id, expectedRevision: 1, input: {} }, signal));
  };
  const receipt = (result: ScriptExecutionResult) => db.codeboundScriptRun.findFirstOrThrow({ where: { executionId: result.executionId, organizationId: owner.organizationId } });

  it('executes a saved script through verified JWT HTTP, real Docker and authenticated HTTPS; persists metadata only', async () => {
    const script = await saved();
    const response = await post({ scriptId: script.id, expectedRevision: 1, input: { confidential: 'fixture-sensitive-input' } });
    expect(response.status).toBe(200);
    const result = unwrap<ScriptExecutionResult>(response.body);
    expect(result).toMatchObject({ status: 'succeeded', output: { total: 11 }, metrics: { connectorCalls: 1, outputBytes: 12 } });
    expect(hits).toEqual([`Bearer ${canary}`]);
    const run = await receipt(result);
    expect(run).toMatchObject({ status: 'SUCCEEDED', revision: 1, sourceSha256: script.sourceSha256, connectorCalls: 1 });
    const logs = await db.toolInvocation.findMany({ where: { organizationId: owner.organizationId, clientInfo: `codebound/${result.executionId}` } });
    expect(logs).toHaveLength(1); expect(logs[0]).toMatchObject({ userId: owner.userId, toolId, status: 'SUCCESS', input: { executionId: result.executionId }, output: null });
    for (const value of [result, run, logs]) {
      expect(JSON.stringify(value)).not.toMatch(/cb-fixture-credential-canary|fixture-raw-response|fixture-sensitive-input/);
    }
  }, 30_000);

  it('rejects missing, forged and MCP OAuth JWTs and extra identity fields', async () => {
    const script = await saved(); const body = { scriptId: script.id, expectedRevision: 1, input: {} };
    expect((await post(body, '')).status).toBe(401);
    expect((await post(body, `${token()}forged`)).status).toBe(401);
    expect((await post(body, token(owner, { type: 'access' }))).status).toBe(401);
    expect((await post({ ...body, organizationId: foreign.organizationId })).status).toBe(400);
    expect(hits).toHaveLength(0);
  });

  it('denies another organization and revision mismatch before creating receipts', async () => {
    const script = await saved();
    expect((await post({ scriptId: script.id, expectedRevision: 1, input: {} }, token(foreign))).status).toBe(404);
    expect((await post({ scriptId: script.id, expectedRevision: 2, input: {} })).status).toBe(409);
    expect(await db.codeboundScriptRun.count({ where: { organizationId: owner.organizationId } })).toBe(0);
    expect(hits).toHaveLength(0);
  });

  it('finalizes a receipt when the bound tool is disabled after saving', async () => {
    const script = await saved();
    await db.mcpTool.update({ where: { id: toolId }, data: { isEnabled: false } });
    const result = unwrap(await execution.execute(owner, { scriptId: script.id, expectedRevision: 1, input: {} }, new AbortController().signal));
    expect(result).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect((await receipt(result)).status).toBe('FAILED'); expect(hits).toHaveLength(0);
  });

  it('honors a live restrictive role instead of treating [] as unrestricted', async () => {
    const script = await saved();
    await db.organizationMember.update({ where: { userId_organizationId: { userId: owner.userId, organizationId: owner.organizationId } }, data: { role: 'VIEWER' } });
    const role = await db.role.create({ data: { name: 'No tool access', organizationId: owner.organizationId } });
    await db.userRoleAssignment.create({ data: { userId: owner.userId, roleId: role.id, organizationId: owner.organizationId } });
    expect(await new RolesService(db as any).getAllowedToolIds(owner.userId, owner.organizationId)).toEqual([]);
    const result = unwrap(await execution.execute(owner, { scriptId: script.id, expectedRevision: 1, input: {} }, new AbortController().signal));
    expect(result).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect((await receipt(result)).status).toBe('FAILED'); expect(hits).toHaveLength(0);
  });

  it('rechecks membership on api.read after session open and still finalizes after revocation', async () => {
    // A delay occurs inside the real container, not in a mocked gateway.
    const script = await saved('async function main(input, api) { await new Promise(r => setTimeout(r, 1500)); return await api.read({}); }');
    const run = execution.execute(owner, { scriptId: script.id, expectedRevision: 1, input: {} }, new AbortController().signal);
    // Wait until the isolated container exists; open() necessarily preceded it.
    const until = Date.now() + 8000;
    while (!docker('ps', '-q', '--filter', 'label=codebound.sandbox=true')) {
      if (Date.now() > until) throw new Error('Container did not start');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await db.organizationMember.update({ where: { userId_organizationId: { userId: owner.userId, organizationId: owner.organizationId } }, data: { deactivatedAt: new Date() } });
    const result = unwrap(await run);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect((await receipt(result)).status).toBe('FAILED'); expect(hits).toHaveLength(0);
    expect(await persistence.getRun(owner, result.executionId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  }, 30_000);

  it('rejects a second connector call and keeps one HTTP dispatch', async () => {
    const result = await execute('async function main(input, api) { await api.read({}); return await api.read({}); }');
    expect(result).toMatchObject({ status: 'failed', error: { code: 'RESOURCE_LIMIT', limit: 'connectorCalls' } });
    expect(hits).toHaveLength(1); expect((await receipt(result)).status).toBe('FAILED');
  }, 30_000);

  it('bounds connector responses and output without storing their contents', async () => {
    reply = JSON.stringify({ text: 'x'.repeat(600 * 1024) });
    const result = await execute();
    expect(result).toMatchObject({ status: 'failed', error: { code: 'RESOURCE_LIMIT', limit: 'connectorResponseBytes' } });
    expect((await receipt(result)).connectorResponseBytes).toBe(0);
    const output = await execute('async function main(input, api) { return "x".repeat(17000); }');
    expect(output).toMatchObject({ status: 'failed', error: { code: 'RESOURCE_LIMIT', limit: 'outputBytes' } });
  }, 40_000);

  it('finalizes timeout and removes the CPU-bound container', async () => {
    const result = await execute('async function main(input, api) { while (true) {} }');
    expect(result).toMatchObject({ status: 'failed', error: { code: 'RESOURCE_LIMIT', limit: 'wallTime' } });
    expect((await receipt(result)).status).toBe('FAILED');
  }, 35_000);

  it('cancels an active execution, finalizes the receipt and removes the container', async () => {
    const controller = new AbortController();
    const script = await saved('async function main(input, api) { while (true) {} }');
    const operation = execution.execute(owner, { scriptId: script.id, expectedRevision: 1, input: {} }, controller.signal);
    const until = Date.now() + 8000;
    while (!docker('ps', '-q', '--filter', 'label=codebound.sandbox=true')) {
      if (Date.now() > until) throw new Error('Container did not start');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    controller.abort(); const result = unwrap(await operation);
    expect(result).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect((await receipt(result)).status).toBe('CANCELLED');
  }, 30_000);

  it('can recover stale receipts only for the authenticated owner without replay', async () => {
    const script = await saved(); const id = randomUUID();
    // SQL fixture insert is needed because startedAt is correctly immutable.
    await db.codeboundScriptRun.create({ data: { executionId: id, organizationId: owner.organizationId,
      ownerUserId: owner.userId, callerUserId: owner.userId, originalScriptId: script.id, scriptId: script.id,
      scriptOrganizationId: owner.organizationId, scriptOwnerUserId: owner.userId, revision: 1, sourceSha256: script.sourceSha256,
      startedAt: new Date(Date.now() - 360_000), createdAt: new Date(Date.now() - 360_000) } });
    unwrap(await persistence.recoverInterruptedRuns(foreign));
    expect(unwrap(await persistence.getRun(owner, id)).status).toBe('RUNNING');
    unwrap(await persistence.recoverInterruptedRuns(owner));
    expect(unwrap(await persistence.getRun(owner, id))).toMatchObject({ status: 'CANCELLED', errorCode: 'CANCELLED', connectorCalls: 0 });
    expect(hits).toHaveLength(0);
  });

  it('binds trusted finalization to the captured tenant and allows only one terminal transition after revocation', async () => {
    const script = await saved(); const executionId = randomUUID(); const mutable = structuredClone(owner);
    const capability = unwrap(await persistence.beginExecution(mutable, script.id, 1, executionId));
    mutable.organizationId = foreign.organizationId; mutable.userId = foreign.userId;
    const metrics = { wallTimeMs: 1, connectorCalls: 0, connectorResponseBytes: 0, outputBytes: 0 };
    expect(await capability.finalize({ status: 'succeeded', metrics, organizationId: foreign.organizationId } as any))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await db.organizationMember.update({ where: { userId_organizationId: { userId: owner.userId, organizationId: owner.organizationId } }, data: { deactivatedAt: new Date() } });
    const attempts = await Promise.all([
      capability.finalize({ status: 'cancelled', metrics, error: { code: 'CANCELLED', message: 'Execution cancelled' } }),
      capability.finalize({ status: 'failed', metrics, error: { code: 'INTERNAL_ERROR', message: 'Execution failed' } }),
    ]);
    expect(attempts.filter(value => value.ok)).toHaveLength(1);
    expect(attempts.find(value => !value.ok)).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    const run = await db.codeboundScriptRun.findFirstOrThrow({ where: { executionId, organizationId: owner.organizationId } });
    expect(run).toMatchObject({ organizationId: owner.organizationId, ownerUserId: owner.userId, callerUserId: owner.userId });
    expect(run.status).not.toBe('RUNNING');
    expect(await db.codeboundScriptRun.count({ where: { executionId, organizationId: foreign.organizationId } })).toBe(0);
    expect(hits).toHaveLength(0);
  });

  it('finalizes cancellation on HTTP client disconnect', async () => {
    const script = await saved('async function main(input, api) { while (true) {} }');
    const controller = new AbortController();
    // Consume rejection immediately; the socket is deliberately aborted below.
    const request = fetch(`${apiUrl}/api/codebound/scripts/execute`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ scriptId: script.id, expectedRevision: 1, input: {} }), signal: controller.signal }).catch(() => null);
    const until = Date.now() + 8000;
    while (!docker('ps', '-q', '--filter', 'label=codebound.sandbox=true')) {
      if (Date.now() > until) throw new Error('Container did not start');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    controller.abort(); await request;
    const finishedBy = Date.now() + 12_000;
    for (;;) {
      const run = await db.codeboundScriptRun.findFirstOrThrow({ where: { organizationId: owner.organizationId, originalScriptId: script.id } });
      if (run.status !== 'RUNNING') { expect(run.status).toBe('CANCELLED'); break; }
      if (Date.now() > finishedBy) throw new Error('Disconnected execution not finalized');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }, 30_000);
});
