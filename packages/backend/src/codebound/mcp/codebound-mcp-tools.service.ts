// SPDX-License-Identifier: AGPL-3.0-only
import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AuthService } from '../../auth/auth.service';
import { resolveUserIdFromTokenPayload } from '../../auth/resolve-user-id.util';
import { PrismaService } from '../../common/prisma.service';
import { jsonSchemaToZodShape } from '../../mcp-server/tool-schema.util';
import { ScriptPersistenceService } from '../persistence/script-persistence.service';
import { ScriptExecutionService } from '../execution/script-execution.service';
import { BoundReadAuthorization } from '../gateway/bound-read-authorization.service';
import { scriptExecutionRequestSchema } from '../contracts.validation';
import type { ExecutionPrincipal, ScriptSnapshot } from '../contracts';

/** Reserved on the per-server endpoint; connector tools cannot impersonate scripts. */
export const CODEBOUND_TOOL_PREFIX = 'codebound_script_';
export const scriptToolName = (id: string) => CODEBOUND_TOOL_PREFIX + createHash('sha256').update(id).digest('base64url');
export const MCP_DISCOVERY_LIMITS = Object.freeze({ scripts: 32, metadataBytes: 64 * 1024,
  concurrent: 4, perOrganization: 2, wallTimeMs: 3000 });
export interface ScriptToolEntry {
  name: string;
  sig: string;
  register(server: McpServer): { remove(): void };
}
const denied = (code = 'FORBIDDEN') => ({ isError: true as const,
  content: [{ type: 'text' as const, text: `CODEBOUND execution unavailable (${code}).` }] });
interface RequestScope { principal?: ExecutionPrincipal; signal: AbortSignal }

/** Request-local authority, never captured JWT authority from an old session.
 * Used by the existing per-server MCP controller, not a separate MCP server.
 */
@Injectable()
export class CodeboundMcpToolsService {
  private readonly requests = new AsyncLocalStorage<RequestScope>();
  private discoveries = 0;
  private readonly discoveriesByOrg = new Map<string, number>();
  constructor(private readonly prisma: PrismaService, private readonly auth: AuthService,
    private readonly persistence: ScriptPersistenceService, private readonly authorization: BoundReadAuthorization,
    private readonly execution: ScriptExecutionService) {}

  currentPrincipal() { return this.requests.getStore()?.principal; }

  sameIdentity(a: ExecutionPrincipal, b: ExecutionPrincipal): boolean {
    return a.userId === b.userId && a.organizationId === b.organizationId &&
      a.origin.kind === 'mcp' && b.origin.kind === 'mcp' && a.origin.serverId === b.origin.serverId &&
      a.origin.oauthClientId === b.origin.oauthClientId;
  }

