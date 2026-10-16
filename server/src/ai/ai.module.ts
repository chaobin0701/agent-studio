import { ModelManagementModule } from '../model-management/model-management.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { AdminModule } from '../admin/admin.module';
import { ProviderRegistry } from './providers/provider-registry';
import { LLM_PROVIDER } from './providers/llm-provider';
import { LlmProfileController } from './providers/llm-profile.controller';
import { LlmProfileService } from './providers/llm-profile.service';

@Module({
  imports: [ConfigModule, AdminModule, ModelManagementModule],
  controllers: [LlmProfileController],
  providers: [
    ProviderRegistry,
    LlmProfileService,
    {
      provide: LLM_PROVIDER,
      useFactory: (registry: ProviderRegistry) => registry.createLlmProvider(),
      inject: [ProviderRegistry],
    },
  ],
  exports: [LLM_PROVIDER, ProviderRegistry, LlmProfileService, ModelManagementModule],
})
export class AiModule {}
