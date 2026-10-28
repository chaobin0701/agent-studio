import { Module } from "@nestjs/common";
import { AdminModule } from "./admin/admin.module";
import { ChatModule } from "./chat/chat.module";
import { ConfigModule } from "./config/config.module";
import { DocumentModule } from "./documents/document.module";
import { HealthController } from "./health.controller";
import { SecurityModule } from "./security/security.module";
import { MessageBusModule } from "./message-bus/message-bus.module";
import { PromptsModule } from "./prompts/prompts.module";
import { ExecutionModule } from "./executions/execution.module";
@Module({
  imports: [
    ConfigModule,
    SecurityModule,
    MessageBusModule,
    AdminModule,
    DocumentModule,
    ChatModule,
    PromptsModule,
    ExecutionModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