  private async principal(req: Request, serverId: string): Promise<ExecutionPrincipal | undefined> {
    // Static credentials, anonymous mode and API keys retain existing connector
    // behavior but cannot execute owner-only CODEBOUND scripts in this MVP.
    if ((req as Request & { user?: { authMethod?: string } }).user?.authMethod !== 'jwt') return;
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) return;
    const claims = this.auth.verifyToken(token) as ReturnType<AuthService['verifyToken']> & { type?: string; azp?: string; client_id?: string };
    // A refresh/user/machine token is not authority for script execution.
    if (claims.type !== undefined && claims.type !== 'access') return;
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat! <= 0 || claims.exp! <= claims.iat!) return;
    const userId = await resolveUserIdFromTokenPayload(this.prisma, claims);
    if (!userId || userId.startsWith('client:')) return;
    // Resolve organization from the addressed live server and membership, never
    // from token/body organization claims. All subsequent queries use this scope.
    const server = await this.prisma.mcpServerConfig.findFirst({ where: { id: serverId, isActive: true,
      organization: { members: { some: { userId, deactivatedAt: null } } } }, select: { organizationId: true } });
    if (!server) return;
    const client = claims.azp ?? claims.client_id;
    if (client !== undefined && (typeof client !== 'string' || !client || client.length > 128)) return;
    return { userId, organizationId: server.organizationId, tokenIssuedAtMs: claims.iat! * 1000,
      tokenExpiresAtMs: claims.exp! * 1000, origin: { kind: 'mcp', serverId, oauthClientId: client ?? null } };
  }

  async withRequest<T>(req: Request, res: Response, serverId: string, operation: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!res.writableFinished) abort(); };
    req.once('aborted', abort); res.once('close', close);
    if (req.aborted || res.destroyed) abort();
    let principal: ExecutionPrincipal | undefined;
    try { principal = await this.principal(req, serverId); } catch { /* Fail closed for script tools; preserve existing endpoint policy. */ }
    try { return await this.requests.run({ principal, signal: controller.signal }, operation); }
    finally { req.removeListener('aborted', abort); res.removeListener('close', close); }
  }

  async entries(principal: ExecutionPrincipal | undefined): Promise<ScriptToolEntry[]> {
    if (!principal || this.discoveries >= MCP_DISCOVERY_LIMITS.concurrent ||
      (this.discoveriesByOrg.get(principal.organizationId) ?? 0) >= MCP_DISCOVERY_LIMITS.perOrganization) return [];
    this.discoveries++;
    this.discoveriesByOrg.set(principal.organizationId, (this.discoveriesByOrg.get(principal.organizationId) ?? 0) + 1);
    const current = this.requests.getStore();
    const signals = [AbortSignal.timeout(MCP_DISCOVERY_LIMITS.wallTimeMs)];
    if (current?.principal && this.sameIdentity(current.principal, principal)) signals.push(current.signal);
    const signal = AbortSignal.any(signals);
    // Keep the slot until uncancellable upstream DB work settles, even if the
    // caller's deadline wins. Late work checks the signal before each next step.
    const operation = this.discover(principal, signal).catch(() => [] as ScriptToolEntry[]).finally(() => {
      this.discoveries--;
      const count = (this.discoveriesByOrg.get(principal.organizationId) ?? 1) - 1;
      if (count) this.discoveriesByOrg.set(principal.organizationId, count); else this.discoveriesByOrg.delete(principal.organizationId);
    });
    return new Promise(resolve => {
      const abort = () => resolve([]);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void operation.then(value => resolve(signal.aborted ? [] : value)).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  private async discover(principal: ExecutionPrincipal, signal: AbortSignal): Promise<ScriptToolEntry[]> {
    if (signal.aborted) return [];
    const entries: ScriptToolEntry[] = [];
    let metadataBytes = 1024; // Reserve framing/array overhead for the bounded surface.
    const result = await this.persistence.list(principal, { limit: MCP_DISCOVERY_LIMITS.scripts });
    if (!result.ok || signal.aborted) return [];
    for (const script of result.value.slice(0, MCP_DISCOVERY_LIMITS.scripts)) {
        try {
          if (signal.aborted) return [];
          await this.authorization.authorize(principal, script);
          if (signal.aborted) return [];
          const shape = jsonSchemaToZodShape(script.inputSchema as Record<string, unknown>);
          const schema = script.inputSchema.additionalProperties === false ? z.strictObject(shape) : z.looseObject(shape);
          // Conversion errors never break the caller's other MCP tools.
          metadataBytes += Buffer.byteLength(JSON.stringify({ name: scriptToolName(script.id),
            description: `${script.name}${script.description ? ': ' + script.description : ''}`, title: script.name,
            inputSchema: z.toJSONSchema(schema), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } }));
          if (metadataBytes > MCP_DISCOVERY_LIMITS.metadataBytes) break;
          entries.push(this.entry(script, schema));
        } catch { /* Not eligible: disclose neither definition nor rejection details. */ }
    }
    return entries;
  }

  private entry(script: ScriptSnapshot, schema: z.ZodObject): ScriptToolEntry {
    // Do not retain source, output schema or binding in every SDK/session closure.
    const { id, revision, name, description, organizationId, ownerUserId } = script;
    const toolName = scriptToolName(id);
    return { name: toolName, sig: `${toolName}:${revision}`,
      register: server => server.registerTool(toolName, {
        title: name, description: `${name}${description ? ': ' + description : ''}`,
        inputSchema: schema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      }, async (args, context) => {
        const current = this.requests.getStore();
        if (!current?.principal || current.principal.organizationId !== organizationId || current.principal.userId !== ownerUserId) return denied();
        const input = scriptExecutionRequestSchema.safeParse({ scriptId: id, expectedRevision: revision, input: args });
        if (!input.success) return denied('INVALID_INPUT');
        try {
          // Re-read: deleted scripts, changed revisions and permissions cannot
          // execute through an old SDK registration. Execution rechecks again.
          const saved = await this.persistence.get(current.principal, id);
          if (!saved.ok) return denied();
          if (saved.value.revision !== revision) return denied('VERSION_CONFLICT');
          await this.authorization.authorize(current.principal, saved.value);
          const result = await this.execution.execute(current.principal, input.data, AbortSignal.any([current.signal, context.mcpReq.signal]));
          if (!result.ok) return denied(result.error.code);
          if (result.value.status !== 'succeeded') return denied(result.value.error.code);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result.value.output) }],
            _meta: { 'codebound/executionId': result.value.executionId, 'codebound/revision': result.value.revision } };
        } catch { return denied(); }
      }),
    };
  }
}
