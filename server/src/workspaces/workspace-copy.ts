import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { normalizeSkillConfig } from '../agent-management/skill-document';
import type { DatabaseService } from '../database.service';
import { inWorkspace } from './workspace-context';
import { workspaceAccess } from './workspace-access';

const input=z.object({targetWorkspaceId:z.number().int().positive(),kind:z.enum(['agent','skill','tool','prompt','model','knowledge']),id:z.number().int().positive()}).strict();
const readPermission=(kind:string)=>kind==='prompt'?'prompts.read':kind==='model'?'model_profiles.read':kind==='knowledge'?'documents.read':'agent_config.read';
const managePermission=(kind:string)=>kind==='prompt'?'prompts.manage':kind==='model'?'model_profiles.manage':kind==='knowledge'?'knowledge_bases.manage':'agent_config.manage';
/** Export only explicitly selected configuration and dependencies under source RLS;
 * import into destination under destination RLS. No privileged business queries. */
export async function copyWorkspaceResource(db:DatabaseService,actor:number,sourceId:number,body:unknown){
 const p=input.safeParse(body);if(!p.success)throw new BadRequestException('复制参数无效');
 const {targetWorkspaceId,kind,id}=p.data;if(sourceId===targetWorkspaceId)throw new BadRequestException('请选择另一个空间');
 const source=await workspaceAccess(db,actor,sourceId),target=await workspaceAccess(db,actor,targetWorkspaceId);
 const bundle=new Map<string,any>();
 await inWorkspace(sourceId,()=>db.transaction(async c=>{
  await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  async function collect(type:string,id:number):Promise<void>{
   const key=`${type}:${id}`;if(bundle.has(key))return;
   const modelKind=type==='model'?(await c.query('SELECT p.kind FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE v.id=$1',[id])).rows[0]?.kind:null;
   const permissionType=modelKind==='embedding'?'embedding':type;
   const required=permissionType==='embedding'?'embedding_profiles.read':readPermission(type);if(!source.permissionCodes.includes(required))throw new ForbiddenException('没有读取复制依赖的权限');
   if(!target.permissionCodes.includes((permissionType==='embedding'?'embedding_profiles.manage':managePermission(type))))throw new ForbiddenException('没有在目标空间创建依赖的权限');
   const sql=type==='prompt'?`SELECT r.*,v.id AS version_id,v.template,v.variables FROM prompt_resources r JOIN prompt_versions v ON v.resource_id=r.id WHERE v.id=$1 AND r.prompt_type<>'summary' AND r.prompt_key<>'conversation.summary'`:
    type==='model'?`SELECT p.kind,p.name,v.config FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE v.id=$1`:
    type==='knowledge'?`SELECT name,description,draft_config,retrieval_config FROM knowledge_bases WHERE id=$1 AND archived_at IS NULL`:
    `SELECT r.kind,r.resource_key,r.name,v.config FROM agent_resource_versions v JOIN agent_resources r ON r.id=v.resource_id WHERE v.id=$1 AND r.archived_at IS NULL AND r.deleted_at IS NULL`;
   const row=(await c.query(sql,[id])).rows[0];if(!row)throw new NotFoundException('复制资源或依赖不存在');bundle.set(key,row);
   if(type==='agent'){
    if(row.kind!=='agent')throw new BadRequestException('资源类型不一致');
    await collect('prompt',row.config.promptVersionId);
    if(row.config.modelPlanVersionId)await collect('model',row.config.modelPlanVersionId);
    if(row.config.embeddingPlanVersionId)await collect('model',row.config.embeddingPlanVersionId);
    for(const n of row.config.toolVersionIds)await collect('tool',n);
    for(const n of row.config.skillVersionIds)await collect('skill',n);
    for(const n of row.config.knowledgeBaseIds)await collect('knowledge',n);
    for(const n of row.config.collaboration?.memberVersionIds??[])await collect('agent',n);
   }
   else if(type==='model'){
    for(const deployment of row.config.deployments){
     const account=(await c.query('SELECT kind,name,platform_key,base_url FROM model_accounts WHERE id=$1',[deployment.accountId])).rows[0];
     if(!account)throw new NotFoundException('模型账户不存在');bundle.set(`account:${deployment.accountId}`,account);
    }
   }
  }
  // Resource choices use resource IDs; copy the latest published (or latest draft) version.
  let versionId=id;
  if(!['model','knowledge'].includes(kind)){
   const table=kind==='prompt'?'prompt_versions':'agent_resource_versions';
   const row=(await c.query(`SELECT id FROM ${table} WHERE resource_id=$1 ORDER BY (status='published') DESC,version DESC LIMIT 1`,[id])).rows[0];
   if(!row)throw new NotFoundException('资源不存在');versionId=Number(row.id);
  }
  await collect(kind,versionId);
  bundle.set('root',{key:`${kind}:${versionId}`});
 }));
 return inWorkspace(targetWorkspaceId,()=>db.transaction(async c=>{
  const mapped=new Map<string,number>(),visiting=new Set<string>();
  async function insert(key:string):Promise<number>{
   if(mapped.has(key))return mapped.get(key)!;
   if(visiting.has(key))throw new BadRequestException('复制依赖存在循环，请先修正配置');visiting.add(key);
   const row=bundle.get(key);if(!row)throw new NotFoundException('依赖不存在');
   const type=key.split(':')[0];let value:number;
   if(type==='account'){
    value=Number((await c.query('INSERT INTO model_accounts(kind,name,platform_key,base_url,enabled) VALUES($1,$2,$3,$4,false) RETURNING id',[row.kind,row.name,row.platform_key,row.base_url])).rows[0].id);
   }else if(type==='model'){
    const deployments=[];
    for(const d of row.config.deployments){
     const accountId=await insert(`account:${d.accountId}`);
     const deploymentId=Number((await c.query('INSERT INTO model_deployments(kind,account_id,name,config) VALUES($1,$2,$3,$4) RETURNING id',[row.kind,accountId,d.name,JSON.stringify(d.config)])).rows[0].id);
     deployments.push({...d,id:deploymentId,accountId});
    }
    const planId=(await c.query('INSERT INTO model_plans(kind,name) VALUES($1,$2) RETURNING id',[row.kind,row.name])).rows[0].id;
    value=Number((await c.query('INSERT INTO model_plan_versions(plan_id,version,config) VALUES($1,1,$2) RETURNING id',[planId,JSON.stringify({deployments})])).rows[0].id);
   }else if(type==='prompt'){
    const resource=(await c.query('INSERT INTO prompt_resources(prompt_key,name,prompt_type,description,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,prompt_key) DO NOTHING RETURNING id',[row.prompt_key,row.name,row.prompt_type,row.description,actor])).rows[0];
    if(!resource)throw new ConflictException('目标空间存在同名 Prompt Key，请先调整 Key');
    value=Number((await c.query('INSERT INTO prompt_versions(resource_id,version,template,variables,change_note,created_by) VALUES($1,1,$2,$3,$4,$5) RETURNING id',[resource.id,row.template,JSON.stringify(row.variables),`从工作空间 ${sourceId} 复制`,actor])).rows[0].id);
   }else if(type==='knowledge'){
    // Indexes and files are independent data, never reused across spaces.
    const config={...row.draft_config,indexMode:'economy',embeddingProfileId:null,retrievalMode:'fulltext'};
    const retrieval={...row.retrieval_config,retrievalMode:'fulltext'};
    value=Number((await c.query('INSERT INTO knowledge_bases(name,description,draft_config,retrieval_config) VALUES($1,$2,$3,$4) RETURNING id',[row.name,row.description,JSON.stringify(config),JSON.stringify(retrieval)])).rows[0].id);
   }else{
    if(row.kind!==type)throw new BadRequestException('资源类型不一致');
    const config=structuredClone(row.config);
    if(type==='agent'){
     config.promptVersionId=await insert(`prompt:${config.promptVersionId}`);
     for(const field of ['modelPlanVersionId','embeddingPlanVersionId'])if(config[field])config[field]=await insert(`model:${config[field]}`);
     for(const [field,dependency] of [['toolVersionIds','tool'],['skillVersionIds','skill'],['knowledgeBaseIds','knowledge']]){const ids=[];for(const n of config[field])ids.push(await insert(`${dependency}:${n}`));config[field]=ids;};
     if(config.collaboration){const ids=[];for(const n of config.collaboration.memberVersionIds)ids.push(await insert(`agent:${n}`));config.collaboration.memberVersionIds=ids;}
     config.skillPolicies=[];
    }else if(type==='skill'){Object.assign(config,normalizeSkillConfig(config,row.resource_key));}
    else if(config.endpoint?.credentialEnv)delete config.endpoint.credentialEnv;
    const resource=(await c.query('INSERT INTO agent_resources(kind,resource_key,name) VALUES($1,$2,$3) ON CONFLICT(workspace_id,kind,resource_key) DO NOTHING RETURNING id',[type,row.resource_key,row.name])).rows[0];
    if(!resource)throw new ConflictException('目标空间存在同类资源 Key，请先调整 Key');
    value=Number((await c.query('INSERT INTO agent_resource_versions(resource_id,version,config) VALUES($1,1,$2) RETURNING id',[resource.id,JSON.stringify(config)])).rows[0].id);
   }
   visiting.delete(key);mapped.set(key,value);return value;
  }
  const versionId=await insert(bundle.get('root').key);
  await c.query("INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,'workspace.resource_copied','workspace',$2,$3)",[actor,String(targetWorkspaceId),JSON.stringify({sourceWorkspaceId:sourceId,kind,sourceResourceId:id,versionId})]);
  return {ok:true,versionId,copied:mapped.size};
 }));
}
