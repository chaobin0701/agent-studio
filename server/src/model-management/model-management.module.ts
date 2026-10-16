import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { ConfigModule } from "../config/config.module";
import { ModelManagementService } from "./model-management.service";
import {
  ModelManagementController,
  ModelManagementPermissionGuard,
} from "./model-management.controller";
@Module({
  imports: [AdminModule, ConfigModule],
  controllers: [ModelManagementController],
  providers: [ModelManagementService, ModelManagementPermissionGuard],
  exports: [ModelManagementService],
})
export class ModelManagementModule {}
