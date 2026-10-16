import { BadRequestException, CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database.service';
import { admins } from '../db/schema';
import { AdminRequest } from './admin.types';
import { AppConfigService } from '../config/config.service';
import { workspaceAccess } from '../workspaces/workspace-access';
import { selectWorkspace } from '../workspaces/workspace-context';
import { sessionVersionMatches } from './session-version';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly database: DatabaseService, private readonly config: AppConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!token) throw new UnauthorizedException('Authentication is required');

    let subject: string;
    let sessionVersion: unknown;
    try {
      const claims = await this.jwt.verifyAsync<{ sub: string; sessionVersion?: number }>(token, {
        issuer: this.config.jwt.issuer,
        audience: this.config.jwt.audience,
      });
      subject = claims.sub;
      sessionVersion = claims.sessionVersion;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const adminId = Number(subject);
    if (!Number.isSafeInteger(adminId) || adminId <= 0) {
      throw new UnauthorizedException('Invalid token subject');
    }

    const [admin] = await this.database.db
      .select({ id: admins.id, email: admins.email, username: admins.username, displayName: admins.displayName, disabledAt: admins.disabledAt, sessionVersion: admins.sessionVersion })
      .from(admins)
      .where(eq(admins.id, adminId))
      .limit(1);

    if (!admin || admin.disabledAt) throw new UnauthorizedException('Administrator is unavailable');
    if (!sessionVersionMatches(sessionVersion, admin.sessionVersion ?? 0)) throw new UnauthorizedException('密码已修改，请重新登录');
    request.admin = { id: admin.id, email: admin.email, username: admin.username, displayName: admin.displayName };
    // Platform workspace lifecycle endpoints are available even without a membership.
    if (request.path?.startsWith('/api/admin/workspaces')) return true;
    // Global account/role endpoints are still checked by PermissionGuard and do
    // not require a workspace membership to administer newly created accounts.
    if (/^\/api\/admin\/(?:admins(?:\/|$)|roles(?:\/|$)|permissions$)/.test(request.path ?? '')) return true;
    const header=request.headers['x-workspace-id'];
    const workspaceId=header===undefined?undefined:Number(header);
    if (header!==undefined && (typeof header!=='string'||!/^\d+$/.test(header)||!Number.isSafeInteger(workspaceId)||(workspaceId ?? 0)<=0))
      throw new BadRequestException('工作空间 ID 无效');
    if (header===undefined && request.path==='/api/admin/auth/me') return true;
    const access=await workspaceAccess(this.database,admin.id,workspaceId);
    request.workspaceId=access.workspaceId;
    request.workspacePermissionCodes=access.permissionCodes;
    selectWorkspace(access.workspaceId,access);
    return true;
  }
}
