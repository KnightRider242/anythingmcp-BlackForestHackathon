// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { RolesService } from '../../roles/roles.service';
import { McpConnectionGrantService } from '../../mcp-servers/mcp-connection-grant.service';
import { BoundReadAuthorization, fingerprintReadTool } from '../gateway/bound-read-authorization.service';
import { ScriptPersistenceService } from './script-persistence.service';
import type { ExecutionPrincipal, Outcome, ScriptDefinition } from '../contracts';

// Only a disposable, fully migrated PostgreSQL database. Never reads DATABASE_URL.
const url = process.env.CODEBOUND_TEST_DATABASE_URL;
const live = url ? describe : describe.skip;
const unwrap = <T>(result: Outcome<T>): T => {
  if (!result.ok) throw new Error(`Fixture failed: ${result.error.code}`);
  return result.value;
};
const metrics = { wallTimeMs: 25, connectorCalls: 1, connectorResponseBytes: 100, outputBytes: 10 };

live('CODEBOUND persistence (real PostgreSQL and Prisma)', () => {
  let db: PrismaClient; let service: ScriptPersistenceService;
  let owner: ExecutionPrincipal; let other: ExecutionPrincipal; let foreign: ExecutionPrincipal;
  let definition: ScriptDefinition; let connectorId: string; let toolId: string;
  const orgs: string[] = []; const users: string[] = [];

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const authorization = new BoundReadAuthorization(db as any, new RolesService(db as any),
      new McpConnectionGrantService(db as any), { checkLicenseActive: async () => {} } as any);
    service = new ScriptPersistenceService(db as any, authorization);
    await db.$connect();
  });
  beforeEach(async () => {
    const orgA = randomUUID(); const orgB = randomUUID(); orgs.push(orgA, orgB);
    await db.organization.createMany({ data: [{ id: orgA, name: 'Codebound test A' }, { id: orgB, name: 'Codebound test B' }] });
    const principal = async (organizationId: string): Promise<ExecutionPrincipal> => {
      const userId = randomUUID(); users.push(userId);
      await db.user.create({ data: { id: userId, email: `${userId}@example.invalid`, organizationId,
        memberships: { create: { organizationId, role: 'ADMIN' } } } });
      return { userId, organizationId, tokenIssuedAtMs: Date.now() - 10_000, tokenExpiresAtMs: Date.now() + 60_000, origin: { kind: 'dashboard' } };
    };
    owner = await principal(orgA); other = await principal(orgA); foreign = await principal(orgB);
    // Same owner belongs to both organizations: owner equality alone must not suffice.
    await db.organizationMember.create({ data: { userId: owner.userId, organizationId: orgB, role: 'ADMIN' } });
    const connector = await db.connector.create({ data: { name: 'Fixture', organizationId: orgA, userId: owner.userId,
      type: 'REST', baseUrl: 'https://api.example.invalid', authType: 'NONE', envVars: {},
      tools: { create: { name: 'fixture_read', description: 'Read fixture', parameters: {}, endpointMapping: { method: 'GET', path: '/items' } } } }, include: { tools: true } });
    connectorId = connector.id; toolId = connector.tools[0].id;
    const tool = await db.mcpTool.findFirstOrThrow({ where: { id: toolId, connector: { organizationId: orgA } }, include: { connector: true } });
    definition = { name: 'Count items', description: '', source: 'async function main(input, api) { return {count: 1}; }',
      inputSchema: {}, outputSchema: {}, binding: { connectorId, toolId, definitionSha256: fingerprintReadTool(tool) } };
  });
  afterAll(async () => {
    if (!db) return;
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  it('has the migration applied, including PostgreSQL checks and immutable receipt trigger', async () => {
    const applied = await db.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM _prisma_migrations WHERE migration_name = '20261017140000_codebound_persistence' AND finished_at IS NOT NULL`;
    expect(applied).toHaveLength(1);
    const triggers = await db.$queryRaw<{ tgname: string }[]>`SELECT tgname FROM pg_trigger WHERE tgname = 'codebound_run_receipt_guard'`;
    expect(triggers).toHaveLength(1);
  });

  it('creates, retrieves, lists and returns immutable snapshots with revision 1', async () => {
    const saved = unwrap(await service.create(owner, definition));
    expect(saved.revision).toBe(1);
    expect(unwrap(await service.get(owner, saved.id))).toEqual(saved);
    expect(unwrap(await service.list(owner))).toEqual([saved]);
    expect(Object.isFrozen(saved)).toBe(true); expect(Object.isFrozen(saved.binding)).toBe(true);
    expect(() => { (saved.binding as any).toolId = 'changed'; }).toThrow();
    definition.name = 'Mutable request'; expect(saved.name).toBe('Count items');
  });

  it.each(['same-owner-other-org', 'other-owner-same-org', 'foreign-owner'])('isolates %s for read, list, update and delete', async mode => {
    const saved = unwrap(await service.create(owner, definition));
    const caller = mode === 'same-owner-other-org' ? { ...owner, organizationId: foreign.organizationId } : mode === 'other-owner-same-org' ? other : foreign;
    expect(await service.get(caller, saved.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(unwrap(await service.list(caller))).toEqual([]);
    expect(await service.update(caller, saved.id, 1, definition)).toMatchObject({ ok: false });
    expect(await service.remove(caller, saved.id, 1)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it.each(['expired', 'revoked', 'deactivated'])('denies %s authentication', async reason => {
    if (reason === 'expired') owner.tokenExpiresAtMs = Date.now() - 1;
    if (reason === 'revoked') await db.user.update({ where: { id: owner.userId }, data: { sessionsValidFrom: new Date() } });
    if (reason === 'deactivated') await db.organizationMember.update({ where: { userId_organizationId: { userId: owner.userId, organizationId: owner.organizationId } }, data: { deactivatedAt: new Date() } });
    expect(await service.create(owner, definition)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it.each(['fingerprint', 'write', 'disabled', 'foreign-connector'])('rejects invalid %s binding', async reason => {
    if (reason === 'fingerprint') definition.binding.definitionSha256 = '0'.repeat(64);
    if (reason === 'write') await db.mcpTool.update({ where: { id: toolId }, data: { endpointMapping: { method: 'POST', path: '/items' } } });
    if (reason === 'disabled') await db.mcpTool.update({ where: { id: toolId }, data: { isEnabled: false } });
    if (reason === 'foreign-connector') definition.binding.connectorId = randomUUID();
    expect(await service.create(owner, definition)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('performs an atomic compare-and-swap for concurrent updates', async () => {
    const saved = unwrap(await service.create(owner, definition));
    const results = await Promise.all(['First', 'Second'].map(name => service.update(owner, saved.id, 1, { ...definition, name })));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    expect(unwrap(await service.get(owner, saved.id)).revision).toBe(2);
    expect(saved.revision).toBe(1); expect(saved.name).toBe('Count items');
  });

  it('rejects stale delete and deletes the matching revision', async () => {
    const saved = unwrap(await service.create(owner, definition));
    unwrap(await service.update(owner, saved.id, 1, definition));
    expect(await service.remove(owner, saved.id, 1)).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    unwrap(await service.remove(owner, saved.id, 2));
    expect(await service.get(owner, saved.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('retains a sanitized immutable receipt after script deletion, without source or output', async () => {
    const saved = unwrap(await service.create(owner, definition)); const executionId = randomUUID();
    expect(unwrap(await service.beginRun(owner, saved.id, 1, executionId))).toEqual(saved);
    unwrap(await service.finishRun(owner, executionId, { status: 'failed', metrics,
      error: { code: 'CONNECTOR_ERROR', message: 'credential-canary-do-not-store' } }));
    unwrap(await service.remove(owner, saved.id, 1));
    const receipt = unwrap(await service.getRun(owner, executionId));
    expect(receipt).toMatchObject({ scriptId: null, scriptOrganizationId: null, scriptOwnerUserId: null,
      originalScriptId: saved.id, revision: 1, sourceSha256: saved.sourceSha256, status: 'FAILED', errorMessage: 'Connector operation failed' });
    expect(JSON.stringify(receipt)).not.toContain('credential-canary');
    expect(receipt).not.toHaveProperty('source'); expect(receipt).not.toHaveProperty('output');
    expect(await service.getRun(other, executionId)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await service.finishRun(owner, executionId, { status: 'succeeded', metrics })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
  });

  it('keeps the original executed revision after later script updates', async () => {
    const saved = unwrap(await service.create(owner, definition)); const executionId = randomUUID();
    const snapshot = unwrap(await service.beginRun(owner, saved.id, 1, executionId));
    unwrap(await service.update(owner, saved.id, 1, { ...definition, source: 'async function main(input, api) { return 2; }' }));
    expect(unwrap(await service.getRun(owner, executionId))).toMatchObject({ revision: 1, sourceSha256: snapshot.sourceSha256 });
    expect(await service.beginRun(owner, saved.id, 1, randomUUID())).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(await service.beginRun(owner, saved.id, 2, executionId)).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
  });

  it('enforces tenant/connector/tool references and content checks in the database', async () => {
    const saved = unwrap(await service.create(owner, definition));
    const scope = { id: saved.id, organizationId: owner.organizationId };
    for (const data of [{ organizationId: foreign.organizationId }, { ownerUserId: other.userId },
      { toolId: 'missing-tool' }, { revision: 0 }, { sourceSha256: '0'.repeat(64) },
      { inputSchema: [] }, { source: 'x'.repeat(32769) }]) {
      await expect(db.codeboundScript.updateMany({ where: scope, data })).rejects.toThrow();
    }
  });

  it('enforces receipt links, identity immutability, metrics and sanitized errors in PostgreSQL', async () => {
    const saved = unwrap(await service.create(owner, definition)); const executionId = randomUUID();
    unwrap(await service.beginRun(owner, saved.id, 1, executionId));
    const scope = { executionId, organizationId: owner.organizationId };
    for (const data of [{ revision: 2 }, { sourceSha256: '0'.repeat(64) }, { callerUserId: other.userId },
      { scriptOrganizationId: foreign.organizationId }, { connectorCalls: 2 }, { outputBytes: 16385 },
      { status: 'FAILED' as const, finishedAt: new Date(), errorCode: 'CONNECTOR_ERROR', errorMessage: 'secret' },
      { status: 'FAILED' as const, finishedAt: new Date(), errorCode: 'UNKNOWN', errorMessage: '' }]) {
      await expect(db.codeboundScriptRun.updateMany({ where: scope, data })).rejects.toThrow();
    }
    unwrap(await service.finishRun(owner, executionId, { status: 'succeeded', metrics }));
    await expect(db.codeboundScriptRun.updateMany({ where: scope, data: { outputBytes: 11 } })).rejects.toThrow();
  });

  it('deleting a connector removes its scripts but retains run receipts', async () => {
    const saved = unwrap(await service.create(owner, definition)); const executionId = randomUUID();
    unwrap(await service.beginRun(owner, saved.id, 1, executionId));
    await db.connector.deleteMany({ where: { id: connectorId, organizationId: owner.organizationId } });
    expect(await service.get(owner, saved.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(unwrap(await service.getRun(owner, executionId)).scriptId).toBeNull();
  });

  it('allows only one winner when update and delete race at the same revision', async () => {
    const saved = unwrap(await service.create(owner, definition));
    const results = await Promise.all([service.update(owner, saved.id, 1, definition), service.remove(owner, saved.id, 1)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toMatchObject({ ok: false });
  });

  it('enforces exact initial receipt revision/hash and tenant binding in the database', async () => {
    const saved = unwrap(await service.create(owner, definition));
    const data = { executionId: randomUUID(), organizationId: owner.organizationId, ownerUserId: owner.userId, callerUserId: owner.userId,
      originalScriptId: saved.id, scriptId: saved.id, scriptOrganizationId: owner.organizationId, scriptOwnerUserId: owner.userId,
      revision: 1, sourceSha256: saved.sourceSha256 };
    for (const replacement of [{ revision: 2 }, { sourceSha256: '0'.repeat(64) }, { organizationId: foreign.organizationId },
      { scriptId: null, scriptOrganizationId: null, scriptOwnerUserId: null }]) {
      await expect(db.codeboundScriptRun.create({ data: { ...data, ...replacement } })).rejects.toThrow();
    }
  });

  it('keeps run get/finalize operations isolated across organizations for the same owner', async () => {
    const saved = unwrap(await service.create(owner, definition)); const executionId = randomUUID();
    unwrap(await service.beginRun(owner, saved.id, 1, executionId));
    const caller = { ...owner, organizationId: foreign.organizationId };
    expect(await service.getRun(caller, executionId)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await service.finishRun(caller, executionId, { status: 'succeeded', metrics })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('allows finalization after script deletion and purges receipts on organization deletion', async () => {
    const saved = unwrap(await service.create(owner, definition)); const executionId = randomUUID();
    unwrap(await service.beginRun(owner, saved.id, 1, executionId));
    unwrap(await service.remove(owner, saved.id, 1));
    unwrap(await service.finishRun(owner, executionId, { status: 'cancelled', metrics, error: { code: 'CANCELLED', message: 'Untrusted detail' } }));
    expect(unwrap(await service.getRun(owner, executionId)).status).toBe('CANCELLED');
    await db.organization.deleteMany({ where: { id: owner.organizationId } });
    expect(await db.codeboundScriptRun.count({ where: { executionId, organizationId: owner.organizationId } })).toBe(0);
  });

  it.each(['same-owner-other-org', 'other-owner-same-org', 'foreign-owner'])('denies every history operation for %s', async mode => {
    const saved = unwrap(await service.create(owner, definition)); const executionId = randomUUID();
    unwrap(await service.beginRun(owner, saved.id, 1, executionId));
    const caller = mode === 'same-owner-other-org' ? { ...owner, organizationId: foreign.organizationId } : mode === 'other-owner-same-org' ? other : foreign;
    for (const result of [await service.beginRun(caller, saved.id, 1, randomUUID()), await service.getRun(caller, executionId),
      await service.finishRun(caller, executionId, { status: 'succeeded', metrics })]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    expect(unwrap(await service.getRun(owner, executionId)).status).toBe('RUNNING');
  });

  it('checks real non-admin role grants for create and update, preserving null versus empty', async () => {
    await db.organizationMember.update({ where: { userId_organizationId: { userId: owner.userId, organizationId: owner.organizationId } }, data: { role: 'EDITOR' } });
    // Existing no-whitelist behavior returns null, so this is initially allowed.
    const saved = unwrap(await service.create(owner, definition));
    const role = await db.role.create({ data: { name: randomUUID(), organizationId: owner.organizationId,
      toolAccess: { create: { toolId } } } });
    // A whitelist now exists, but this owner has no assignment: [] must deny.
    expect(await service.create(owner, definition)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await service.update(owner, saved.id, 1, definition)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const assignment = await db.userRoleAssignment.create({ data: { userId: owner.userId, roleId: role.id, organizationId: owner.organizationId } });
    unwrap(await service.update(owner, saved.id, 1, definition));
    await db.userRoleAssignment.deleteMany({ where: { id: assignment.id, organizationId: owner.organizationId } });
    expect(await service.update(owner, saved.id, 2, definition)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    // Loss of connector permission must not prevent owner read/delete of source.
    expect(unwrap(await service.get(owner, saved.id)).revision).toBe(2);
    unwrap(await service.remove(owner, saved.id, 2));
  });

  it('uses real MCP attachment and revoked-grant checks during binding approval', async () => {
    const server = await db.mcpServerConfig.create({ data: { name: randomUUID(), userId: owner.userId, organizationId: owner.organizationId,
      connectors: { create: { connectorId } } } });
    const clientId = randomUUID();
    const caller: ExecutionPrincipal = { ...owner, origin: { kind: 'mcp', serverId: server.id, oauthClientId: clientId } };
    const saved = unwrap(await service.create(caller, definition));
    const grant = await db.mcpConnectionGrant.create({ data: { clientId, userId: owner.userId,
      organizationId: owner.organizationId, serverIds: [], revokedAt: new Date() } });
    expect(await service.create(caller, definition)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await service.update(caller, saved.id, 1, definition)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await db.mcpConnectionGrant.update({ where: { id: grant.id }, data: { revokedAt: null } });
    unwrap(await service.update(caller, saved.id, 1, definition));
    await db.mcpServerConnector.deleteMany({ where: { mcpServerId: server.id, connectorId, connector: { organizationId: owner.organizationId } } });
    expect(await service.update(caller, saved.id, 2, definition)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('rolls back successful SQL writes when a later step in the Prisma transaction fails', async () => {
    const saved = unwrap(await service.create(owner, definition));
    const failing = new ScriptPersistenceService({ user: db.user,
      $transaction: (operation: (tx: any) => Promise<unknown>) => db.$transaction(async tx => {
        await operation(tx); throw new Error('injected post-write failure');
      }) } as any, {} as any);
    // remove needs membership authentication, but no connector binding authorization.
    expect(await failing.remove(owner, saved.id, 1)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(unwrap(await service.get(owner, saved.id)).revision).toBe(1);
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)('allows RUNNING-to-%s once and rejects terminal tampering', async status => {
    const saved = unwrap(await service.create(owner, definition)); const executionId = randomUUID();
    unwrap(await service.beginRun(owner, saved.id, 1, executionId));
    const error = status === 'succeeded' ? undefined : { code: status === 'cancelled' ? 'CANCELLED' as const : 'SCRIPT_ERROR' as const, message: 'Untrusted detail' };
    unwrap(await service.finishRun(owner, executionId, { status, metrics, error }));
    const before = unwrap(await service.getRun(owner, executionId));
    for (const data of [{ status: 'RUNNING' as const, finishedAt: null }, { revision: 9 }, { originalScriptId: randomUUID() },
      { errorMessage: 'Untrusted detail' }, { finishedAt: new Date(before.finishedAt!.getTime() + 1) }]) {
      await expect(db.codeboundScriptRun.updateMany({ where: { executionId, organizationId: owner.organizationId }, data })).rejects.toThrow();
    }
    expect(unwrap(await service.getRun(owner, executionId))).toEqual(before);
  });

  it('permits only one winner for concurrent finalization and concurrent deletion', async () => {
    const saved = unwrap(await service.create(owner, definition)); const executionId = randomUUID();
    unwrap(await service.beginRun(owner, saved.id, 1, executionId));
    const finished = await Promise.all(['succeeded', 'cancelled'].map(status => service.finishRun(owner, executionId,
      status === 'succeeded' ? { status: 'succeeded', metrics } : { status: 'cancelled', metrics, error: { code: 'CANCELLED', message: 'Stopped' } })));
    expect(finished.filter(result => result.ok)).toHaveLength(1);
    expect(finished.find(result => !result.ok)).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    const removed = await Promise.all([service.remove(owner, saved.id, 1), service.remove(owner, saved.id, 1)]);
    expect(removed.filter(result => result.ok)).toHaveLength(1);
    expect(unwrap(await service.getRun(owner, executionId)).scriptId).toBeNull();
  });

  it('rejects manual receipt unlinking while the script still exists', async () => {
    const saved = unwrap(await service.create(owner, definition)); const executionId = randomUUID();
    unwrap(await service.beginRun(owner, saved.id, 1, executionId));
    await expect(db.codeboundScriptRun.updateMany({ where: { executionId, organizationId: owner.organizationId },
      data: { scriptId: null, scriptOrganizationId: null, scriptOwnerUserId: null } })).rejects.toThrow();
    expect(unwrap(await service.getRun(owner, executionId)).scriptId).toBe(saved.id);
  });
});
