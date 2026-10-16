import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database.service';
import { platformPermission, workspaceAccess } from './workspace-access';
import { inWorkspace } from './workspace-context';
import { copyWorkspaceResource } from './workspace-copy';

const input=z.object({name:z.string().trim().min(1).max(120),description:z.string().max(2000).default('')}).strict();
@Injectable()
export class WorkspaceService {
  constructor(private readonly db:DatabaseService) {}
  async list(adminId:number) {
    return (await this.db.platformQuery(`SELECT w.id::int,w.name,w.description,w.enabled,w.created_at AS "createdAt",m.role
      FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.admin_id=$1 ORDER BY w.id`,[adminId])).rows;
  }
  private async owner(adminId:number,id:number) {
    const row=(await this.db.platformQuery('SELECT role FROM workspace_members WHERE workspace_id=$1 AND admin_id=$2',[id,adminId])).rows[0];
    if(row?.role!=='owner') throw new ForbiddenException('只有空间所有者可以管理成员和状态');
  }
  async create(adminId:number,body:unknown) {
    const parsed=input.safeParse(body);if(!parsed.success)throw new BadRequestException('请填写名称和描述');
    // The workspace and first owner are created together. Subsequent resources use RLS.
    return this.db.platformTransaction(async c=> {
    const row=(await c.query(`WITH w AS (INSERT INTO workspaces(name,description,created_by) VALUES($1,$2,$3) RETURNING id)
      INSERT INTO workspace_members(workspace_id,admin_id,role) SELECT id,$3,'owner' FROM w RETURNING workspace_id::int AS id`,[parsed.data.name,parsed.data.description,adminId])).rows[0];
    await c.query("INSERT INTO knowledge_bases(workspace_id,name,description,is_default) VALUES($1,'默认知识库','',true)",[row.id]);
    await c.query("INSERT INTO audit_logs(workspace_id,actor_admin_id,action,target_type,target_id) VALUES($1,$2,'workspace.created','workspace',$3)",[row.id,adminId,String(row.id)]);
    return row;
    });
  }
  async members(adminId:number,id:number) {
    await this.owner(adminId,id);
    return (await this.db.platformQuery(`SELECT a.id::int,a.display_name AS "displayName",a.email,a.username,m.role,m.permission_codes AS "permissionCodes"
      FROM workspace_members m JOIN admins a ON a.id=m.admin_id WHERE m.workspace_id=$1 ORDER BY a.id`,[id])).rows;
  }
  async updateInfo(adminId:number,id:number,body:unknown) {
    const parsed=input.extend({expected:z.object({name:z.string(),description:z.string()}).strict()}).strict().safeParse(body);
    if(!parsed.success)throw new BadRequestException('请填写有效的工作区名称和描述');
    const {name,description,expected}=parsed.data;
    return this.db.platformTransaction(async c=>{
      // Lock the target membership; a concurrent revoke cannot race the write.
      const owner=await c.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND admin_id=$2 AND role='owner' FOR SHARE",[id,adminId]);
      if(!owner.rowCount)throw new ForbiddenException('只有工作区所有者可以修改基本信息');
      const row=(await c.query('UPDATE workspaces SET name=$2,description=$3 WHERE id=$1 AND name=$4 AND description=$5 RETURNING id::int,name,description', [id,name,description,expected.name,expected.description])).rows[0];
      if(!row)throw new ConflictException('工作区信息已被其他管理员修改，请刷新后重试');
      await this.audit(c,adminId,id,'workspace.info_updated',{name,description});
      return row;
    });
  }
  async setMember(adminId:number,id:number,body:unknown) {
    await this.owner(adminId,id);
    const p=z.object({adminId:z.number().int().positive(),role:z.enum(['owner','manager','reader','custom']),permissionCodes:z.array(z.string()).max(100).default([])}).strict().safeParse(body);
    if(!p.success)throw new BadRequestException('成员授权无效');
    if(p.data.adminId===adminId&&p.data.role!=='owner')throw new ConflictException('不能撤销自己的所有者权限');
    if(!(await this.db.platformQuery('SELECT id FROM admins WHERE id=$1 AND disabled_at IS NULL',[p.data.adminId])).rowCount)throw new NotFoundException('账号不存在');
    const all=(await this.db.platformQuery<{code:string}>('SELECT code FROM permissions')).rows.map(r=>r.code);
    if(p.data.permissionCodes.some(c=>!all.includes(c)||platformPermission(c)))throw new BadRequestException('只能选择有效的工作区业务权限');
    await this.db.platformTransaction(async c=>{
    await c.query(`INSERT INTO workspace_members(workspace_id,admin_id,role,permission_codes) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id,admin_id) DO UPDATE SET role=EXCLUDED.role,permission_codes=EXCLUDED.permission_codes`,[id,p.data.adminId,p.data.role,p.data.permissionCodes]);
    await this.audit(c,adminId,id,'workspace.member_updated',{memberId:p.data.adminId,role:p.data.role,permissionCodes:p.data.permissionCodes});
    });
    return {ok:true};
  }
  async removeMember(adminId:number,id:number,memberId:number) {
    await this.owner(adminId,id);
    if(memberId===adminId)throw new ConflictException('不能移除自己');
    await this.db.platformTransaction(async c=>{
    await c.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND admin_id=$2',[id,memberId]);
    await this.audit(c,adminId,id,'workspace.member_removed',{memberId});
    });
    return {ok:true};
  }
  async memberOptions(adminId:number,id:number) {
    await this.owner(adminId,id);
    const [accounts,permissions] = await Promise.all([
      this.db.platformQuery('SELECT id::int,display_name AS "displayName",username,email FROM admins WHERE disabled_at IS NULL ORDER BY display_name,id'),
      this.db.platformQuery<{code:string;description:string}>('SELECT code,description FROM permissions ORDER BY code'),
    ]);
    return {accounts:accounts.rows,permissions:permissions.rows.filter(p=>!platformPermission(p.code))};
  }
  async status(adminId:number,id:number,enabled:boolean) {
    await this.owner(adminId,id);
    if(typeof enabled!=='boolean')throw new BadRequestException('需要 enabled');
    await this.db.platformTransaction(async c=>{
    await c.query('UPDATE workspaces SET enabled=$2 WHERE id=$1',[id,enabled]);
    await this.audit(c,adminId,id,'workspace.status_updated',{enabled});
    });
    return {ok:true};
  }
  private async audit(c:Pick<DatabaseService,'query'>,actor:number,id:number,action:string,details:unknown){
    await c.query("INSERT INTO audit_logs(workspace_id,actor_admin_id,action,target_type,target_id,details) VALUES($1,$2,$3,'workspace',$4,$5)",[id,actor,action,String(id),JSON.stringify(details)]);
  }
  async access(adminId:number,id:number) { return workspaceAccess(this.db,adminId,id); }
  async settings(adminId:number,id:number) {
    const access=await workspaceAccess(this.db,adminId,id);
    const workspace=(await this.db.platformQuery('SELECT default_embedding_plan_version_id::int AS "defaultEmbeddingPlanVersionId" FROM workspaces WHERE id=$1',[id])).rows[0];
    return inWorkspace(id,async()=>({...workspace,canManage:access.permissionCodes.includes('embedding_profiles.manage'),
      embeddingPlans:access.permissionCodes.includes('embedding_profiles.read') || access.permissionCodes.includes('embedding_profiles.manage') ?
        (await this.db.query(`SELECT v.id::int,e.id::int AS "profileId",p.name,v.version FROM model_plan_versions v
          JOIN model_plans p ON p.id=v.plan_id JOIN embedding_profiles e ON e.model_plan_version_id=v.id
          WHERE p.kind='embedding' AND v.status='published' AND e.enabled ORDER BY p.name,v.version DESC`)).rows : []}));
  }
  async saveSettings(adminId:number,id:number,body:unknown) {
    const access=await workspaceAccess(this.db,adminId,id);
    if(!access.permissionCodes.includes('embedding_profiles.manage'))throw new ForbiddenException('需要此工作区的向量模型管理权限');
    const value=z.object({defaultEmbeddingPlanVersionId:z.number().int().positive().nullable(),expectedDefaultEmbeddingPlanVersionId:z.number().int().positive().nullable().optional()}).strict().safeParse(body);
    if(!value.success)throw new BadRequestException('请选择已发布的向量模型方案');
    return inWorkspace(id,()=>this.db.transaction(async c=>{
      const selected=value.data.defaultEmbeddingPlanVersionId;
      if(selected && !(await c.query("SELECT 1 FROM embedding_profiles e JOIN model_plan_versions v ON v.id=e.model_plan_version_id JOIN model_plans p ON p.id=v.plan_id WHERE v.id=$1 AND v.status='published' AND p.kind='embedding' AND e.enabled",[selected])).rowCount)
        throw new BadRequestException('方案必须已发布且属于此工作区');
      const row=await c.query('UPDATE workspaces SET default_embedding_plan_version_id=$2 WHERE id=$1 AND ($3::boolean OR default_embedding_plan_version_id IS NOT DISTINCT FROM $4::bigint) RETURNING default_embedding_plan_version_id::int AS "defaultEmbeddingPlanVersionId"',[id,selected,value.data.expectedDefaultEmbeddingPlanVersionId===undefined,value.data.expectedDefaultEmbeddingPlanVersionId??null]);
      if(!row.rowCount)throw new ConflictException('工作区默认模型已被其他管理员修改，请刷新后重试');
      await this.audit(c,adminId,id,'workspace.embedding_default_updated',{defaultEmbeddingPlanVersionId:selected});
      return row.rows[0];
    }));
  }
  async copy(adminId:number,id:number,body:unknown){return copyWorkspaceResource(this.db,adminId,id,body);}
  async copyOptions(adminId:number,id:number){
    const access=await workspaceAccess(this.db,adminId,id);
    return inWorkspace(id,async()=>{
      const rows=[];
      if(access.permissionCodes.includes('agent_config.read')) rows.push(...(await this.db.query("SELECT id::int,kind,name,resource_key AS key FROM agent_resources WHERE kind IN ('agent','skill','tool') AND archived_at IS NULL AND deleted_at IS NULL ORDER BY id")).rows);
      if(access.permissionCodes.includes('prompts.read')) rows.push(...(await this.db.query("SELECT id::int,'prompt' AS kind,name,prompt_key AS key FROM prompt_resources WHERE prompt_key<>'conversation.summary'")).rows);
      rows.push(...(await this.db.query("SELECT v.id::int,'model' AS kind,p.name||' · v'||v.version AS name FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE (p.kind='llm' AND $1) OR (p.kind='embedding' AND $2)",[access.permissionCodes.includes('model_profiles.read'),access.permissionCodes.includes('embedding_profiles.read')])).rows);
      if(access.permissionCodes.includes('documents.read')) rows.push(...(await this.db.query("SELECT id::int,'knowledge' AS kind,name FROM knowledge_bases WHERE archived_at IS NULL")).rows);
      return rows;
    });
  }
}
