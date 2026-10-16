import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database.service';
import { CreateAdminDto } from './auth.dto';
import { AssignRolesDto, CreateRoleDto, UpdateRoleDto } from './management.dto';
import { platformPermission } from '../workspaces/workspace-access';

type DbError = { code?: string };
type RoleGrantRow = { id: string; is_system: boolean; permission_code: string | null };

@Injectable()
export class AdminManagementService {
  constructor(private readonly database: DatabaseService) {}

  async listPermissions() {
    const result = await this.database.query<{ code: string; description: string }>(
      'SELECT code, description FROM permissions ORDER BY code',
    );
    return result.rows;
  }

  async listRoles() {
    const result = await this.database.query<{
      id: number; code: string; name: string; isSystem: boolean; permissionCodes: string[];
    }>(`SELECT r.id::int AS id, r.code, r.name, r.is_system AS "isSystem",
              COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code)
                FILTER (WHERE rp.permission_code IS NOT NULL), ARRAY[]::varchar[]) AS "permissionCodes"
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
       GROUP BY r.id ORDER BY r.id`);
    return result.rows;
  }

  async createRole(actorId: number, input: CreateRoleDto) {
    try {
      return await this.database.transaction(async (client) => {
        await this.lockManagement(client);
        await this.requireActorPermission(client, actorId, 'roles.manage');
        await this.validatePermissionCodes(client, input.permissionCodes);
        await this.requireGrantSubset(client, actorId, input.permissionCodes);

        const created = await client.query<{ id: string }>(
          'INSERT INTO roles (code, name) VALUES ($1, $2) RETURNING id',
          [input.code, input.name.trim()],
        );
        const roleId = Number(created.rows[0].id);
        await this.replaceRolePermissions(client, roleId, input.permissionCodes);
        await this.audit(client, actorId, 'role.created', 'role', roleId, { code: input.code });
        return { id: roleId, code: input.code, name: input.name.trim(), permissionCodes: input.permissionCodes };
      });
    } catch (error) {
      if ((error as DbError).code === '23505') throw new ConflictException('Role code already exists');
      throw error;
    }
  }

  async updateRole(actorId: number, roleId: number, input: UpdateRoleDto) {
    return this.database.transaction(async (client) => {
      await this.lockManagement(client);
      await this.requireActorPermission(client, actorId, 'roles.manage');
      const existing = await client.query<{ code: string; is_system: boolean }>(
        'SELECT code, is_system FROM roles WHERE id = $1 FOR UPDATE', [roleId],
      );
      if (!existing.rows[0]) throw new NotFoundException('Role not found');
      if (existing.rows[0].is_system) throw new ForbiddenException('System role cannot be changed');
      await this.validatePermissionCodes(client, input.permissionCodes);
      await this.requireGrantSubset(client, actorId, input.permissionCodes);

      await client.query('UPDATE roles SET name = $1 WHERE id = $2', [input.name.trim(), roleId]);
      await this.replaceRolePermissions(client, roleId, input.permissionCodes);
      await this.audit(client, actorId, 'role.updated', 'role', roleId, { permissionCodes: input.permissionCodes });
      return { id: roleId, code: existing.rows[0].code, name: input.name.trim(), permissionCodes: input.permissionCodes };
    });
  }

  async listAdmins() {
    const result = await this.database.query<{
      id: number; email: string | null; username: string | null; displayName: string; disabledAt: Date | null; roles: { id: number; code: string }[];
    }>(`SELECT a.id::int AS id, a.email, a.username, a.display_name AS "displayName", a.disabled_at AS "disabledAt",
              COALESCE(json_agg(json_build_object('id', r.id::int, 'code', r.code) ORDER BY r.id)
                FILTER (WHERE r.id IS NOT NULL), '[]'::json) AS roles
       FROM admins a LEFT JOIN admin_roles ar ON ar.admin_id = a.id
       LEFT JOIN roles r ON r.id = ar.role_id
       GROUP BY a.id ORDER BY a.id`);
    return result.rows;
  }

  async createAdmin(actorId: number, input: CreateAdminDto) {
    this.validatePassword(input.password);
    const passwordHash = await hash(input.password, 12);
    const email = input.email?.trim().toLowerCase() || null;
    const username = input.username?.trim().toLowerCase() || null;
    if (!email && !username) throw new BadRequestException('Email or username is required');
    try {
      return await this.database.transaction(async (client) => {
        await this.lockManagement(client);
        await this.requireActorPermission(client, actorId, 'admins.manage');
        await this.validateAssignableRoles(client, actorId, input.roleIds);

        const created = await client.query<{ id: string }>(
          'INSERT INTO admins (email, password_hash, display_name, username) VALUES ($1, $2, $3, $4) RETURNING id',
          [email, passwordHash, input.displayName.trim(), username],
        );
        const adminId = Number(created.rows[0].id);
        await this.replaceAdminRoles(client, adminId, input.roleIds);
        await this.audit(client, actorId, 'admin.created', 'admin', adminId, { roleIds: input.roleIds });
        return { id: adminId, email, username, displayName: input.displayName.trim(), roleIds: input.roleIds };
      });
    } catch (error) {
      if ((error as DbError).code === '23505') throw new ConflictException('Email or username already exists');
      throw error;
    }
  }

