import { effectiveAgentVersion } from './effective-agent-version';
import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DatabaseService } from '../database.service';
import { AppConfigService } from '../config/config.service';
import { parseAgentConfiguration, agentConfigurationRevision } from '../config/agent-config';
import { ToolRegistry } from '../ai/tools/tool-registry';
import { SkillRegistry } from '../ai/skills/skill-registry';
import { PromptRuntimeService } from '../prompts/prompt-runtime.service';
import { ModelManagementService } from '../model-management/model-management.service';
import { makeManagedTool } from './managed-tool';
import { FOUNDATION_TOOL_KEYS, isRuntimeToolResource, isFoundationTool, isSystemTool } from './system-tools';
import { ToolManagementService } from '../tool-management/tool-management.service';
import { schemas, skillSchema, keySchema, resourceKind, type ResourceKind, type ResourceVersion, type AgentSpec, type SkillSpec, type ToolSpec, type CollaborationSpec } from './resource.types';
import { agentMemoryScope, freeze, invocationScope, type ResolvedAgent, type CompositionSnapshot } from './runtime-scope';
import { workspaceAccess } from '../workspaces/workspace-access';
import { currentWorkspaceId } from '../workspaces/workspace-context';
import type { PlanVersion } from '../model-management/model-management.types';
import { embeddingProfileSchema, embeddingFingerprint } from '../documents/profile-embedding';
import { indexEmbeddingFingerprint } from '../documents/retrieval-compatibility';
import { exportSkillDocument, parseSkillDocument, skillDocumentDiagnostics, normalizeSkillConfig, skillEditorDocument, exportSkillBundle } from './skill-document';
import { skillResourcesSchema } from './skill-resources';
import { publishedSkillFiles } from '../ai/deep-agents/run-workspace';
import type { SkillDefinition } from '../ai/skills/skill.types';
import { questionSchema } from '../ai/tools/ask-user.tool';

import { lifecycleWriteLock, resourceState, statePredicate, resourceReferences, changeResourceLifecycle, type ResourceState, type LifecycleKind } from './resource-lifecycle';

type Query = Pick<DatabaseService,'query'>;
type KnowledgeChoiceRow = {id:number;name:string;enabled:boolean;indexVersionId:number|null;indexMode:string|null;embeddingPlanVersionId:number|null;embeddingPlanName:string|null;embeddingPlanVersion:number|null;_embeddingSnapshot:unknown;supportsVector:boolean};
const versionSelect = `SELECT v.id::int,v.resource_id::int AS "resourceId",r.resource_key AS key,v.display_name AS name,r.kind,r.enabled,r.archived_at AS "archivedAt",r.deleted_at AS "deletedAt",
 v.version,v.status,v.revision,v.config,v.created_at AS "createdAt",v.updated_at AS "updatedAt",v.published_at AS "publishedAt",v.tested_revision AS "testedRevision",v.test_result AS "testResult"
 FROM agent_resource_versions v JOIN agent_resources r ON r.id=v.resource_id`;
const createInput = z.object({kind:resourceKind,key:keySchema,name:z.string().trim().min(1).max(160),config:z.unknown()}).strict();
const updateInput = z.object({revision:z.number().int().positive(),config:z.unknown(),name:z.string().trim().min(1).max(160).optional()}).strict();
const knowledgeChoiceSelect = `SELECT kb.id::int,kb.name,kb.enabled_for_chat AS enabled,
 kb.active_index_version_id::int AS "indexVersionId",i.config->>'indexMode' AS "indexMode",
 e.model_plan_version_id::int AS "embeddingPlanVersionId",p.name AS "embeddingPlanName",v.version AS "embeddingPlanVersion",
 i.embedding_snapshot AS "_embeddingSnapshot",
 COALESCE(i.status='ready' AND i.config->>'indexMode'='high_quality',false) AS "supportsVector"
 FROM knowledge_bases kb LEFT JOIN knowledge_index_versions i ON i.id=kb.active_index_version_id
 LEFT JOIN embedding_profiles e ON e.id=COALESCE((i.embedding_snapshot->>'profileId')::bigint,(i.config->>'embeddingProfileId')::bigint)
 LEFT JOIN model_plan_versions v ON v.id=e.model_plan_version_id
 LEFT JOIN model_plans p ON p.id=v.plan_id AND p.kind='embedding'
 WHERE kb.archived_at IS NULL`;

@Injectable()
export class AgentManagementService {
 constructor(private readonly db:DatabaseService, private readonly runtime:AppConfigService,
  private readonly tools:ToolRegistry,private readonly skills:SkillRegistry,
  private readonly prompts:PromptRuntimeService,private readonly models:ModelManagementService,
  @Optional() private readonly externalTools?:ToolManagementService) {}

