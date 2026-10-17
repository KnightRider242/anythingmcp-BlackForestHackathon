// SPDX-License-Identifier: AGPL-3.0-only
import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CodeboundScript, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { isTokenRevoked } from '../../auth/auth.service';
import { findSecretLiterals } from '../../common/secret-literals.util';
import { BoundReadAuthorization } from '../gateway/bound-read-authorization.service';
import { codeboundErrorSchema, parseScriptSnapshot, scriptDefinitionSchema } from '../contracts.validation';
import { MVP_LIMITS } from '../contracts';
import type { CodeboundError, ExecutionPrincipal, Outcome, ScriptDefinition, ScriptLifecycle, ScriptSnapshot } from '../contracts';

const id = z.string().min(1).max(128);
const revision = z.number().int().min(1).max(2_147_483_647);
const principalSchema = z.strictObject({
  userId: id, organizationId: id, tokenIssuedAtMs: z.number().int().positive().safe(),
  tokenExpiresAtMs: z.number().int().positive().safe(),
  origin: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('dashboard') }),
    z.strictObject({ kind: z.literal('mcp'), serverId: id, oauthClientId: id.nullable() })]),
});
const completionSchema = z.strictObject({
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  metrics: z.strictObject({
    // Telemetry ceiling, not permission to run longer than the execution limit.
    wallTimeMs: z.number().finite().min(0).max(86_400_000),
    connectorCalls: z.number().int().min(0).max(1),
    connectorResponseBytes: z.number().int().min(0).max(MVP_LIMITS.maxConnectorResponseBytes),
    outputBytes: z.number().int().min(0).max(MVP_LIMITS.maxOutputBytes),
  }),
  error: codeboundErrorSchema.optional(),
}).refine(value => value.status === 'succeeded' ? !value.error : !!value.error &&
  (value.status !== 'cancelled' || value.error.code === 'CANCELLED'));
export type RunCompletion = z.infer<typeof completionSchema>;

class PersistenceFailure extends Error {
  constructor(readonly code: CodeboundError['code']) { super(code); }
}
const messages: Record<CodeboundError['code'], string> = {
  INVALID_INPUT: 'Invalid persistence request', NOT_FOUND: 'Script or receipt not found',
  FORBIDDEN: 'Script access denied', VERSION_CONFLICT: 'Revision or execution state changed',
  SCRIPT_ERROR: 'Script execution failed', CONNECTOR_ERROR: 'Connector operation failed',
  INVALID_OUTPUT: 'Invalid script output', RESOURCE_LIMIT: 'Execution limit exceeded',
  CANCELLED: 'Execution cancelled', SANDBOX_UNAVAILABLE: 'Isolated execution unavailable',
  INTERNAL_ERROR: 'Persistence operation failed',
};
type Store = Prisma.TransactionClient;

/** Storage only: no HTTP/MCP registration, runner invocation or stored output. */
@Injectable()
export class ScriptPersistenceService implements Pick<ScriptLifecycle, 'create' | 'get' | 'update' | 'remove'> {
  constructor(private readonly prisma: PrismaService, private readonly authorization: BoundReadAuthorization) {}

  private async outcome<T>(operation: () => Promise<T>): Promise<Outcome<T>> {
    try { return { ok: true, value: await operation() }; }
    catch (error) {
      const databaseCode = (error as { code?: string })?.code;
      const code = error instanceof PersistenceFailure ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT'
        : ['P2002', 'P2003', 'P2034'].includes(databaseCode ?? '') ? 'VERSION_CONFLICT' : 'INTERNAL_ERROR';
      return { ok: false, error: { code, message: messages[code] } };
    }
  }

  private scope(principal: ExecutionPrincipal) {
    return { organizationId: principal.organizationId, ownerUserId: principal.userId };
  }

  private async authenticate(raw: ExecutionPrincipal, store: Store = this.prisma): Promise<ExecutionPrincipal> {
    const p = principalSchema.parse(raw);
    if (p.tokenIssuedAtMs > Date.now() + 5000 || p.tokenExpiresAtMs <= Date.now() || p.tokenExpiresAtMs <= p.tokenIssuedAtMs) throw new PersistenceFailure('FORBIDDEN');
    const user = await store.user.findFirst({ where: { id: p.userId,
      memberships: { some: { organizationId: p.organizationId, deactivatedAt: null } } },
    select: { sessionsValidFrom: true } });
    if (!user || isTokenRevoked({ iat: Math.floor(p.tokenIssuedAtMs / 1000) }, user.sessionsValidFrom)) throw new PersistenceFailure('FORBIDDEN');
    return p;
  }