  async assignRoles(actorId: number, targetId: number, input: AssignRolesDto) {
    return this.database.transaction(async (client) => {
      await this.lockManagement(client);
      await this.requireActorPermission(client, actorId, 'admins.manage');
      const target = await client.query<{ disabled_at: Date | null }>(
        'SELECT disabled_at FROM admins WHERE id = $1 FOR UPDATE', [targetId],
      );
      if (!target.rows[0]) throw new NotFoundException('Administrator not found');
      await this.validateAssignableRoles(client, actorId, input.roleIds);

      const hadSuperRole = await this.hasSuperRole(client, targetId);
      const superRole = await client.query<{ id: string }>("SELECT id FROM roles WHERE code = 'super_admin'");
      const keepsSuperRole = input.roleIds.includes(Number(superRole.rows[0].id));
      if (hadSuperRole && !keepsSuperRole && !target.rows[0].disabled_at) {
        await this.requireAnotherActiveSuperAdmin(client, targetId);
      }

      await this.replaceAdminRoles(client, targetId, input.roleIds);
      await this.audit(client, actorId, 'admin.roles_updated', 'admin', targetId, { roleIds: input.roleIds });
      return { id: targetId, roleIds: input.roleIds };
    });
  }

  async setStatus(actorId: number, targetId: number, disabled: boolean) {
    return this.database.transaction(async (client) => {
      await this.lockManagement(client);
      await this.requireActorPermission(client, actorId, 'admins.manage');
      const target = await client.query<{ disabled_at: Date | null }>(
        'SELECT disabled_at FROM admins WHERE id = $1 FOR UPDATE', [targetId],
      );
      if (!target.rows[0]) throw new NotFoundException('Administrator not found');
      if (disabled && actorId === targetId) throw new ConflictException('Cannot disable your own account');
      if (disabled && !target.rows[0].disabled_at && await this.hasSuperRole(client, targetId)) {
        await this.requireAnotherActiveSuperAdmin(client, targetId);
      }

      await client.query(
        'UPDATE admins SET disabled_at = CASE WHEN $1::boolean THEN now() ELSE NULL END WHERE id = $2',
        [disabled, targetId],
      );
      await this.audit(client, actorId, disabled ? 'admin.disabled' : 'admin.enabled', 'admin', targetId, {});
      return { id: targetId, disabled };
    });
  }

  async setPassword(actorId: number, targetId: number, password: string) {
    if (typeof password !== 'string' || password.length < 10 || password.length > 72) throw new BadRequestException('密码需为 10–72 个字符');
    this.validatePassword(password);
    return this.database.platformTransaction(async client => {
      await this.lockManagement(client);
      await this.requireActorPermission(client, actorId, 'admins.manage');
      if (!(await this.hasSuperRole(client, actorId))) throw new ForbiddenException('只有超级管理员可以修改用户密码');
      const target = await client.query('SELECT id FROM admins WHERE id=$1 FOR UPDATE', [targetId]);
      if (!target.rowCount) throw new NotFoundException('账号不存在');
      const passwordHash = await hash(password, 12);
      await client.query('UPDATE admins SET password_hash=$2,session_version=session_version+1 WHERE id=$1', [targetId, passwordHash]);
      // Never put plaintext, hash or request body in the audit record.
      await this.audit(client, actorId, 'admin.password_updated', 'admin', targetId, { sessionsRevoked: true });
      return { id: targetId, sessionsRevoked: true };
    });
  }

  async userWorkspaces(actorId: number, targetId: number) {
    return this.database.platformTransaction(async client => {
      await this.requireActorPermission(client, actorId, 'admins.manage');
      if (!(await client.query('SELECT id FROM admins WHERE id=$1', [targetId])).rowCount) throw new NotFoundException('账号不存在');
      const workspaces = (await client.query(`SELECT w.id::int,w.name,w.enabled,m.role,m.permission_codes AS "permissionCodes"
        FROM workspaces w JOIN workspace_members own ON own.workspace_id=w.id AND own.admin_id=$1 AND own.role='owner'
        LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.admin_id=$2 ORDER BY w.id`, [actorId, targetId])).rows;
      const permissions = (await client.query<{ code: string; description: string }>('SELECT code,description FROM permissions ORDER BY code')).rows.filter(p => !platformPermission(p.code));
      return { workspaces, permissions };
    });
  }

