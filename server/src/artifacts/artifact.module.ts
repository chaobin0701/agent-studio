import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { IntegrationModule } from "../integrations/integration.module";
import { ExecutionArtifactService } from "./execution-artifact.service";
import {
  AdminArtifactController,
  AgentArtifactController,
} from "./artifact.controller";

@Module({
  imports: [AdminModule, IntegrationModule],
  controllers: [AdminArtifactController, AgentArtifactController],
  providers: [ExecutionArtifactService],
  exports: [ExecutionArtifactService],
})
export class ArtifactModule {}