  private snapshot(row: CodeboundScript): ScriptSnapshot {
    return parseScriptSnapshot({ id: row.id, organizationId: row.organizationId, ownerUserId: row.ownerUserId,
      name: row.name, description: row.description, source: row.source, sourceSha256: row.sourceSha256,
      inputSchema: row.inputSchema, outputSchema: row.outputSchema, revision: row.revision,
      binding: { connectorId: row.connectorId, toolId: row.toolId, definitionSha256: row.definitionSha256 } });
  }

  private definition(raw: ScriptDefinition) {
    const definition = scriptDefinitionSchema.parse(raw);
    // Never copy connector config into these tables. Catch recognizable pasted
    // literals too; no scanner can establish absence of arbitrary user secrets.
    const scan = (value: unknown): boolean => typeof value === 'string' ? findSecretLiterals(value).length > 0
      : value !== null && typeof value === 'object' && Object.values(value).some(scan);
    if (scan(definition)) throw new PersistenceFailure('INVALID_INPUT');
    return { ...definition, sourceSha256: createHash('sha256').update(definition.source).digest('hex') };
  }

  private async approve(p: ExecutionPrincipal, snapshot: ScriptSnapshot) {
    try {
      const tool = await this.authorization.authorize(p, snapshot);
      // Avoid accidentally saving decrypted connector variables pasted into source/schema.
      const text = JSON.stringify(snapshot);
      const secrets = Object.values(tool.connector.envVars ?? {}).filter((v): v is string => typeof v === 'string' && !!v);
      if (secrets.some(secret => text.includes(JSON.stringify(secret).slice(1, -1)))) throw new PersistenceFailure('INVALID_INPUT');
    } catch (error) {
      if (error instanceof PersistenceFailure) throw error;
      throw new PersistenceFailure('FORBIDDEN');
    }
  }

  private data(snapshot: ScriptSnapshot) {
    return { name: snapshot.name, description: snapshot.description, source: snapshot.source, sourceSha256: snapshot.sourceSha256,
      inputSchema: snapshot.inputSchema as Prisma.InputJsonObject, outputSchema: snapshot.outputSchema as Prisma.InputJsonObject,
      connectorId: snapshot.binding.connectorId, toolId: snapshot.binding.toolId, definitionSha256: snapshot.binding.definitionSha256 };
  }

  create(principal: ExecutionPrincipal, definition: ScriptDefinition): Promise<Outcome<ScriptSnapshot>> {
    return this.outcome(async () => {
      const p = await this.authenticate(principal);
      const value = this.definition(definition);
      const snapshot = parseScriptSnapshot({ ...value, ...this.scope(p), id: randomUUID(), revision: 1 });
      await this.approve(p, snapshot);
      return this.prisma.$transaction(async tx => {
        await this.authenticate(p, tx);
        return this.snapshot(await tx.codeboundScript.create({ data: { id: snapshot.id, ...this.scope(p), ...this.data(snapshot) } }));
      });
    });
  }

  get(principal: ExecutionPrincipal, scriptId: string): Promise<Outcome<ScriptSnapshot>> {
    return this.outcome(async () => {
      const p = await this.authenticate(principal);
      const row = await this.prisma.codeboundScript.findFirst({ where: { id: id.parse(scriptId), ...this.scope(p) } });
      if (!row) throw new PersistenceFailure('NOT_FOUND');
      return this.snapshot(row);
    });
  }

  list(principal: ExecutionPrincipal, options: { afterId?: string; limit?: number } = {}): Promise<Outcome<readonly ScriptSnapshot[]>> {
    return this.outcome(async () => {
      const p = await this.authenticate(principal);
      const page = z.strictObject({ afterId: id.optional(), limit: z.number().int().min(1).max(100).default(20) }).parse(options);
      const rows = await this.prisma.codeboundScript.findMany({ where: { ...this.scope(p), ...(page.afterId ? { id: { gt: page.afterId } } : {}) },
        orderBy: { id: 'asc' }, take: page.limit });
      return Object.freeze(rows.map(row => this.snapshot(row)));
    });
  }

