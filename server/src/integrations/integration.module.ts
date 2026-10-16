import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AdminIntegrationController, WidgetSessionController } from './integration.controller';
import { IntegrationService } from './integration.service';
import { AgentAccessGuard, LegacyWebsiteGuard } from './integration.guards';
import { IntegrationTokenService } from './integration-token.service';

@Module({
  imports: [AdminModule],
  controllers: [AdminIntegrationController, WidgetSessionController],
  providers: [IntegrationService, IntegrationTokenService, AgentAccessGuard, LegacyWebsiteGuard],
  exports: [IntegrationService, AgentAccessGuard, LegacyWebsiteGuard],
})
export class IntegrationModule {}
