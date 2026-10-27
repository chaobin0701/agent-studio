import { AdminExecutionController } from '../observability/admin-execution.controller';
import { AgentManagementModule } from '../agent-management/agent-management.module';
import { Module } from '@nestjs/common';
import { ArtifactModule } from '../artifacts/artifact.module';
import { DocumentModule } from '../documents/document.module';
import { AdminModule } from '../admin/admin.module';
import { AdminChatTraceController } from './admin-chat-trace.controller';
import { AdminConversationController } from './admin-conversation.controller';
import { AdminConversationService } from './admin-conversation.service';
import { AdminDebugController } from './admin-debug.controller';
import { AdminDebugService } from './admin-debug.service';
import { ChatController } from './chat.controller';
import { ChatRateLimitService } from './chat-rate-limit.service';
import { ChatService } from './chat.service';
import { ConversationService } from './conversation.service';
import { ChatOrchestratorService } from './chat-orchestrator.service';
import { AgentModule } from '../ai/agent/agent.module';
import { ChatApplicationService } from './chat-application.service';
import { SkillsModule } from '../ai/skills/skills.module';
import { AdminAgentConfigController } from './admin-agent-config.controller';
import { AgentSettingsService } from '../config/agent-settings.service';
import { IntegrationModule } from '../integrations/integration.module';
import { IntegrationChatGateway } from './integration-chat.gateway';
import { AgentApiController } from './agent-api.controller';
import { ContextMemoryService } from './context-memory.service';
import { PromptsModule } from '../prompts/prompts.module';
import { InteractionModule } from '../interactions/interaction.module';
import { RecordingPolicyModule } from '../system-mcp/recording-policy.module';

@Module({
  imports: [ArtifactModule, AgentManagementModule, DocumentModule, AdminModule, AgentModule, SkillsModule, IntegrationModule, PromptsModule,InteractionModule, RecordingPolicyModule],
  controllers: [AdminExecutionController, ChatController, AgentApiController, AdminChatTraceController, AdminConversationController, AdminDebugController, AdminAgentConfigController],
  providers: [ChatService, ChatRateLimitService, ConversationService, ChatOrchestratorService, ChatApplicationService, AdminDebugService, AdminConversationService, AgentSettingsService, IntegrationChatGateway, ContextMemoryService],
  exports:[ConversationService],
})
export class ChatModule {}
