import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database.service';
import { adminRoles, rolePermissions } from '../db/schema';
import { AdminRequest } from './admin.types';
import { PERMISSION_KEY } from './permission.decorator';
import { platformPermission } from '../workspaces/workspace-access';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSION_KEY, [
      context.getHandler(), context.getClass(),
    ]);
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<AdminRequest>();
    const adminId = request.admin?.id;
    if (!adminId) throw new ForbiddenException();

    if (required.every(p=>!platformPermission(p))) {
      if (!required.some(p=>request.workspacePermissionCodes?.includes(p))) throw new ForbiddenException('没有此工作空间的操作权限');
      return true;
    }

    const granted = await this.database.db
      .select({ roleId: adminRoles.roleId })
      .from(adminRoles)
      .innerJoin(rolePermissions, eq(adminRoles.roleId, rolePermissions.roleId))
      .where(and(eq(adminRoles.adminId, adminId), inArray(rolePermissions.permissionCode, required)))
      .limit(1);
    if (granted.length === 0) throw new ForbiddenException('Permission denied');
    return true;
  }
}
