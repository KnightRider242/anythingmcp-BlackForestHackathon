// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { AuthModule } from '../../auth/auth.module';
import { CodeboundPersistenceModule } from '../persistence/codebound-persistence.module';
import { CodeboundGatewayModule } from '../gateway/codebound-gateway.module';
import { DockerSandboxRunner } from '../sandbox/docker-sandbox-runner';
import { ScriptExecutionService } from './script-execution.service';
import { ScriptExecutionController } from './script-execution.controller';

@Module({
  imports: [AuthModule, AuditModule, CodeboundPersistenceModule, CodeboundGatewayModule],
  controllers: [ScriptExecutionController],
  providers: [ScriptExecutionService, { provide: DockerSandboxRunner, useFactory: () => new DockerSandboxRunner() }],
  exports: [ScriptExecutionService],
})
export class CodeboundExecutionModule {}
