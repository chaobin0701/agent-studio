import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthService } from './admin-auth.service';
import { AdminManagementController } from './admin-management.controller';
import { AdminManagementService } from './admin-management.service';
import { PermissionGuard } from './permission.guard';
import { DatabaseService } from '../database.service';
import { AppConfigService } from '../config/config.service';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { WorkspaceController } from '../workspaces/workspace.controller';
import { WorkspaceService } from '../workspaces/workspace.service';
import { ManagementOverviewService } from './management-overview.service';

@Module({
  imports: [JwtModule.registerAsync({
    inject: [AppConfigService],
    useFactory: (config: AppConfigService) => {
      const secret = config.jwt.secret;
      if (!secret || Buffer.byteLength(secret, 'utf8') < 32) throw new Error('JWT_SECRET must be at least 32 bytes');
      return {
        secret,
        signOptions: { expiresIn: config.jwt.expiresInSeconds, issuer: config.jwt.issuer, audience: config.jwt.audience },
      };
    },
  })],
  controllers: [AdminAuthController, AdminManagementController, AdminDashboardController, WorkspaceController],
  providers: [DatabaseService, AdminAuthService, AdminManagementService, AdminAuthGuard, PermissionGuard, AdminDashboardService, WorkspaceService, ManagementOverviewService],
  exports: [JwtModule, DatabaseService, AdminAuthGuard, PermissionGuard],
})
export class AdminModule {}
