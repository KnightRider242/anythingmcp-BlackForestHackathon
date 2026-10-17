// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../../connectors/connectors.module';
import { RolesModule } from '../../roles/roles.module';
import { McpServersModule } from '../../mcp-servers/mcp-servers.module';
import { LicenseModule } from '../../license/license.module';
import { PrismaModule } from '../../common/prisma.module';
import { BoundReadAuthorization } from './bound-read-authorization.service';
import { BoundRestExecutor } from './bound-rest-executor.service';
import { AuthorizedConnectorGatewayService } from './authorized-connector-gateway.service';

/** Import from lifecycle integration; deliberately adds no public endpoint. */
@Module({
  imports: [PrismaModule, ConnectorsModule, RolesModule, McpServersModule, LicenseModule],
  providers: [BoundReadAuthorization, BoundRestExecutor, AuthorizedConnectorGatewayService],
  exports: [AuthorizedConnectorGatewayService],
})
export class CodeboundGatewayModule {}