  async listAudit(limit: number) {
    const result = await this.database.query<{
      id: number; actorAdminId: number; action: string; targetType: string; targetId: string; details: object; createdAt: Date;
    }>(`SELECT id::int AS id, actor_admin_id::int AS "actorAdminId", action,
              target_type AS "targetType", target_id AS "targetId", details, created_at AS "createdAt"
       FROM audit_logs ORDER BY id DESC LIMIT $1`, [limit]);
    return result.rows;
  }

  private async lockManagement(client: PoolClient): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(837076176)');
  }

  private async requireActorPermission(client: PoolClient, actorId: number, required: string): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM admins a JOIN admin_roles ar ON ar.admin_id = a.id
       JOIN role_permissions rp ON rp.role_id = ar.role_id
       WHERE a.id = $1 AND a.disabled_at IS NULL AND rp.permission_code = $2 LIMIT 1`,
      [actorId, required],
    );
    if (result.rowCount === 0) throw new ForbiddenException('Permission denied');
  }

  private async effectivePermissions(client: PoolClient, actorId: number): Promise<Set<string>> {
    const result = await client.query<{ permission_code: string }>(
      `SELECT DISTINCT rp.permission_code FROM admin_roles ar
       JOIN role_permissions rp ON rp.role_id = ar.role_id WHERE ar.admin_id = $1`, [actorId],
    );
    return new Set(result.rows.map((row) => row.permission_code));
  }

  private async requireGrantSubset(client: PoolClient, actorId: number, codes: string[]): Promise<void> {
    const owned = await this.effectivePermissions(client, actorId);
    if (codes.some((code) => !owned.has(code))) {
      throw new ForbiddenException('Cannot grant a permission you do not have');
    }
  }

  private async validatePermissionCodes(client: PoolClient, codes: string[]): Promise<void> {
    if (codes.length === 0) return;
    const result = await client.query<{ code: string }>(
      'SELECT code FROM permissions WHERE code = ANY($1::varchar[])', [codes],
    );
    if (result.rows.length !== codes.length) throw new BadRequestException('Unknown permission code');
  }

  private async validateAssignableRoles(client: PoolClient, actorId: number, roleIds: number[]): Promise<void> {
    if (roleIds.length === 0) return;
    const result = await client.query<RoleGrantRow>(
      `SELECT r.id, r.is_system, rp.permission_code FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.id = ANY($1::bigint[])`, [roleIds],
    );
    const found = new Set(result.rows.map((row) => Number(row.id)));
    if (found.size !== roleIds.length) throw new BadRequestException('Unknown role ID');
    if (result.rows.some((row) => row.is_system) && !(await this.hasSuperRole(client, actorId))) {
      throw new ForbiddenException('Only a super administrator can assign system roles');
    }
    await this.requireGrantSubset(client, actorId, result.rows.flatMap((row) => row.permission_code ? [row.permission_code] : []));
  }

  private async hasSuperRole(client: PoolClient, adminId: number): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM admin_roles ar JOIN roles r ON r.id = ar.role_id
       WHERE ar.admin_id = $1 AND r.code = 'super_admin' LIMIT 1`, [adminId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async requireAnotherActiveSuperAdmin(client: PoolClient, excludingId: number): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM admins a JOIN admin_roles ar ON ar.admin_id = a.id
       JOIN roles r ON r.id = ar.role_id
       WHERE a.id <> $1 AND a.disabled_at IS NULL AND r.code = 'super_admin' LIMIT 1`, [excludingId],
    );
    if (result.rowCount === 0) throw new ConflictException('At least one active super administrator is required');
  }

  private async replaceRolePermissions(client: PoolClient, roleId: number, codes: string[]): Promise<void> {
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
    if (codes.length > 0) {
      await client.query(
        'INSERT INTO role_permissions (role_id, permission_code) SELECT $1, unnest($2::varchar[])',
        [roleId, codes],
      );
    }
  }

  private async replaceAdminRoles(client: PoolClient, adminId: number, roleIds: number[]): Promise<void> {
    await client.query('DELETE FROM admin_roles WHERE admin_id = $1', [adminId]);
    if (roleIds.length > 0) {
      await client.query('INSERT INTO admin_roles (admin_id, role_id) SELECT $1, unnest($2::bigint[])', [adminId, roleIds]);
    }
  }

  private async audit(client: PoolClient, actorId: number, action: string, targetType: string, targetId: number, details: object): Promise<void> {
    await client.query(
      'INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5)',
      [actorId, action, targetType, String(targetId), JSON.stringify(details)],
    );
  }

  private validatePassword(password: string): void {
    if (Buffer.byteLength(password, 'utf8') > 72) {
      throw new BadRequestException('Password is too long for the selected hash algorithm');
    }
  }
}
