// SPDX-License-Identifier: AGPL-3.0-only
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RolesService } from '../../roles/roles.service';
import { McpConnectionGrantService } from '../../mcp-servers/mcp-connection-grant.service';
import { LicenseGuardService } from '../../license/license-guard.service';
import { isTokenRevoked } from '../../auth/auth.service';
import type { ExecutionPrincipal, ReadToolBinding, ScriptSnapshot } from '../contracts';

export type BoundReadTool = Prisma.McpToolGetPayload<{ include: { connector: true } }>;

/** Includes execution-affecting configuration; never return the canonical input. */
export function fingerprintReadTool(tool: BoundReadTool): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]),
    );
    return value;
  };
  const connector = tool.connector;
  return createHash('sha256').update(JSON.stringify(canonical({
    id: tool.id, connectorId: tool.connectorId, name: tool.name, isEnabled: tool.isEnabled,
    parameters: tool.parameters, endpointMapping: tool.endpointMapping,
    responseMapping: tool.responseMapping, outputSchema: tool.outputSchema, useProxy: tool.useProxy,
    connector: {
      id: connector.id, organizationId: connector.organizationId, userId: connector.userId,
      type: connector.type, isActive: connector.isActive, baseUrl: connector.baseUrl,
      authType: connector.authType, authConfig: connector.authConfig, headers: connector.headers,
      envVars: connector.envVars, config: connector.config,
    },
  }))).digest('hex');
}

@Injectable()
export class BoundReadAuthorization {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
    private readonly grants: McpConnectionGrantService,
    private readonly license: LicenseGuardService,
  ) {}

  /** Always read live rows, never registry snapshots or cached role decisions. */
  async authorize(principal: ExecutionPrincipal, script: ScriptSnapshot, store: Prisma.TransactionClient = this.prisma,
    binding: Readonly<ReadToolBinding> = script.binding): Promise<BoundReadTool> {
    if (![script.binding, ...(script.additionalBindings ?? [])].some(item => item.connectorId === binding.connectorId &&
        item.toolId === binding.toolId && item.definitionSha256 === binding.definitionSha256)) throw new Error('Denied');
    const { userId, organizationId } = principal;
    if (principal.tokenExpiresAtMs <= Date.now() || principal.tokenIssuedAtMs > Date.now() + 5000 ||
        script.organizationId !== organizationId || script.ownerUserId !== userId) throw new Error('Denied');
    // License checks can wait on unrelated services. Never retain positive
    // authorization decisions across that await; read authorization afterwards.
    await this.license.checkLicenseActive(organizationId);
    const allowed = await this.roles.getAllowedToolIds(userId, organizationId);
    if (allowed !== null && !allowed.includes(binding.toolId)) throw new Error('Denied');
    if (principal.origin.kind === 'mcp') {
      const { serverId, oauthClientId } = principal.origin;
      if (principal.origin.apiKeyId && !await store.mcpApiKey.findFirst({ where: {
        id: principal.origin.apiKeyId, organizationId, userId, mcpServerId: serverId, isActive: true,
      }, select: { id: true } })) throw new Error('Denied');
      const server = await this.prisma.mcpServerConfig.findFirst({
        where: { id: serverId, organizationId, isActive: true,
          connectors: { some: { connectorId: binding.connectorId, connector: { organizationId } } } },
        select: { id: true },
      });
      if (!server) throw new Error('Denied');
      const grant = await this.grants.resolve(oauthClientId ?? undefined, userId);
      // null means legacy/no grant; mode:none is an explicit refusal.
      if (grant?.mode === 'none' ||
          (grant?.mode === 'organization' && grant.organizationId !== organizationId) ||
          (grant?.mode === 'servers' && !grant.servers.some(s => s.id === serverId && s.organizationId === organizationId))) throw new Error('Denied');
    }
    // Fetch identity and the exact executable definition after role/grant work,
    // rather than executing a row captured before those asynchronous checks.
    const user = await store.user.findFirst({
      where: { id: userId, memberships: { some: { organizationId, deactivatedAt: null } } },
      select: { id: true, sessionsValidFrom: true },
    });
    if (!user || isTokenRevoked({ iat: Math.floor(principal.tokenIssuedAtMs / 1000) }, user.sessionsValidFrom)) throw new Error('Denied');
    const tool = await store.mcpTool.findFirst({
      where: {
        id: binding.toolId, connectorId: binding.connectorId, isEnabled: true,
        connector: { organizationId, userId, isActive: true },
      },
      include: { connector: true },
    });
    if (!tool || tool.id !== binding.toolId || tool.connectorId !== binding.connectorId ||
        tool.connector.organizationId !== organizationId || tool.connector.userId !== userId ||
        !tool.isEnabled || !tool.connector.isActive || tool.connector.type !== 'REST' ||
        !['GET', 'POST'].includes((tool.endpointMapping as { method?: string })?.method ?? '') || tool.useProxy ||
        !['NONE', 'BEARER_TOKEN', 'API_KEY', 'BASIC_AUTH'].includes(tool.connector.authType) ||
        fingerprintReadTool(tool) !== binding.definitionSha256) throw new Error('Denied');
    if (principal.tokenExpiresAtMs <= Date.now()) throw new Error('Denied');
    return tool;
  }

  async authorizeAll(principal: ExecutionPrincipal, script: ScriptSnapshot, store?: Prisma.TransactionClient): Promise<BoundReadTool[]> {
    const bindings = [script.binding, ...(script.additionalBindings ?? [])];
    if (bindings.length > 8 || new Set(bindings.map(item => item.toolId)).size !== bindings.length) throw new Error('Denied');
    const tools: BoundReadTool[] = [];
    for (const binding of bindings) tools.push(await this.authorize(principal, script, store, binding));
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Denied');
    return tools;
  }
}
