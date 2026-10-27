import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { AgentManagementModule } from "../agent-management/agent-management.module";
import { PromptsModule } from "../prompts/prompts.module";
import { ModelManagementModule } from "../model-management/model-management.module";
import { DocumentModule } from "../documents/document.module";
import { RecordingPolicyModule } from "./recording-policy.module";
import { SystemMcpEndpointController, SystemMcpAdminController } from "./system-mcp.controller";
import { SystemMcpService } from "./system-mcp.service";

@Module({
  imports: [AdminModule, AgentManagementModule, PromptsModule, ModelManagementModule, DocumentModule, RecordingPolicyModule],
  controllers: [SystemMcpEndpointController, SystemMcpAdminController],
  providers: [SystemMcpService],
})
export class SystemMcpModule {}
