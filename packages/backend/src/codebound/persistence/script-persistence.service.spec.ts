// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { ScriptPersistenceService } from './script-persistence.service';
import type { ExecutionPrincipal, ScriptDefinition } from '../contracts';

const principal = (): ExecutionPrincipal => ({ userId: 'owner', organizationId: 'org-a', tokenIssuedAtMs: Date.now() - 10_000,
  tokenExpiresAtMs: Date.now() + 60_000, origin: { kind: 'dashboard' } });
const definition = (): ScriptDefinition => ({ name: 'Count', description: '', source: 'async function main(input, api) { return 1; }',
  inputSchema: {}, outputSchema: {}, binding: { connectorId: 'connector-a', toolId: 'tool-a', definitionSha256: 'a'.repeat(64) } });
const row = () => ({ id: 'script-a', organizationId: 'org-a', ownerUserId: 'owner', ...definition(), connectorId: 'connector-a', toolId: 'tool-a',
  definitionSha256: 'a'.repeat(64), sourceSha256: createHash('sha256').update(definition().source).digest('hex'), revision: 1 });
function setup() {
  const db: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'script-a' }]),
    user: { findFirst: jest.fn().mockResolvedValue({ sessionsValidFrom: null }) },
    codeboundScript: { create: jest.fn(async ({ data }) => ({ ...data, revision: 1 })),
      findFirst: jest.fn().mockResolvedValue(row()), findMany: jest.fn().mockResolvedValue([row()]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    codeboundScriptRun: { create: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ executionId: 'execution-a' }) },
  };
  db.$transaction = jest.fn((operation: (tx: any) => unknown) => operation(db));
  const authorization = { authorize: jest.fn().mockResolvedValue({ connector: { envVars: { KEY: 'credential-canary-12345' } } }) };
  return { db, authorization, service: new ScriptPersistenceService(db, authorization as any) };
}
const metrics = { wallTimeMs: 10, connectorCalls: 1, connectorResponseBytes: 100, outputBytes: 10 };

