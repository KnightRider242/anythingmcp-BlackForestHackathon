// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { AuthModule } from '../../auth/auth.module';
import { CodeboundPersistenceModule } from '../persistence/codebound-persistence.module';
import { CodeboundGatewayModule } from '../gateway/codebound-gateway.module';
import { DockerSandboxRunner } from '../sandbox/docker-sandbox-runner';
import { ScriptExecutionService } from './script-execution.service';
import { ScriptExecutionController } from './script-execution.controller';
import { CodeboundMcpToolsService } from '../mcp/codebound-mcp-tools.service';
import { PrismaModule } from '../../common/prisma.module';
import { ScriptManagementController } from '../management/script-management.controller';
import { ScriptBindingsService } from '../management/script-bindings.service';

@Module({
  imports: [AuthModule, AuditModule, PrismaModule, CodeboundPersistenceModule, CodeboundGatewayModule],
  controllers: [ScriptExecutionController, ScriptManagementController],
  providers: [ScriptBindingsService, ScriptExecutionService, CodeboundMcpToolsService, { provide: DockerSandboxRunner, useFactory: () => new DockerSandboxRunner() }],
  exports: [ScriptExecutionService, CodeboundMcpToolsService],
})
export class CodeboundExecutionModule {}
