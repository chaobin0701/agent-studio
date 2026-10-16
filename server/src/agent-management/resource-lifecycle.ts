import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DatabaseService } from '../database.service';
import { isSystemTool, SYSTEM_TOOL_KEYS } from './system-tools';
import { effectiveAgentVersion } from './effective-agent-version';

type Query=Pick<DatabaseService,'query'>;
export type ResourceState='active'|'archived'|'deleted'|'all';
export type LifecycleKind='agent'|'skill'|'tool'|'mcp';
export type ResourceReference={type:string;id:number|string;name:string;versionId?:number;usage:'current'|'draft'|'historical'};
export function resourceState(value:unknown):ResourceState {
 if(value===undefined)return 'active';
 if(!['active','archived','deleted','all'].includes(String(value)))throw new BadRequestException('未知资源状态');
 return value as ResourceState;
}
export const statePredicate=(alias:string)=>`($1='all' OR ($1='active' AND ${alias}.archived_at IS NULL AND ${alias}.deleted_at IS NULL) OR ($1='archived' AND ${alias}.archived_at IS NOT NULL AND ${alias}.deleted_at IS NULL) OR ($1='deleted' AND ${alias}.deleted_at IS NOT NULL))`;
/** Serialize lifecycle and dependency-changing writes within a workspace. No network calls under this lock. */
export async function lifecycleWriteLock(c:Query){await c.query('SELECT pg_advisory_xact_lock(82471351,current_workspace_id()::int)');}
const agentUsage=`CASE WHEN a.archived_at IS NOT NULL OR a.deleted_at IS NOT NULL THEN 'historical' WHEN av.status='draft' THEN 'draft' WHEN ${effectiveAgentVersion('a','av')} THEN 'current' ELSE 'historical' END`;
const publishedUsage=(r:string,v:string)=>`CASE WHEN ${r}.archived_at IS NOT NULL OR ${r}.deleted_at IS NOT NULL THEN 'historical' WHEN ${v}.status='draft' THEN 'draft' WHEN ${v}.id=(SELECT id FROM agent_resource_versions WHERE resource_id=${r}.id AND status='published' ORDER BY version DESC LIMIT 1) OR EXISTS(SELECT 1 FROM agent_resources a JOIN agent_resource_versions av ON av.resource_id=a.id WHERE ${effectiveAgentVersion('a','av')} AND a.kind='agent' AND a.archived_at IS NULL AND a.deleted_at IS NULL AND (av.config->'toolVersionIds' @> jsonb_build_array(${v}.id) OR av.config->'skillVersionIds' @> jsonb_build_array(${v}.id))) THEN 'current' ELSE 'historical' END`;

async function resource(c:Query,kind:LifecycleKind,id:number,lock=false){
 const table=kind==='mcp'?'mcp_servers':'agent_resources';
 const row=(await c.query(`SELECT * FROM ${table} WHERE id=$1${kind==='mcp'?'':' AND kind=$2'}${lock?' FOR UPDATE':''}`,kind==='mcp'?[id]:[id,kind])).rows[0];
 if(!row)throw new NotFoundException('资源不存在');
 if(kind==='tool'&&isSystemTool(row.resource_key))throw new BadRequestException('平台基础工具不允许归档或删除');
 if(kind==='tool'&&(await c.query("SELECT 1 FROM agent_resource_versions WHERE resource_id=$1 AND config->>'target'=ANY($2::text[]) LIMIT 1",[id,[...SYSTEM_TOOL_KEYS]])).rows.length)throw new BadRequestException('平台基础工具不允许归档或删除');
 return row;
}
export async function resourceReferences(c:Query,kind:LifecycleKind,id:number):Promise<ResourceReference[]>{
 const row=await resource(c,kind,id);
 const refs:ResourceReference[]=[];
 if(kind==='agent') {
  refs.push(...(await c.query<ResourceReference>("SELECT 'application' AS type,id,name,'current' AS usage FROM integration_apps WHERE agent_id=$1 ORDER BY name",[id])).rows);
  refs.push(...(await c.query<ResourceReference>(`SELECT 'agent' AS type,a.id::int,a.name,av.id::int AS "versionId",${agentUsage} AS usage
   FROM agent_resources a JOIN agent_resource_versions av ON av.resource_id=a.id WHERE a.kind='agent'
   AND EXISTS(SELECT 1 FROM agent_resource_versions target WHERE target.resource_id=$1
     AND av.config->'collaboration'->'memberVersionIds' @> jsonb_build_array(target.id))`,[id])).rows);
 }else if(kind==='skill'||kind==='tool') {
  const field=kind==='skill'?'skillVersionIds':'toolVersionIds';
  refs.push(...(await c.query<ResourceReference>(`SELECT 'agent' AS type,a.id::int,a.name,av.id::int AS "versionId",${agentUsage} AS usage FROM agent_resources a JOIN agent_resource_versions av ON av.resource_id=a.id WHERE a.kind='agent' AND EXISTS(SELECT 1 FROM agent_resource_versions target WHERE target.resource_id=$1 AND av.config->'${field}' @> jsonb_build_array(target.id))`,[id])).rows);

 }else {
  refs.push(...(await c.query<ResourceReference>(`SELECT 'tool' AS type,t.id::int,t.name,tv.id::int AS "versionId",${publishedUsage('t','tv')} AS usage FROM agent_resources t JOIN agent_resource_versions tv ON tv.resource_id=t.id JOIN mcp_server_versions mv ON mv.id=(tv.config->>'mcpVersionId')::bigint WHERE t.kind='tool' AND mv.server_id=$1`,[id])).rows);
  refs.push(...(await c.query<ResourceReference>(`SELECT DISTINCT 'agent' AS type,a.id::int,a.name,av.id::int AS "versionId",${agentUsage} AS usage FROM agent_resources a JOIN agent_resource_versions av ON av.resource_id=a.id JOIN agent_resource_versions tv ON av.config->'toolVersionIds' @> jsonb_build_array(tv.id) JOIN mcp_server_versions mv ON mv.id=(tv.config->>'mcpVersionId')::bigint WHERE a.kind='agent' AND mv.server_id=$1`,[id])).rows);
 }
 return refs;
}
export async function changeResourceLifecycle(c:Query,actor:number,kind:LifecycleKind,id:number,action:'archive'|'delete'|'restore'){
 await lifecycleWriteLock(c);
 const row=await resource(c,kind,id,true),table=kind==='mcp'?'mcp_servers':'agent_resources';
 if(action==='restore'){
  if(!row.archived_at&&!row.deleted_at)throw new ConflictException('资源未归档或删除');
  await c.query(`UPDATE ${table} SET archived_at=NULL,deleted_at=NULL,enabled=false${kind==='mcp'?'':',current_version_id=NULL'} WHERE id=$1`,[id]);
 }else{
  if(row.deleted_at || action==='archive'&&row.archived_at)throw new ConflictException('资源已移除');
  const references=await resourceReferences(c,kind,id);
  if(references.some(r=>r.usage==='current'))throw new ConflictException({message:'仍有使用中的引用，请先替换或解除关联',references});
  await c.query(`UPDATE ${table} SET ${action==='archive'?'archived_at':'deleted_at'}=now(),enabled=false${kind==='mcp'?'':',current_version_id=NULL'} WHERE id=$1`,[id]);
 }
 await c.query("INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)",[actor,`${kind}.${action}`,kind,String(id),JSON.stringify({previousEnabled:row.enabled,previousCurrentVersionId:row.current_version_id??null})]);
 return {ok:true,enabled:false};
}
