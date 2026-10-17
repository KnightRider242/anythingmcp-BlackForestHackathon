// SPDX-License-Identifier: AGPL-3.0-only
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma.service';
import { BoundReadAuthorization, fingerprintReadTool } from '../gateway/bound-read-authorization.service';
import type { ExecutionPrincipal } from '../contracts';

@Injectable()
export class ScriptBindingsService {
  constructor(private readonly prisma: PrismaService, private readonly authorization: BoundReadAuthorization) {}

  async list(principal: ExecutionPrincipal, afterId?: string) {
    // Bound both DB work and live permission checks. Cursor advances over denied candidates too.
    const tools = await this.prisma.mcpTool.findMany({ where: { ...(afterId ? { id: { gt: afterId } } : {}),
      isEnabled: true, useProxy: false,
      connector: { organizationId: principal.organizationId, userId: principal.userId, isActive: true, type: 'REST' } },
    orderBy: { id: 'asc' }, take: 33, include: { connector: true } });
    const items: { connectorName: string; toolName: string; binding: { connectorId: string; toolId: string; definitionSha256: string } }[] = [];
    for (const tool of tools.slice(0, 32)) {
      const binding = { connectorId: tool.connectorId, toolId: tool.id, definitionSha256: fingerprintReadTool(tool) };
      try {
        await this.authorization.authorize(principal, { id: 'binding-preview', organizationId: principal.organizationId,
          ownerUserId: principal.userId, revision: 1, name: 'Binding preview', description: '', source: 'preview',
          sourceSha256: createHash('sha256').update('preview').digest('hex'), inputSchema: {}, outputSchema: {}, binding });
        // No URL, parameters, headers, credentials, env vars or configuration leaves this boundary.
        items.push({ connectorName: tool.connector.name, toolName: tool.name, binding });
      } catch { /* Unapproved candidates are invisible; persistence rechecks when saving. */ }
    }
    return { items, nextCursor: tools.length > 32 ? tools[31].id : null };
  }
}
