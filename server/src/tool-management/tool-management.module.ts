import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { ToolManagementController } from "./tool-management.controller";
import { ToolManagementService } from "./tool-management.service";
@Module({
  imports: [AdminModule],
  controllers: [ToolManagementController],
  providers: [ToolManagementService],
  exports: [ToolManagementService],
})
export class ToolManagementModule {}
