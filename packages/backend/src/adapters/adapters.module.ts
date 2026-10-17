import { Module } from '@nestjs/common';
import {
  AdaptersController,
  AdaptersPublicController,
} from './adapters.controller';
import { AdaptersService } from './adapters.service';
import { ConnectorSetupService } from './connector-setup.service';
import { SetupLinksController } from './setup-links.controller';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { LicenseModule } from '../license/license.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { AuthModule } from '../auth/auth.module';
import { CodeboundPersistenceModule } from '../codebound/persistence/codebound-persistence.module';
import { MarketplaceScriptsService } from './marketplace-scripts.service';

@Module({
  imports: [McpServerModule, LicenseModule, McpServersModule, ConnectorsModule, AuthModule, CodeboundPersistenceModule],
  controllers: [AdaptersPublicController, AdaptersController, SetupLinksController],
  providers: [AdaptersService, ConnectorSetupService, MarketplaceScriptsService],
})
export class AdaptersModule {}
