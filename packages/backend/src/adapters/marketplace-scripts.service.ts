// SPDX-License-Identifier: AGPL-3.0-only
import { BadRequestException, ForbiddenException, HttpException, Injectable, InternalServerErrorException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ScriptPersistenceService } from '../codebound/persistence/script-persistence.service';
import { fingerprintReadTool } from '../codebound/gateway/bound-read-authorization.service';
import type { ExecutionPrincipal } from '../codebound/contracts';
import type { AdapterDefinition } from './catalog';
import { parseCodeboundTemplates } from './codebound-templates';

@Injectable()
export class MarketplaceScriptsService {
  constructor(private readonly prisma: PrismaService, private readonly scripts: ScriptPersistenceService) {}

  async install(adapter: AdapterDefinition, principal: ExecutionPrincipal, data: Prisma.ConnectorUncheckedCreateInput,
    toolRows: (id: string) => Prisma.McpToolCreateManyInput[]) {
    let templates;
    try { templates = parseCodeboundTemplates(adapter); } catch { throw new BadRequestException('Invalid marketplace script template'); }
    if (!templates.length || principal.origin.kind !== 'dashboard' || data.userId !== principal.userId ||
        data.organizationId !== principal.organizationId) throw new ForbiddenException('Script installation denied');
    try { return await this.prisma.$transaction(async tx => {
      // One installation per owner/org/slug, across replicas and concurrent retries.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([principal.organizationId, principal.userId, adapter.slug])}, 0))`;
      const existing = await tx.connector.findFirst({ where: { organizationId: principal.organizationId, userId: principal.userId,
        config: { path: ['codeboundMarketplaceSlug'], equals: adapter.slug } }, select: { id: true } });
      if (existing) {
        // Reauthenticate even when scripts were deliberately deleted by their owner.
        const visible = await this.scripts.list(principal, { limit: 1 });
        if (!visible.ok) throw new ForbiddenException('Script installation denied');
        return { connectorId: existing.id, toolsCreated: 0, probe: null, scriptsInstalled: 0 };
      }
      const connector = await tx.connector.create({ data: { ...data,
        config: { ...(data.config as Prisma.InputJsonObject), codeboundMarketplaceSlug: adapter.slug } } });
      await tx.mcpTool.createMany({ data: toolRows(connector.id) }); // All-or-nothing; no fallback that hides missing tools.
      for (const { key: _key, toolName, ...definition } of templates) {
        const tool = await tx.mcpTool.findFirst({ where: { connectorId: connector.id, name: toolName,
          connector: { organizationId: principal.organizationId, userId: principal.userId } }, include: { connector: true } });
        if (!tool) throw new BadRequestException('Marketplace script tool unavailable');
        const created = await this.scripts.createForInstallation(principal, { ...definition,
          binding: { connectorId: connector.id, toolId: tool.id, definitionSha256: fingerprintReadTool(tool) } }, tx);
        if (!created.ok) {
          if (created.error.code === 'FORBIDDEN') throw new ForbiddenException('Script installation denied');
          if (created.error.code === 'INVALID_INPUT') throw new BadRequestException('Invalid marketplace script definition');
          throw new InternalServerErrorException('Marketplace script installation failed');
        }
      }
      return { connectorId: connector.id, toolsCreated: adapter.tools.length, probe: null, scriptsInstalled: templates.length };
    }, { maxWait: 5000, timeout: 20_000 }); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      // Prisma diagnostics may include SQL arguments/configuration; never forward or log them.
      throw new InternalServerErrorException('Marketplace script installation failed');
    }
  }
}
