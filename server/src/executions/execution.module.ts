import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { AgentModule } from "../ai/agent/agent.module";
import { AgentManagementModule } from "../agent-management/agent-management.module";
import { IntegrationModule } from "../integrations/integration.module";
import { TracingModule } from "../observability/tracing.module";
import { AgentRunController } from "./agent-run.controller";
import { AgentRunService } from "./agent-run.service";
import { ArtifactModule } from "../artifacts/artifact.module";
import { WorkflowTestService } from "./workflow-test.service";
import { WorkflowTestController } from "./workflow-test.controller";
import { AgentPreviewService } from "./agent-preview.service";
import { AgentPreviewController } from "./agent-preview.controller";
import { InteractionModule } from "../interactions/interaction.module";

@Module({
  imports: [
    AdminModule,
    AgentModule,
    AgentManagementModule,
    IntegrationModule,
    TracingModule,
    ArtifactModule,
    InteractionModule,
  ],
  controllers: [
    AgentRunController,
    WorkflowTestController,
    AgentPreviewController,
  ],
  providers: [AgentRunService, WorkflowTestService, AgentPreviewService],
  exports: [AgentRunService],
})
export class ExecutionModule {}
