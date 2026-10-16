import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../database.service';
import { admins } from '../db/schema';
import { AdminLoginDto } from './auth.dto';
import { AdminPrincipal } from './admin.types';
import { AppConfigService } from '../config/config.service';
import { workspaceContext } from '../workspaces/workspace-context';
import { platformPermission } from '../workspaces/workspace-access';

@Injectable()
export class AdminAuthService {
  constructor(private readonly database: DatabaseService, private readonly jwt: JwtService, private readonly config: AppConfigService) {}

  async me(admin: AdminPrincipal) {
    const [roles, permissions] = await Promise.all([
      this.database.query<{ id: number; code: string; name: string }>(
        `SELECT r.id::int AS id, r.code, r.name FROM roles r
         JOIN admin_roles ar ON ar.role_id = r.id WHERE ar.admin_id = $1 ORDER BY r.id`, [admin.id],
      ),
      this.database.query<{ code: string }>(
        `SELECT DISTINCT rp.permission_code AS code FROM admin_roles ar
         JOIN role_permissions rp ON rp.role_id = ar.role_id
         WHERE ar.admin_id = $1 ORDER BY code`, [admin.id],
      ),
    ]);
    const workspace=workspaceContext.getStore();
    return { ...admin, roles: roles.rows, workspaceId:workspace?.permissionCodes?workspace.workspaceId:null,
      permissionCodes: [...(workspace?.permissionCodes??[]),...permissions.rows.map(r=>r.code).filter(platformPermission)] };
  }

  async login(input: AdminLoginDto) {
    const email = input.email.trim().toLowerCase();
    const [admin] = await this.database.db
      .select({ id: admins.id, email: admins.email, username: admins.username, passwordHash: admins.passwordHash, sessionVersion: admins.sessionVersion, displayName: admins.displayName, disabledAt: admins.disabledAt })
      .from(admins)
      .where(sql`lower(${admins.email}) = ${email} OR lower(${admins.username}) = ${email}`)
      .limit(1);

    if (!admin || admin.disabledAt || !(await compare(input.password, admin.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return {
      accessToken: await this.jwt.signAsync({ sub: String(admin.id), sessionVersion: admin.sessionVersion ?? 0 }),
      tokenType: 'Bearer',
      expiresIn: this.config.jwt.expiresInSeconds,
      admin: { id: admin.id, email: admin.email, username: admin.username, displayName: admin.displayName },
    };
  }
}