describe('CODEBOUND persistence validation (database mocked)', () => {
  it('stores only definition fields and a server-generated hash, with live authorization', async () => {
    const s = setup(); const result = await s.service.create(principal(), definition());
    expect(result).toMatchObject({ ok: true, value: { organizationId: 'org-a', ownerUserId: 'owner', revision: 1 } });
    expect(s.authorization.authorize).toHaveBeenCalledTimes(1);
    const stored = s.db.codeboundScript.create.mock.calls[0][0].data;
    expect(stored.sourceSha256).toBe(row().sourceSha256);
    expect(JSON.stringify(stored)).not.toContain('credential-canary');
    expect(stored).not.toHaveProperty('connector'); expect(stored).not.toHaveProperty('envVars');
  });

  it.each(['empty-source', 'large-source', 'invalid-fingerprint', 'extra-field', 'array-schema', 'unsafe-schema', 'large-schema'])('rejects %s definitions before writing', async change => {
    const s = setup(); const value: any = definition();
    if (change === 'empty-source') value.source = '';
    if (change === 'large-source') value.source = 'x'.repeat(32769);
    if (change === 'invalid-fingerprint') value.binding.definitionSha256 = 'bad';
    if (change === 'extra-field') value.organizationId = 'foreign';
    if (change === 'array-schema') value.inputSchema = [];
    if (change === 'unsafe-schema') value.inputSchema = JSON.parse('{"__proto__":{}}');
    if (change === 'large-schema') value.outputSchema = { description: 'x'.repeat(16384) };
    expect(await s.service.create(principal(), value)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(s.db.codeboundScript.create).not.toHaveBeenCalled();
  });

  it('rejects known connector secrets pasted into source', async () => {
    const s = setup();
    expect(await s.service.create(principal(), { ...definition(), source: 'async function main() { return "credential-canary-12345"; }' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(s.db.codeboundScript.create).not.toHaveBeenCalled();
  });

  it('fails closed on revoked membership and invalid bindings with sanitized errors', async () => {
    const s = setup(); s.db.user.findFirst.mockResolvedValueOnce(null);
    expect(await s.service.get(principal(), 'script-a')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    s.authorization.authorize.mockRejectedValueOnce(new Error('private-credential'));
    const rejected = await s.service.create(principal(), definition());
    expect(rejected).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(JSON.stringify(rejected)).not.toContain('private-credential');
  });

  it('uses organization, owner and expected revision in atomic update/delete predicates', async () => {
    const s = setup(); s.db.codeboundScript.findFirst.mockResolvedValue({ ...row(), revision: 2 });
    expect(await s.service.update(principal(), 'script-a', 1, definition())).toMatchObject({ ok: true });
    expect(s.db.codeboundScript.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'script-a', organizationId: 'org-a', ownerUserId: 'owner', revision: 1 },
      data: expect.objectContaining({ revision: { increment: 1 } }) }));
    s.db.codeboundScript.deleteMany.mockResolvedValue({ count: 0 });
    expect(await s.service.remove(principal(), 'script-a', 1)).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(s.db.codeboundScript.deleteMany).toHaveBeenCalledWith({ where: { id: 'script-a', organizationId: 'org-a', ownerUserId: 'owner', revision: 1 } });
  });

  it('bounds scoped list pages and freezes nested returned snapshots', async () => {
    const s = setup();
    const result = await s.service.list(principal(), { afterId: 'before', limit: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(Object.isFrozen(result.value)).toBe(true); expect(Object.isFrozen(result.value[0].inputSchema)).toBe(true); }
    expect(s.db.codeboundScript.findMany).toHaveBeenCalledWith({ where: { organizationId: 'org-a', ownerUserId: 'owner', id: { gt: 'before' } }, orderBy: { id: 'asc' }, take: 5 });
    expect(await s.service.list(principal(), { limit: 101 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('rejects revision overflow while allowing deletion at the largest stored revision', async () => {
    const s = setup();
    expect(await s.service.update(principal(), 'script-a', 2_147_483_647, definition()))
      .toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } });
    expect(s.db.codeboundScript.updateMany).not.toHaveBeenCalled();
    expect(await s.service.remove(principal(), 'script-a', 2_147_483_647)).toMatchObject({ ok: true });
  });

  it('records immutable revision/hash references without storing source or inputs', async () => {
    const s = setup(); expect(await s.service.beginRun(principal(), 'script-a', 1, 'execution-a')).toMatchObject({ ok: true });
    const data = s.db.codeboundScriptRun.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ originalScriptId: 'script-a', scriptOrganizationId: 'org-a', revision: 1, sourceSha256: row().sourceSha256 });
    expect(data).not.toHaveProperty('source'); expect(data).not.toHaveProperty('input');
  });

  it('stores only fixed error messages and rejects output/log fields in completion', async () => {
    const s = setup();
    expect(await s.service.finishRun(principal(), 'execution-a', { status: 'failed', metrics, error: { code: 'RESOURCE_LIMIT', limit: 'outputBytes', message: 'sensitive error detail' } })).toMatchObject({ ok: true });
    expect(s.db.codeboundScriptRun.updateMany.mock.calls[0][0].data).toMatchObject({ errorMessage: 'Execution limit exceeded', errorLimit: 'outputBytes' });
    expect(await s.service.finishRun(principal(), 'execution-a', { status: 'succeeded', metrics, output: 'secret' } as any)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it.each(['calls', 'bytes', 'time', 'nan', 'status'])('rejects invalid %s completion', async change => {
    const s = setup(); const value: any = { status: 'succeeded', metrics: { ...metrics } };
    if (change === 'calls') value.metrics.connectorCalls = 2;
    if (change === 'bytes') value.metrics.outputBytes = 16385;
    if (change === 'time') value.metrics.wallTimeMs = 86400001;
    if (change === 'nan') value.metrics.wallTimeMs = NaN;
    if (change === 'status') value.status = 'failed';
    expect(await s.service.finishRun(principal(), 'execution-a', value)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(s.db.codeboundScriptRun.updateMany).not.toHaveBeenCalled();
  });

  it.each(['source', 'schema'])('enforces UTF-8 bytes rather than character counts for %s', async field => {
    const s = setup(); const value = definition();
    if (field === 'source') value.source = '€'.repeat(10_923);
    else value.inputSchema = { description: '€'.repeat(5_462) };
    expect(await s.service.create(principal(), value)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(s.db.codeboundScript.create).not.toHaveBeenCalled();
  });

  it('accepts bounded error bytes but rejects multibyte errors exceeding 512 bytes', async () => {
    const s = setup();
    expect(await s.service.finishRun(principal(), 'execution-a', { status: 'failed', metrics,
      error: { code: 'SCRIPT_ERROR', message: '€'.repeat(170) + 'ab' } })).toMatchObject({ ok: true });
    expect(s.db.codeboundScriptRun.updateMany.mock.calls[0][0].data.errorMessage).toBe('Script execution failed');
    s.db.codeboundScriptRun.updateMany.mockClear();
    expect(await s.service.finishRun(principal(), 'execution-a', { status: 'failed', metrics,
      error: { code: 'SCRIPT_ERROR', message: '€'.repeat(171) } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(s.db.codeboundScriptRun.updateMany).not.toHaveBeenCalled();
  });
});
