import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { AgentManagementModule } from "../agent-management/agent-management.module";
import { IntegrationModule } from "../integrations/integration.module";
import { ExecutionModule } from "../executions/execution.module";
import { ChatModule } from "../chat/chat.module";
import { ArtifactModule } from "../artifacts/artifact.module";
import {
  AdminChatbotController,
  WebsiteChatbotController,
} from "./chatbot.controller";
import { ChatbotService } from "./chatbot.service";
import { ChatbotAttachmentService } from "./chatbot-attachment.service";
@Module({
  imports: [
    AdminModule,
    AgentManagementModule,
    IntegrationModule,
    ExecutionModule,
    ChatModule,
    ArtifactModule,
  ],
  controllers: [AdminChatbotController, WebsiteChatbotController],
  providers: [ChatbotService, ChatbotAttachmentService],
  exports: [ChatbotService],
})
export class ChatbotModule {}
