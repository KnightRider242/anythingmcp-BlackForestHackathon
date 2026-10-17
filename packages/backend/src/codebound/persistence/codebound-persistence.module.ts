// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { CodeboundGatewayModule } from '../gateway/codebound-gateway.module';
import { ScriptPersistenceService } from './script-persistence.service';

@Module({
  imports: [PrismaModule, CodeboundGatewayModule],
  providers: [ScriptPersistenceService],
  exports: [ScriptPersistenceService],
})
export class CodeboundPersistenceModule {}
