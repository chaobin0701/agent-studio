import { ForbiddenException } from '@nestjs/common';
import type { DatabaseService } from '../database.service';

export async function workspaceAccess(db: DatabaseService, adminId: number, workspaceId?: number) {
  const rows = (await db.platformQuery<{id:number;role:string;permission_codes:string[]}>(`SELECT w.id::int,m.role,m.permission_codes
    FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id JOIN admins a ON a.id=m.admin_id
    WHERE m.admin_id=$1 AND a.disabled_at IS NULL AND w.enabled AND ($2::bigint IS NULL OR w.id=$2) ORDER BY w.id LIMIT 1`,[adminId,workspaceId??null])).rows;
  const member=rows[0];
  if (!member) throw new ForbiddenException('没有此工作空间的访问权限，或工作空间已停用');
  const permissions=(await db.platformQuery<{code:string}>('SELECT code FROM permissions ORDER BY code')).rows.map(r=>r.code);
  const permissionCodes=member.role==='owner'?permissions.filter(p=>!platformPermission(p)):
    member.role==='manager'?permissions.filter(p=>!platformPermission(p)):
    member.role==='reader'?permissions.filter(p=>p.endsWith('.read')&&!platformPermission(p)):
    member.permission_codes.filter(p=>permissions.includes(p)&&!platformPermission(p));
  return {workspaceId:member.id,adminId,permissionCodes};
}
export function platformPermission(code:string) {
  return /^(admins|roles|workspaces|observability\.external)\./.test(code);
}