 async list(state:ResourceState='active') {
  resourceState(state);
  const resources=(await this.db.query(`SELECT r.id::int,r.kind,r.resource_key AS key,CASE WHEN r.kind='agent' AND r.current_version_id IS NULL THEN COALESCE((SELECT display_name FROM agent_resource_versions d WHERE d.resource_id=r.id ORDER BY d.version DESC LIMIT 1),r.name) ELSE r.name END AS name,r.enabled,r.archived_at AS "archivedAt",r.deleted_at AS "deletedAt",r.current_version_id::int AS "currentVersionId",
   GREATEST(r.updated_at,MAX(v.updated_at)) AS "updatedAt",
   COALESCE((SELECT d.config IS DISTINCT FROM published.config OR d.display_name IS DISTINCT FROM published.display_name
    FROM agent_resource_versions d LEFT JOIN agent_resource_versions published ON published.id=CASE WHEN r.kind='agent' THEN r.current_version_id ELSE (SELECT p.id FROM agent_resource_versions p WHERE p.resource_id=r.id AND p.status='published' ORDER BY p.version DESC LIMIT 1) END
    WHERE d.resource_id=r.id AND d.status='draft' ORDER BY d.version DESC LIMIT 1),false) AS "hasUnpublishedChanges",
   (array_agg(v.config->>'type' ORDER BY v.version DESC))[1] AS "toolType",
   jsonb_agg(jsonb_build_object('id',v.id::int,'version',v.version,'status',v.status,'name',v.display_name,'updatedAt',v.updated_at,'responsibility',v.config->>'responsibility','description',v.config->>'description','modelPlanVersionId',v.config->'modelPlanVersionId','mode',CASE WHEN v.config->'collaboration' IS NULL OR v.config->'collaboration'='null'::jsonb THEN 'single' ELSE 'multi' END,'createdAt',v.created_at,'permissionMode',CASE WHEN r.kind='skill' THEN v.config->>'permissionMode' ELSE NULL END) ORDER BY v.version DESC) AS versions
   FROM agent_resources r JOIN agent_resource_versions v ON v.resource_id=r.id WHERE ${statePredicate('r')} GROUP BY r.id ORDER BY r.kind,"updatedAt" DESC,r.id DESC`,[state])).rows;
  // Deprecated old-web response: all environments resolve to the same current version.
  const bindings=resources.filter(r=>r.kind==='agent'&&r.currentVersionId).flatMap(r=>['dev','test','prod'].map(environment=>({agentId:r.id,environment,mode:'single',versionId:r.currentVersionId})));
  return {resources:resources.filter(r=>!isRuntimeToolResource({kind:r.kind,key:r.key})),bindings};
 }
 private async knowledgeChoices(c:Query,ids?:number[]) {
  const rows=(await c.query<KnowledgeChoiceRow>(knowledgeChoiceSelect+(ids?' AND kb.id=ANY($1::bigint[])':'')+' ORDER BY kb.id',ids?[ids]:[])).rows;
  return rows.map(({_embeddingSnapshot,...kb})=>{
   const fingerprint=indexEmbeddingFingerprint(_embeddingSnapshot);
   return {...kb,embeddingFingerprint:fingerprint,supportsVector:kb.supportsVector && !!fingerprint};
  });
 }
 private async validateVectorLibraries(c:Query,spec:AgentSpec) {
  if(spec.retrieval.retrievalMode!=='vector')return;
  const selected=spec.embeddingPlanVersionId?await this.agentEmbedding(c,spec.embeddingPlanVersionId):null;
  const fingerprint=selected?embeddingFingerprint(selected.profile):null;
  const libraries=await this.knowledgeChoices(c,spec.knowledgeBaseIds);
  const incompatible=libraries.filter(kb=>!kb.enabled || !kb.supportsVector || (fingerprint && kb.embeddingFingerprint!==fingerprint)).map(kb=>kb.name);
  for(const id of spec.knowledgeBaseIds)if(!libraries.some(kb=>kb.id===id))incompatible.push(`知识库 ${id}`);
  if(incompatible.length)throw new BadRequestException(`向量检索要求已开启且模型兼容的向量索引，请更换模型、移除或重建这些知识库：${incompatible.join('、')}`);
 }
 private async agentEmbedding(c:Query,id:number) {
  const plan=(await c.query<PlanVersion>("SELECT v.*,v.id::int,v.plan_id::int,p.kind,p.name FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE v.id=$1 AND v.status='published' AND p.kind='embedding' AND p.deleted_at IS NULL AND p.archived_at IS NULL FOR SHARE OF v,p",[id])).rows[0];
  const row=(await c.query('SELECT id::int,config FROM embedding_profiles WHERE model_plan_version_id=$1 AND enabled FOR SHARE',[id])).rows[0];
  if(!plan || !row)throw new BadRequestException('请选择当前工作区启用的已发布向量模型方案');
  return {plan,profile:embeddingProfileSchema.parse({...row.config,profileId:row.id})};
 }
 async options() {
  return {tools:this.tools.list().filter(t=>!isSystemTool(t.name)).map(t=>({key:t.name,description:t.description,workflow:t.execution?.workflow??null,parameters:z.toJSONSchema(t.inputSchema,{io:'input',unrepresentable:'any'})})),
   knowledgeBases:await this.knowledgeChoices(this.db),
   members:(await this.db.query(`SELECT v.id::int,r.id::int AS "resourceId",r.resource_key AS key,r.name,v.version,v.config->>'responsibility' AS responsibility
    FROM agent_resources r JOIN agent_resource_versions v ON v.resource_id=r.id
    WHERE r.kind='agent' AND r.enabled AND r.archived_at IS NULL AND r.deleted_at IS NULL AND v.status='published'
      AND (v.config->'collaboration' IS NULL OR v.config->'collaboration'='null'::jsonb)
    ORDER BY r.id,v.version DESC`)).rows,
   prompts:(await this.db.query(`SELECT v.id::int,r.id::int AS "resourceId",r.prompt_key AS key,r.name,v.version,v.template FROM prompt_versions v JOIN prompt_resources r ON r.id=v.resource_id WHERE v.status='published' AND r.archived_at IS NULL AND r.prompt_type <> 'summary' AND r.prompt_key NOT IN ('agent.planner','agent.answer','conversation.summary') AND btrim(v.template) <> '' AND length(v.template)<=24000 AND position('{{' in v.template)=0 AND NOT EXISTS(SELECT 1 FROM jsonb_each(v.variables) d WHERE d.value->>'required'='true') ORDER BY r.id,v.version DESC`)).rows,
   embeddingPlans:(await this.db.query("SELECT v.id::int,p.name,v.version,e.id::int AS \"profileId\",e.config FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id JOIN embedding_profiles e ON e.model_plan_version_id=v.id WHERE p.kind='embedding' AND v.status='published' AND e.enabled AND p.deleted_at IS NULL AND p.archived_at IS NULL ORDER BY p.id,v.version DESC")).rows.map(({config,...row})=>{
    const profile=embeddingProfileSchema.parse(config);return {...row,fingerprint:embeddingFingerprint(profile),model:profile.model,dimensions:profile.dimensions};
   }),
   modelPlans:(await this.db.query("SELECT v.id::int,p.name,v.version,p.id::int AS \"planId\",p.current_version_id::int AS \"currentVersionId\" FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE p.kind='llm' AND v.status='published' AND p.deleted_at IS NULL AND p.archived_at IS NULL ORDER BY p.id,(v.id=p.current_version_id) DESC,v.version DESC")).rows};
 }
 async get(resourceId:number) {
  const versions=(await this.db.query<ResourceVersion>(versionSelect+' WHERE r.id=$1 ORDER BY v.version DESC',[resourceId])).rows;
  if(!versions.length || isRuntimeToolResource(versions[0])) throw new NotFoundException('资源不存在');
  const enriched=[];
  for(const v of versions) enriched.push({...v,...(v.kind==='agent'?{businessPrompt:(await this.db.query('SELECT template FROM prompt_versions WHERE id=$1',[v.config.promptVersionId])).rows[0]?.template??''}:{})});
  const current=(await this.db.query('SELECT current_version_id::int AS "currentVersionId" FROM agent_resources WHERE id=$1',[resourceId])).rows[0];
  return {archivedAt:versions[0].archivedAt??null,deletedAt:versions[0].deletedAt??null,currentVersionId:current?.currentVersionId??null,id:resourceId,key:versions[0].key,name:versions[0].name,kind:versions[0].kind,enabled:versions[0].enabled,versions:enriched};
 }
 private parse<T>(schema:z.ZodType<T>,input:unknown):T {
  const result=schema.safeParse(input);
  if(!result.success) throw new BadRequestException(result.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
 }
 private async version(c:Query,id:number,kind?:ResourceKind,published=false,allowRemoved=false):Promise<ResourceVersion> {
  const v=(await c.query<ResourceVersion>(versionSelect+' WHERE v.id=$1',[id])).rows[0];
  if(!v || (!allowRemoved&&(v.archivedAt || v.deletedAt)) || (kind&&v.kind!==kind)) throw new NotFoundException('资源版本不存在');
  if(published && (v.status!=='published'||!v.enabled)) throw new ConflictException('关联资源必须为启用的已发布版本');
  return v;
 }
 async create(actor:number,body:unknown) {
  const input=this.parse(createInput,body);
  this.assertManagedTool(input.kind,input.key,input.config);
  return this.db.transaction(async c=> {
   await lifecycleWriteLock(c);
   const r=(await c.query('INSERT INTO agent_resources(kind,resource_key,name) VALUES($1,$2,$3) ON CONFLICT(workspace_id,kind,resource_key) DO NOTHING RETURNING id::int',[input.kind,input.key,input.name])).rows[0];
   if(!r) throw new ConflictException('同类资源的 Key 已存在');
   const config:any=typeof input.config==='object'&&input.config ? {...input.config}:{};
   if(input.kind==='agent' && config.output===undefined)config.output={mode:'text'};
   const parsed=input.kind==='skill'?this.skillConfig(config,input.key):this.parse(schemas[input.kind] as z.ZodTypeAny,config);
   await this.validateOwnership(c,input.kind,parsed as any);
   if(input.kind==='tool')await this.externalTools?.validateTool(parsed as ToolSpec);
   if(input.kind==='agent' && ['vector','hybrid'].includes((parsed as AgentSpec).retrieval.retrievalMode) && !(parsed as AgentSpec).embeddingPlanVersionId)throw new BadRequestException('向量／混合检索需要选择已发布的向量模型方案');
   if(input.kind==='agent') await this.validateVectorLibraries(c,parsed as AgentSpec);
   if(input.kind==='agent') await this.validateAgentPrompt(c,(parsed as AgentSpec).promptVersionId);
   const v=(await c.query('INSERT INTO agent_resource_versions(resource_id,version,config) VALUES($1,1,$2) RETURNING id::int',[r.id,JSON.stringify(parsed)])).rows[0];
   await this.audit(c,actor,'agent_resource.created',r.id,{kind:input.kind,key:input.key});
   return {resourceId:r.id,versionId:v.id};
  });
 }
 async update(actor:number,id:number,body:unknown) {
  const input=this.parse(updateInput,body);
  return this.db.transaction(async c=> {
   await lifecycleWriteLock(c);
   await c.query('SELECT id FROM agent_resource_versions WHERE id=$1 FOR UPDATE',[id]);
   const v=await this.version(c,id);
   this.assertManagedTool(v.kind,v.key,v.config);
   this.assertManagedTool(v.kind,v.key,input.config);
   if(v.status!=='draft'||v.revision!==input.revision) throw new ConflictException('草稿已更新，或版本已发布，请重新加载');
   if(input.name!==undefined && v.kind!=='agent')throw new BadRequestException('此入口仅支持修改 Agent 草稿名称');
   if(v.kind==='agent') {
    const latest=(await c.query("SELECT id::int FROM agent_resource_versions WHERE resource_id=$1 AND status='draft' ORDER BY version DESC LIMIT 1",[v.resourceId])).rows[0];
    if(latest?.id!==v.id)throw new ConflictException('请编辑最新工作草稿');
   }
   const config:any=typeof input.config==='object'&&input.config?{...input.config}:{};
   const parsed=v.kind==='skill'?this.skillConfig(config,v.key):this.parse(schemas[v.kind] as z.ZodTypeAny,config);
   await this.validateOwnership(c,v.kind,parsed as any);
   if(v.kind==='tool')await this.externalTools?.validateTool(parsed as ToolSpec);
   if(v.kind==='agent' && ['vector','hybrid'].includes((parsed as AgentSpec).retrieval.retrievalMode) && !(parsed as AgentSpec).embeddingPlanVersionId)throw new BadRequestException('向量／混合检索需要选择已发布的向量模型方案');
   if(v.kind==='agent') await this.validateVectorLibraries(c,parsed as AgentSpec);
   if(v.kind==='agent') await this.validateAgentPrompt(c,(parsed as AgentSpec).promptVersionId);
   const saved=(await c.query('UPDATE agent_resource_versions SET config=$2,display_name=$3,revision=revision+1,tested_revision=NULL,test_result=NULL WHERE id=$1 RETURNING display_name AS name,updated_at AS "updatedAt"',[id,JSON.stringify(parsed),input.name??v.name])).rows[0];
   await this.audit(c,actor,'agent_resource.draft_updated',id,{revision:v.revision+1});
   return {ok:true,revision:v.revision+1,...saved,...(v.kind==='skill'?{config:parsed}:{})};
  });
 }
 async skillDraft(actor:number,resourceId:number,body:unknown) {
  const input=this.parse(z.object({fromVersionId:z.number().int().positive().optional(),branch:z.boolean().default(false)}).strict(),body??{});
  return this.db.transaction(async c=> {
   await lifecycleWriteLock(c);
   const resource=(await c.query("SELECT id FROM agent_resources WHERE id=$1 AND kind='skill' AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE",[resourceId])).rows[0];
   if(!resource)throw new NotFoundException('Skill 不存在');
   const versions=(await c.query<ResourceVersion>(versionSelect+' WHERE r.id=$1 ORDER BY v.version DESC',[resourceId])).rows;
   const source=input.fromVersionId?versions.find(v=>v.id===input.fromVersionId):versions.find(v=>v.status==='published')??versions[0];
   if(!source)throw new NotFoundException('来源版本不存在');
   const draft=versions.find(v=>v.status==='draft');
   if(draft&&!input.branch)return {resourceId,versionId:draft.id,reused:true};
   const version=(versions[0]?.version??0)+1;
   const created=(await c.query('INSERT INTO agent_resource_versions(resource_id,version,config) VALUES($1,$2,$3) RETURNING id::int',[resourceId,version,JSON.stringify(source.config)])).rows[0];
   await this.audit(c,actor,'skill.draft_created',created.id,{resourceId,fromVersionId:source.id,branch:input.branch});
   return {resourceId,versionId:created.id,reused:false};
  });
 }
 /** Continue one working Tool draft. Only explicit history branching creates another. */
 async toolDraft(actor:number,resourceId:number,body:unknown) {
  const input=this.parse(z.object({fromVersionId:z.number().int().positive().optional(),branch:z.boolean().default(false)}).strict(),body??{});
  return this.db.transaction(async c=> {
   await lifecycleWriteLock(c);
   const resource=(await c.query("SELECT id,resource_key AS key FROM agent_resources WHERE id=$1 AND kind='tool' AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE",[resourceId])).rows[0];
   if(!resource)throw new NotFoundException('Tool 不存在');
   this.assertManagedTool('tool',resource.key);
   const versions=(await c.query<ResourceVersion>(versionSelect+' WHERE r.id=$1 ORDER BY v.version DESC',[resourceId])).rows;
   const source=input.fromVersionId?versions.find(v=>v.id===input.fromVersionId):versions.find(v=>v.status==='published')??versions[0];
   if(!source)throw new NotFoundException('来源版本不存在或不属于此 Tool');
   this.assertManagedTool('tool',resource.key,source.config);
   const draft=versions.find(v=>v.status==='draft');
   if(draft&&!input.branch)return {resourceId,versionId:draft.id,reused:true};
   const version=(versions[0]?.version??0)+1;
   const created=(await c.query('INSERT INTO agent_resource_versions(resource_id,version,config) VALUES($1,$2,$3) RETURNING id::int',[resourceId,version,JSON.stringify(source.config)])).rows[0];
   await this.audit(c,actor,'tool.draft_created',created.id,{resourceId,fromVersionId:source.id,branch:input.branch});
   return {resourceId,versionId:created.id,reused:false};
  });
 }
 private skillConfig(config:unknown,key:string):SkillSpec {
  try{return normalizeSkillConfig(config,key);}catch(e){throw new BadRequestException(e instanceof Error?e.message:'Skill 文档格式错误');}
 }
 async skillDocument(versionId:number,format:'platform'|'portable'='platform') {
  const v=await this.version(this.db,versionId,'skill',false,true);
  try {
   const bundle=exportSkillBundle(v.key,v.name,v.config,format);
   return {document:format==='platform'?skillEditorDocument(v.key,v.name,v.config):bundle.document,resources:bundle.resources,bundle,diagnostics:skillDocumentDiagnostics(v.config)};
  } catch(e) { throw new BadRequestException(e instanceof Error?e.message:'Skill 导出失败'); }
 }
 async parseSkillDocument(text:string,mapping:unknown,resources:unknown=[]) {
  const parsed=parseSkillDocument(text,mapping),config=skillSchema.parse({...parsed.config,resources:skillResourcesSchema.parse(resources)});
  parsed.config=config;
  return {...parsed,diagnostics:[...parsed.diagnostics.filter(d=>d.field==='name'),...skillDocumentDiagnostics(config)]};
 }
 async skillUsage(resourceId:number) {
  const resource=(await this.db.query("SELECT id FROM agent_resources WHERE id=$1 AND kind='skill'",[resourceId])).rows[0];
  if(!resource)throw new NotFoundException('Skill 不存在');
  return {agents:(await this.db.query(`SELECT a.id::int AS "agentId",a.name,v.id::int AS "agentVersionId",v.version AS "agentVersion",s.id::int AS "skillVersionId",s.version AS "skillVersion",
   ${effectiveAgentVersion('a','v')} AS "isCurrent",'[]'::jsonb AS environments
   FROM agent_resources a JOIN agent_resource_versions v ON v.resource_id=a.id
   JOIN agent_resource_versions s ON s.resource_id=$1 AND v.config->'skillVersionIds' @> jsonb_build_array(s.id)
   WHERE a.kind='agent' AND v.status='published' ORDER BY a.id,v.version DESC`,[resourceId])).rows};
 }
 async clone(actor:number,id:number,newResource?:{key:string;name:string}) {
  return this.db.transaction(async c=> {
   await lifecycleWriteLock(c);
   const v=await this.version(c,id);
   this.assertManagedTool(v.kind,v.key,v.config);
   if(newResource)this.assertManagedTool(v.kind,newResource.key,v.config);
   let resourceId=v.resourceId;
   if(newResource) {
    const key=this.parse(keySchema,newResource.key);const name=this.parse(z.string().trim().min(1).max(160),newResource.name);
    const created=(await c.query('INSERT INTO agent_resources(kind,resource_key,name) VALUES($1,$2,$3) ON CONFLICT(workspace_id,kind,resource_key) DO NOTHING RETURNING id::int',[v.kind,key,name])).rows[0];
    if(!created) throw new ConflictException('同类资源的 Key 已存在');
    resourceId=created.id;
   }
   await c.query('SELECT id FROM agent_resources WHERE id=$1 AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE',[resourceId]);
   const n=(await c.query('SELECT coalesce(max(version),0)+1 n FROM agent_resource_versions WHERE resource_id=$1',[resourceId])).rows[0].n;
   const r=(await c.query('INSERT INTO agent_resource_versions(resource_id,version,config,display_name) VALUES($1,$2,$3,$4) RETURNING id::int',[resourceId,n,JSON.stringify(v.config),newResource?.name?.trim()??v.name])).rows[0];
   await this.audit(c,actor,'agent_resource.cloned',r.id,{fromVersionId:id,resourceId});
   return {resourceId,versionId:r.id};
  });
 }
 async enable(actor:number,id:number,enabled:boolean) {
  return this.db.transaction(async c=> {
   await lifecycleWriteLock(c);
   const resource=(await c.query('SELECT kind,resource_key AS key FROM agent_resources WHERE id=$1 AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE',[id])).rows[0];
   if(!resource)throw new NotFoundException('资源不存在');
   this.assertManagedTool(resource.kind,resource.key);
   if(enabled) {
    const latest=(await c.query<ResourceVersion>(versionSelect+" WHERE r.id=$1 AND v.status='published' ORDER BY (v.id=r.current_version_id) DESC,v.version DESC LIMIT 1",[id])).rows[0];
    if(latest)await this.validate(c,latest);
   }
   if(!(await c.query('UPDATE agent_resources SET enabled=$2 WHERE id=$1 RETURNING id',[id,enabled])).rows.length) throw new NotFoundException('资源不存在');
   await this.audit(c,actor,'agent_resource.status',id,{enabled});return {ok:true};
  });
 }
 async references(id:number) {
  const row=(await this.db.query('SELECT kind FROM agent_resources WHERE id=$1',[id])).rows[0];
  if(!row||!['agent','skill','tool'].includes(row.kind))throw new NotFoundException('资源不存在');
  return {references:await resourceReferences(this.db,row.kind as LifecycleKind,id)};
 }
 async lifecycle(actor:number,id:number,action:'archive'|'delete'|'restore') {
  return this.db.transaction(async c=>{
   await lifecycleWriteLock(c);
   const row=(await c.query('SELECT kind FROM agent_resources WHERE id=$1',[id])).rows[0];
   if(!row||!['agent','skill','tool'].includes(row.kind))throw new NotFoundException('资源不存在');
   return changeResourceLifecycle(c,actor,row.kind as LifecycleKind,id,action);
  });
 }
 private async validateOwnership(c:Query,kind:ResourceKind,spec:any) {
  for(const id of (kind==='agent'?spec.knowledgeBaseIds??[]:[]))if(!(await c.query('SELECT 1 FROM knowledge_bases WHERE id=$1',[id])).rowCount)throw new BadRequestException('关联知识库不属于当前空间');
  if(kind==='agent') {
   const selected=spec.collaboration?.memberVersionIds??[];
   for(const id of selected) await this.version(c,id,'agent',true);
   for(const [field,type] of [['toolVersionIds','tool'],['skillVersionIds','skill']] as const)for(const id of spec[field])await this.version(c,id,type);
   for(const [field,type] of [['modelPlanVersionId','llm']] as const)if(spec[field]&&!(await c.query('SELECT 1 FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE v.id=$1 AND p.kind=$2',[spec[field],type])).rowCount)throw new BadRequestException('关联模型方案不属于当前空间');
   if(spec.embeddingPlanVersionId)await this.agentEmbedding(c,spec.embeddingPlanVersionId);
  }
  if(kind==='tool'&&spec.endpoint?.credentialEnv&&currentWorkspaceId()!==1&&!spec.endpoint.credentialEnv.startsWith(`AGENT_TOOL_WS_${currentWorkspaceId()}_`))throw new BadRequestException('工具凭据必须属于当前工作空间');
 }
 private async validateAgentPrompt(c:Query,id:number) {
  const prompt=(await c.query(`SELECT v.template,v.status,v.variables,r.prompt_type,r.prompt_key,r.archived_at FROM prompt_versions v JOIN prompt_resources r ON r.id=v.resource_id WHERE v.id=$1`,[id])).rows[0];
  if(!prompt || prompt.archived_at || prompt.status!=='published') throw new BadRequestException('请选择 Prompt 管理中已发布的业务提示词版本');
  if(prompt.prompt_type==='summary'||['agent.planner','agent.answer','conversation.summary'].includes(prompt.prompt_key)) throw new BadRequestException('Agent 需选择普通业务提示词，平台模板和摘要由系统维护');
  if(!prompt.template.trim()||prompt.template.length>24000||/\{\{/.test(prompt.template)||Object.values(prompt.variables??{}).some((d:any)=>d.required)) throw new BadRequestException('Agent 业务提示词应为不含必填变量或占位符的正文，最多 24000 字；工具和 Skill 目录由系统注入');
 }
 private assertManagedTool(kind:string,key:string,config?:unknown) {
  const target=config && typeof config==='object' ? (config as {target?:unknown}).target : undefined;
  if(kind==='tool' && (isSystemTool(key) || (typeof target==='string' && isSystemTool(target)))) {
   throw new BadRequestException('此 Key 属于系统运行能力或已退休执行入口，不能作为普通工具创建、修改或停用');
  }
 }
 private async managedToolVersions(c:Query,ids:number[]) {
  const versions:ResourceVersion[]=[];
  for(const id of ids) {
   const v=await this.version(c,id,'tool');
   // Keep immutable historical bindings readable, but ignore their old settings.
   if(isRuntimeToolResource(v))continue;
   if(v.status!=='published'||!v.enabled)throw new ConflictException('关联资源必须为启用的已发布版本');
   versions.push(v);
  }
  return versions;
 }
 private validateWorkflowDependencies(versions:ResourceVersion[],allowed:readonly string[]) {
  for(const v of versions) {
   if(v.config.type!=='builtin')continue;
   if(!this.tools.has(v.config.target))throw new BadRequestException('关联的内置工具已不可用');
   const workflow=this.tools.get(v.config.target).execution?.workflow;
   if(!workflow)continue;
   const missing=workflow.requiredTools.filter(name=>!allowed.includes(name)||this.tools.has(name)&&!!this.tools.get(name).execution?.workflow);
   if(missing.length)throw new BadRequestException(`专项流程 ${workflow.key} 需要显式授权这些工具，不能由流程自行扩权：${missing.join('、')}`);
  }
 }
 private async validate(c:Query,v:ResourceVersion,seen=new Set<number>()) {
  await this.validateOwnership(c,v.kind,v.config);
  if(seen.has(v.id)) return;seen.add(v.id);
  const spec:any=this.parse(schemas[v.kind] as z.ZodTypeAny,v.config);
  if(v.kind==='agent') {
   await this.validateAgentPrompt(c,spec.promptVersionId);
   if(!spec.modelPlanVersionId) throw new BadRequestException('请选择此 Agent 使用的模型方案');
   await c.query('SELECT id FROM knowledge_bases WHERE id=ANY($1::bigint[]) ORDER BY id FOR SHARE',[spec.knowledgeBaseIds]);
   if (['vector','hybrid'].includes(spec.retrieval.retrievalMode) && v.status==='draft' && !spec.embeddingPlanVersionId)throw new BadRequestException('请选择 Agent 使用的已发布向量模型方案');
   await this.validateVectorLibraries(c,spec);
   if(spec.modelPlanVersionId) {
    if(!(await c.query("SELECT 1 FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE v.id=$1 AND v.status='published' AND p.kind='llm' AND p.deleted_at IS NULL AND p.archived_at IS NULL",[spec.modelPlanVersionId])).rows.length) throw new BadRequestException('模型方案必须是已发布版本');
   }
   for(const id of spec.skillVersionIds) await this.version(c,id,'skill',true);
   const tools=await this.managedToolVersions(c,spec.toolVersionIds);
   if(new Set(tools.map(t=>t.key)).size!==tools.length) throw new BadRequestException('同一工具不能绑定多个版本');
   this.validateWorkflowDependencies(tools,[...tools.map(t=>t.key),...FOUNDATION_TOOL_KEYS]);
   const skills=await Promise.all(spec.skillVersionIds.map((id:number)=>this.version(c,id,'skill',true)));
   if(new Set(skills.map(s=>s.key)).size!==skills.length) throw new BadRequestException('同一 Skill 不能绑定多个版本');
   try { publishedSkillFiles(skills.map(s=>this.skillDefinition(s))); } catch { throw new BadRequestException('所选 Skill 的文件数量或内容超过单 Agent 工作区限制，请减少绑定或资料内容'); }
   for(const id of spec.knowledgeBaseIds) if(!(await c.query('SELECT 1 FROM knowledge_bases WHERE id=$1 AND archived_at IS NULL AND enabled_for_chat',[id])).rows.length) throw new BadRequestException('知识库必须启用');
   if(spec.collaboration) {
    const members:ResourceVersion[]=[];
    for(const id of spec.collaboration.memberVersionIds) {
     const member=await this.version(c,id,'agent',true);
     if(member.resourceId===v.resourceId)throw new BadRequestException('入口 Agent 不能选择自己作为成员');
     if(member.config.collaboration)throw new BadRequestException('本轮只支持入口 Agent 调用单 Agent 成员，不允许嵌套协作');
     members.push(member);
    }
    if(new Set(members.map(m=>m.resourceId)).size!==members.length)throw new BadRequestException('同一个成员 Agent 只能选择一个发布版本');
    for(const member of members)await this.validate(c,member,seen);
   }
  } else if(v.kind==='tool') {
   this.assertManagedTool(v.kind,v.key,spec);
   try { z.fromJSONSchema(spec.parameters); } catch { throw new BadRequestException('工具 JSON Schema 无法解析'); }
   if(spec.parameters.type!=='object') throw new BadRequestException('工具参数必须使用 object JSON Schema');
   await this.externalTools?.validateTool(spec);
   if(spec.type!=='rest' && !spec.mcpVersionId && !this.tools.has(spec.target)) throw new BadRequestException('只可绑定已注册的内置或 MCP 工具');
   if(spec.type!=='rest' && !spec.mcpVersionId && v.key!==spec.target) throw new BadRequestException('内置和 MCP 工具 Key 必须与注册名称一致');
   if(spec.type!=='rest' && !spec.readOnly && spec.maxRetries>0) throw new BadRequestException('写入型内置或 MCP 工具暂不支持自动重试；幂等请求头仅适用于 REST 工具');
   if(spec.type==='mcp' && !spec.mcpVersionId && !spec.target.startsWith('mcp_')) throw new BadRequestException('MCP 工具必须引用已注册的 MCP 名称');
   if(spec.type==='rest' && spec.endpoint.connection!=='application') { const url=new URL(spec.endpoint.url); if(!['https:','http:'].includes(url.protocol)||url.username||url.password) throw new BadRequestException('无效工具端点'); }
   if(spec.endpoint?.credentialEnv&&!spec.endpoint.credentialEnv.startsWith('AGENT_TOOL_')) throw new BadRequestException('工具凭据引用必须以 AGENT_TOOL_ 开头');
  } else if(v.kind==='skill') {
   if(!spec.instructions.trim())throw new BadRequestException('请先补充 Skill 正文，再验证或发布');
   const errors=skillDocumentDiagnostics(spec).filter(d=>d.severity==='error');
   if(errors.length)throw new BadRequestException(errors.map(d=>d.message).join('；'));

  } else {
   const members:ResourceVersion[]=[];
   for(const id of [spec.coordinatorVersionId,...spec.memberVersionIds]) members.push(await this.version(c,id,'agent',true));
   if(new Set(members.map(a=>a.resourceId)).size!==members.length) throw new BadRequestException('协作计划中的 Agent 资源不能重复，请为不同职责创建独立资源');
   for(const member of members) await this.validate(c,member,seen);
  }
 }
 private async signature(c:Query,v:ResourceVersion) {
  const prompt=v.kind==='agent'?(await c.query('SELECT template,variables FROM prompt_versions WHERE id=$1',[v.config.promptVersionId])).rows[0]:null;
  return createHash('sha256').update(JSON.stringify({config:v.config,prompt})).digest('hex');
 }
 async test(actor:number,id:number,body:unknown) {
  const input=this.parse(z.object({input:z.record(z.string(),z.unknown()).default({}),execute:z.boolean().default(false),approved:z.boolean().default(false)}).strict(),body??{});
  const v=await this.version(this.db,id);
  if(v.status!=='draft') throw new ConflictException('请创建草稿后测试');
  await this.validate(this.db,v);
  const signature=await this.signature(this.db,v);
  let result:any={ok:true,validationOnly:true};
  if(v.kind==='tool') {
   if(!input.execute) throw new BadRequestException('工具发布前必须显式执行测试；普通工具会调用当前配置的真实服务');
   const privilege=(await workspaceAccess(this.db,actor,currentWorkspaceId())).permissionCodes.includes('agent_tools.execute');
   if(!privilege) throw new BadRequestException('缺少工具执行测试权限');
   const tool=await this.managedTool(v);
   const parsed=tool.inputSchema.safeParse(input.input);
   if(!parsed.success) throw new BadRequestException('工具测试参数未通过 Schema 校验');
   // This administrative test exercises the question adapter's real contract;
   // it does not create a visitor interaction or grant a production answer.
   // Capability comes from registered code, never a caller-supplied flag.
   const interactionContract=tool.capabilities?.includes('human-question')===true;
   const question=interactionContract?questionSchema.parse(parsed.data):undefined;
   const example=question?.options[0];
   const interactionAnswer=question?{toolCallId:`management-test-${id}`,
    text:example?.label??'管理测试示例回答',...(example?{optionId:example.id}:{})}:undefined;
   const started=Date.now();
   const signal=AbortSignal.timeout(v.config.timeoutMs);
   let timeout:ReturnType<typeof setTimeout>|undefined;
   const execution=await Promise.race([tool.execute(parsed.data,{signal,traceId:`test-${id}-${Date.now()}`,permissions:[v.key],enabledSkillIds:[],approvedTools:input.approved?[v.key]:[],state:new Map(),...(interactionAnswer?{interactionAnswer}:{})}),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Tool test timed out')),v.config.timeoutMs);})]).finally(()=>clearTimeout(timeout)).catch(()=>({success:false,errorCode:'tool_test_failed',content:'执行测试失败，请检查服务连接'}));
   result={ok:execution.success,errorCode:execution.errorCode??null,durationMs:Date.now()-started,content:execution.content.slice(0,4000),...('metadata' in execution?{metadata:execution.metadata}:{}),...(interactionContract?{
    testMode:'interaction_contract',simulatedInteraction:true,
    message:execution.success?'补充信息交互契约验证通过；已使用服务端样例回答，未创建真实用户交互。':'补充信息交互契约验证未通过；样例回答不会绕过工具审批。',
   }:{})};
  }
  await this.recordToolTest(actor,v,signature,result);
  return result;
 }
 /** Shared draft validation/signature boundary for explicit governed tests. */
 async prepareToolTest(id:number) {
  const version=await this.version(this.db,id,'tool');
  if(version.status!=='draft'||!version.enabled)throw new ConflictException('只能测试启用资源的草稿');
  await this.validate(this.db,version);
  return {version,signature:await this.signature(this.db,version),tool:await this.managedTool(version)};
 }
 async assertTestToolAvailable(id:number,published=true) {
  const v=await this.version(this.db,id,'tool',published);
  if(!v.enabled)throw new ConflictException('工具已停用');
 }
 async recordToolTest(actor:number,v:ResourceVersion,signature:string,result:Record<string,unknown>) {
  const id=v.id;
  await this.db.transaction(async c=> {
   await lifecycleWriteLock(c);
   await c.query('SELECT id FROM agent_resource_versions WHERE id=$1 FOR UPDATE',[id]);
   const current=await this.version(c,id);
   if(current.status!=='draft'||current.revision!==v.revision||await this.signature(c,current)!==signature) throw new ConflictException('测试期间草稿发生变化，请重新测试');
   await c.query('UPDATE agent_resource_versions SET tested_revision=$2,test_result=$3 WHERE id=$1',[id,v.revision,JSON.stringify({...result,signature})]);
   await this.audit(c,actor,'agent_resource.tested',id,{ok:result.ok});
  });
  return result;
 }
 /** Prepare or reuse a draft without accumulating empty versions. */
 async agentDraft(actor:number,resourceId:number,body:unknown) {
  const input=this.parse(z.object({fromVersionId:z.number().int().positive().optional()}).strict(),body??{});
  return this.db.transaction(async c=>{
   await lifecycleWriteLock(c);
   const resource=(await c.query('SELECT id,kind,current_version_id::int AS "currentVersionId" FROM agent_resources WHERE id=$1 AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE',[resourceId])).rows[0];
   if(!resource || resource.kind!=='agent')throw new NotFoundException('Agent 不存在');
   if(input.fromVersionId)await this.versionForAgent(c,resourceId,input.fromVersionId);
   const draft=(await c.query("SELECT id::int FROM agent_resource_versions WHERE resource_id=$1 AND status='draft' ORDER BY version DESC LIMIT 1",[resourceId])).rows[0];
   if(draft)return {resourceId,versionId:draft.id,reused:true};
   const sourceId=input.fromVersionId??resource.currentVersionId;
   if(!sourceId)throw new ConflictException('Agent 没有可编辑或已发布版本');
   const source=await this.versionForAgent(c,resourceId,sourceId);
   const n=(await c.query('SELECT coalesce(max(version),0)+1 n FROM agent_resource_versions WHERE resource_id=$1',[resourceId])).rows[0].n;
   const v=(await c.query('INSERT INTO agent_resource_versions(resource_id,version,config,display_name) VALUES($1,$2,$3,$4) RETURNING id::int',[resourceId,n,JSON.stringify(source.config),source.name])).rows[0];
   await this.audit(c,actor,'agent_resource.draft_created',v.id,{fromVersionId:sourceId,resourceId});
   return {resourceId,versionId:v.id,reused:false};
  });
 }
 private async versionForAgent(c:Query,resourceId:number,id:number) {
  const v=await this.version(c,id,'agent');
  if(v.resourceId!==resourceId)throw new BadRequestException('版本必须属于此 Agent');
  return v;
 }
 async publish(actor:number,id:number) {
  return this.db.transaction(async c=> {
   await lifecycleWriteLock(c);
   const found=await this.version(c,id);
   // Resource lock serializes draft preparation, publish and rollback.
   await c.query('SELECT id FROM agent_resources WHERE id=$1 FOR UPDATE',[found.resourceId]);
   await c.query('SELECT id FROM agent_resource_versions WHERE id=$1 FOR UPDATE',[id]);
   const v=await this.version(c,id);
   if(v.status!=='draft') throw new ConflictException('版本已经发布');
   await this.validate(c,v);
   if(v.testedRevision!==v.revision||!v.testResult?.ok||v.testResult.signature!==await this.signature(c,v)) throw new ConflictException('请先测试当前版本，修改后需要重新测试');
   const previous=v.kind==='agent'?(await c.query('SELECT current_version_id::int AS id FROM agent_resources WHERE id=$1',[v.resourceId])).rows[0]?.id:null;
   await c.query("UPDATE agent_resource_versions SET status='published',published_at=now() WHERE id=$1",[id]);
   if(v.kind==='agent') {
    await c.query('UPDATE agent_resources SET current_version_id=$2,name=$3 WHERE id=$1',[v.resourceId,id,v.name]);
    await this.audit(c,actor,'agent_application.activated',id,{agentId:v.resourceId,previousVersionId:previous,versionId:id,reason:'publish'});
   }
   await this.audit(c,actor,'agent_resource.published',id,{version:v.version});return {ok:true,...(v.kind==='agent'?{currentVersionId:id}:{})};
  });
 }
 async activate(actor:number,resourceId:number,body:unknown) {
  const input=this.parse(z.object({versionId:z.number().int().positive(),expectedCurrentVersionId:z.number().int().positive().nullable().optional()}).strict(),body);
  return this.db.transaction(async c=>{
   await lifecycleWriteLock(c);
   const resource=(await c.query('SELECT current_version_id::int AS id FROM agent_resources WHERE id=$1 AND kind=\'agent\' AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE',[resourceId])).rows[0];
   if(!resource)throw new NotFoundException('Agent 不存在');
   if(input.expectedCurrentVersionId!==undefined&&input.expectedCurrentVersionId!==resource.id)throw new ConflictException('生效版本已改变，请刷新后重试');
   const v=await this.versionForAgent(c,resourceId,input.versionId);
   if(v.status!=='published')throw new ConflictException('只能启用已发布版本');
   await this.validate(c,v);
   if(resource.id!==v.id) {
    await c.query('UPDATE agent_resources SET current_version_id=$2,name=$3 WHERE id=$1',[resourceId,v.id,v.name]);
    await this.audit(c,actor,'agent_application.activated',v.id,{agentId:resourceId,previousVersionId:resource.id,versionId:v.id,reason:'rollback'});
   }
   return {ok:true,currentVersionId:v.id};
  });
 }
 /** Deprecated environment endpoint: aliases the single current-version switch. */
 async bind(actor:number,body:unknown,agentId?:number) {
  const input=this.parse(z.object({environment:z.enum(['dev','test','prod']).optional(),mode:z.enum(['single','multi']).default('single'),versionId:z.number().int().positive()}).strict(),body);
  if(input.mode!=='single')throw new BadRequestException('只能启用 Agent 的已发布版本');
  const v=await this.version(this.db,input.versionId,'agent');
  return this.activate(actor,agentId??v.resourceId,{versionId:input.versionId});
 }
 async snapshot(agentId?:number,environment?:'dev'|'test'|'prod'):Promise<CompositionSnapshot> {
  const invocation=invocationScope.getStore();
  if(invocation?.snapshot&&agentId===undefined&&environment===undefined)return invocation.snapshot;
  agentId=agentId??invocation?.agentId;
  return this.buildSnapshot(agentId);
 }
 /** Resume only the original published Agent; never follow a newer activation. */
 async snapshotPinned(agentId:number,versionId:number):Promise<CompositionSnapshot> {
  if(![agentId,versionId].every(v=>Number.isSafeInteger(v)&&v>0))throw new BadRequestException('发布版本标识无效');
  return this.buildSnapshot(agentId,undefined,versionId);
 }
 /** Administrative preview only. Public Run/Chat keep using published snapshots.
  * The revision is mandatory, dependencies remain published, and no resource is activated. */
 async draftSnapshot(agentId:number,versionId:number,revision:number):Promise<CompositionSnapshot> {
  if(![agentId,versionId,revision].every(v=>Number.isSafeInteger(v)&&v>0))throw new BadRequestException('草稿标识无效');
  return this.buildSnapshot(agentId,{versionId,revision});
 }
 private async buildSnapshot(agentId?:number,previewDraft?:{versionId:number;revision:number},pinnedVersionId?:number):Promise<CompositionSnapshot> {
  return this.db.transaction(async c=> {
   await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
   const basePrompts=await this.prompts.snapshot(undefined,c); // No internal Key reads; metadata only.
   if(agentId===undefined) {
    const app=(await c.query('SELECT agent_id::int AS id FROM integration_apps WHERE is_internal LIMIT 1')).rows[0];
    if(!app)throw new BadRequestException('请通过 Agent ID 或绑定了 Agent 的接入应用调用');
    agentId=app.id;
   }
   const binding=(await c.query("SELECT 'single' AS mode,current_version_id::int AS id FROM agent_resources WHERE id=$1 AND kind='agent' AND enabled AND archived_at IS NULL AND deleted_at IS NULL",[agentId])).rows[0];
   if(!binding || (!binding.id&&!previewDraft)) throw new ConflictException('此 Agent 没有生效的已发布版本或已停用');
   const entry=await this.version(c,previewDraft?.versionId??pinnedVersionId??binding.id,'agent',!previewDraft);
   if(entry.resourceId!==agentId)throw new ConflictException('发布版本不属于此 Agent');
   if(previewDraft&&(entry.resourceId!==agentId||entry.status!=='draft'||entry.revision!==previewDraft.revision))throw new ConflictException('草稿已变化或不属于此 Agent，请重新保存并试运行');
   const entrySpec=this.parse(schemas.agent,entry.config);
   const plan:CollaborationSpec|undefined=entrySpec.collaboration?{
     ...entrySpec.collaboration,coordinatorVersionId:entry.id,maxDepth:1,
     maxModelCalls:entrySpec.executionLimits?.maxModelCalls??entrySpec.collaboration.maxModelCalls??32,
     maxToolCalls:entrySpec.executionLimits?.maxToolCalls??entrySpec.collaboration.maxToolCalls??40,
     maxTotalTokens:entrySpec.executionLimits?.maxTotalTokens??entrySpec.collaboration.maxTotalTokens??120000,
     edges:entrySpec.collaboration.memberVersionIds.map(to=>({from:entry.id,to})),
   }:undefined;
   const agentIds=[entry.id,...(plan?.memberVersionIds??[])];
   const agents=new Map<number,ResolvedAgent>();
   for(const id of agentIds) {
    const v=id===entry.id?entry:await this.version(c,id,'agent',true);const spec=this.parse(schemas.agent,v.config);
    await this.validate(c,v);
    const prompt=(await c.query('SELECT v.id::int,v.resource_id::int AS "resourceId",r.prompt_key AS key,v.version,v.template,v.variables FROM prompt_versions v JOIN prompt_resources r ON r.id=v.resource_id WHERE v.id=$1 AND v.status=\'published\'',[spec.promptVersionId])).rows[0];
    if(!prompt) throw new ConflictException('业务 Prompt 未发布');
    const toolVersions=await this.managedToolVersions(c,spec.toolVersionIds);
    const skillVersions:ResourceVersion[]=[];for(const t of spec.skillVersionIds)skillVersions.push(await this.version(c,t,'skill',true));
    const knowledge=(await c.query('SELECT id::int,active_index_version_id::int AS "indexVersionId" FROM knowledge_bases WHERE id=ANY($1::bigint[]) AND archived_at IS NULL AND enabled_for_chat ORDER BY id',[spec.knowledgeBaseIds])).rows;
    const skills=new Map(skillVersions.map(s=>[s.key,freeze(this.skillDefinition(s))]));
    const skillSpecs=new Map<string,SkillSpec>(skillVersions.map(s=>[s.key,freeze(s.config)]));
    const tools=new Map(await Promise.all(toolVersions.map(async t=>[t.key,await this.managedTool(t)] as const)));
    // Skill reading and native member delegation are framework capabilities,
    // not registry tools or host callbacks. Never mount the retired task host.
    for(const name of FOUNDATION_TOOL_KEYS) tools.set(name,this.tools.get(name));
    this.validateWorkflowDependencies(toolVersions,[...tools.keys()]);
    const configuration=parseAgentConfiguration({...this.runtime.agent,identity:{name:v.name,role:spec.responsibility,persona:prompt.template},answeringInstructions:'遵循上述业务指导。',answerInstructions:'遵循业务指导和已经核实的资料整理最终回答。',enabledSkills:[...skills.keys()],runtime:{...spec.runtime,allowedTools:[...tools.keys()]},welcome:spec.welcome,responseStyle:{tone:'professional',detail:'balanced'}});
    const configurationSnapshot=freeze({configuration,revision:agentConfigurationRevision(configuration),configurationVersion:v.version,updatedAt:null,updatedBy:null});
    const delegates = plan ? await Promise.all(plan.edges.filter(e=>e.from===id).map(e=>this.version(c,e.to,'agent',true))) : [];
    const delegationHints=delegates.map(d=>`- ${d.key}：${d.name}。职责：${d.config.responsibility}`).join('\n');
    const promptSnapshot=freeze({...basePrompts,delegationHints,businessPrompt:prompt.template,prompts:{...basePrompts.prompts,[prompt.key]:{key:prompt.key,resourceId:prompt.resourceId,versionId:prompt.id,version:prompt.version,template:prompt.template,variables:{},environment:basePrompts.environment,source:'managed' as const}}});
    const modelPlan:PlanVersion|null=spec.modelPlanVersionId?(await c.query<PlanVersion>("SELECT v.*,v.id::int,v.plan_id::int,p.kind,p.name FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE v.id=$1 AND v.status='published' AND p.kind='llm' AND p.deleted_at IS NULL AND p.archived_at IS NULL",[spec.modelPlanVersionId])).rows[0]??null:null;
    if(!modelPlan) throw new ConflictException('Agent 模型方案不可用');
    const selectedEmbedding=['vector','hybrid'].includes(spec.retrieval.retrievalMode)&&spec.embeddingPlanVersionId?await this.agentEmbedding(c,spec.embeddingPlanVersionId):null;
    agents.set(id,freeze({embeddingPlan:selectedEmbedding?.plan??null,embeddingProfile:selectedEmbedding?.profile,version:v,spec,configurationSnapshot,promptSnapshot,modelPlan,tools,skills,skillSpecs,knowledge:knowledge as ResolvedAgent['knowledge']}));
   }
   return freeze({workspaceId:currentWorkspaceId(),agentId:agentId!,environment:basePrompts.environment,mode:plan?'multi':'single',entryVersionId:entry.id,...(previewDraft?{previewDraft}:{}),collaboration:plan,agents,createdAt:new Date().toISOString()});
  });
 }
 async prepareMemory(conversationId:string,snapshot:CompositionSnapshot):Promise<number> {
  const scope=agentMemoryScope(snapshot);
  return this.db.transaction(async c=> {
   await lifecycleWriteLock(c);
   const row=(await c.query('SELECT agent_memory_scope,agent_memory_boundary_id FROM conversations WHERE id=$1 FOR UPDATE',[conversationId])).rows[0];
   if(!row) throw new NotFoundException('会话不存在');
   if(row.agent_memory_scope===scope) return Number(row.agent_memory_boundary_id);
   const boundary=Number((await c.query('SELECT coalesce(max(id),0) n FROM conversation_messages WHERE conversation_id=$1',[conversationId])).rows[0].n);
   await c.query("UPDATE conversations SET agent_memory_scope=$2,agent_memory_boundary_id=$3,summary='',summary_through_message_id=$3 WHERE id=$1",[conversationId,scope,boundary]);
   return boundary;
  });
 }
 private skillDefinition(v:ResourceVersion):SkillDefinition {
  const config=skillSchema.parse(v.config);
  return {id:v.key,versionId:v.id,resourceId:v.resourceId,name:v.name,version:String(v.version),description:config.description,systemInstructions:config.instructions,resources:config.resources};
 }
 private async audit(c:Query,actor:number,action:string,id:number,details:unknown) {
  await c.query('INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,$2,\'agent_resource\',$3,$4)',[actor,action,String(id),JSON.stringify(details)]);
 }
 private async managedTool(version:ResourceVersion) {
  if(this.externalTools)return this.externalTools.managedTool(version,key=>this.tools.get(key));
  if(version.config.mcpVersionId)throw new BadRequestException('远程 MCP 管理模块不可用');
  return makeManagedTool(version,key=>this.tools.get(key));
 }
}