  update(principal: ExecutionPrincipal, scriptId: string, expectedRevision: number, replacement: ScriptDefinition): Promise<Outcome<ScriptSnapshot>> {
    return this.outcome(async () => {
      const p = await this.authenticate(principal);
      const scriptKey = id.parse(scriptId); const expected = revision.parse(expectedRevision);
      if (expected === 2_147_483_647) throw new PersistenceFailure('VERSION_CONFLICT');
      const value = this.definition(replacement);
      const snapshot = parseScriptSnapshot({ ...value, ...this.scope(p), id: scriptKey, revision: expected + 1 });
      await this.approve(p, snapshot);
      return this.prisma.$transaction(async tx => {
        await this.authenticate(p, tx);
        const changed = await tx.codeboundScript.updateMany({ where: { id: scriptKey, ...this.scope(p), revision: expected },
          data: { ...this.data(snapshot), revision: { increment: 1 } } });
        const row = await tx.codeboundScript.findFirst({ where: { id: scriptKey, ...this.scope(p) } });
        if (!row) throw new PersistenceFailure('NOT_FOUND');
        if (!changed.count) throw new PersistenceFailure('VERSION_CONFLICT');
        return this.snapshot(row);
      });
    });
  }

  remove(principal: ExecutionPrincipal, scriptId: string, expectedRevision: number): Promise<Outcome<null>> {
    return this.outcome(async () => {
      const p = await this.authenticate(principal); const scriptKey = id.parse(scriptId); const expected = revision.parse(expectedRevision);
      return this.prisma.$transaction(async tx => {
        await this.authenticate(p, tx);
        const removed = await tx.codeboundScript.deleteMany({ where: { id: scriptKey, ...this.scope(p), revision: expected } });
        if (!removed.count) {
          const exists = await tx.codeboundScript.findFirst({ where: { id: scriptKey, ...this.scope(p) }, select: { id: true } });
          throw new PersistenceFailure(exists ? 'VERSION_CONFLICT' : 'NOT_FOUND');
        }
        return null;
      });
    });
  }

  /** Future orchestration gets exactly the snapshot identified by this receipt. */
  beginRun(principal: ExecutionPrincipal, scriptId: string, expectedRevision: number, executionId: string): Promise<Outcome<ScriptSnapshot>> {
    return this.outcome(async () => {
      const p = await this.authenticate(principal); const scriptKey = id.parse(scriptId);
      const expected = revision.parse(expectedRevision); const execution = id.parse(executionId);
      return this.prisma.$transaction(async tx => {
        await this.authenticate(p, tx);
        // Serialize capture against update/delete, so the insert trigger and
        // returned snapshot always describe the same persisted revision.
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM codebound_scripts
          WHERE id = ${scriptKey} AND organization_id = ${p.organizationId} AND owner_user_id = ${p.userId} FOR UPDATE`;
        if (!locked.length) throw new PersistenceFailure('NOT_FOUND');
        const row = await tx.codeboundScript.findFirst({ where: { id: scriptKey, ...this.scope(p) } });
        if (!row) throw new PersistenceFailure('NOT_FOUND');
        if (row.revision !== expected) throw new PersistenceFailure('VERSION_CONFLICT');
        const snapshot = this.snapshot(row);
        await tx.codeboundScriptRun.create({ data: { executionId: execution, ...this.scope(p), callerUserId: p.userId,
          originalScriptId: row.id, scriptId: row.id, scriptOrganizationId: p.organizationId, scriptOwnerUserId: p.userId,
          revision: row.revision, sourceSha256: row.sourceSha256 } });
        return snapshot;
      });
    });
  }

  finishRun(principal: ExecutionPrincipal, executionId: string, completion: RunCompletion): Promise<Outcome<null>> {
    return this.outcome(async () => {
      const p = await this.authenticate(principal); const execution = id.parse(executionId); const value = completionSchema.parse(completion);
      const error = value.error;
      const changed = await this.prisma.codeboundScriptRun.updateMany({ where: { executionId: execution, ...this.scope(p), callerUserId: p.userId, status: 'RUNNING' },
        data: { status: value.status === 'succeeded' ? 'SUCCEEDED' : value.status === 'failed' ? 'FAILED' : 'CANCELLED',
          ...value.metrics, finishedAt: new Date(), errorCode: error?.code ?? null,
          errorMessage: error ? messages[error.code] : null, errorLimit: error?.limit ?? null } });
      if (!changed.count) {
        const exists = await this.prisma.codeboundScriptRun.findFirst({ where: { executionId: execution, ...this.scope(p), callerUserId: p.userId }, select: { executionId: true } });
        throw new PersistenceFailure(exists ? 'VERSION_CONFLICT' : 'NOT_FOUND');
      }
      return null;
    });
  }

  getRun(principal: ExecutionPrincipal, executionId: string) {
    return this.outcome(async () => {
      const p = await this.authenticate(principal);
      const row = await this.prisma.codeboundScriptRun.findFirst({ where: { executionId: id.parse(executionId), ...this.scope(p), callerUserId: p.userId } });
      if (!row) throw new PersistenceFailure('NOT_FOUND');
      return row;
    });
  }
}
