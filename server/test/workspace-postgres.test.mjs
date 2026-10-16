import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { DatabaseService } from '../dist/database.service.js';
import { ManagementOverviewService } from '../dist/admin/management-overview.service.js';
import { WorkspaceService } from '../dist/workspaces/workspace.service.js';
import { inWorkspace } from '../dist/workspaces/workspace-context.js';
import { PromptService } from '../dist/prompts/prompt.service.js';
import { PromptRuntimeService } from '../dist/prompts/prompt-runtime.service.js';
import { AgentManagementService } from '../dist/agent-management/agent-management.service.js';
import { ToolRegistry } from '../dist/ai/tools/tool-registry.js';
import { SkillRegistry } from '../dist/ai/skills/skill-registry.js';
import { DEFAULT_AGENT_CONFIGURATION } from '../dist/config/agent-config.js';
import { documentPath } from '../dist/documents/document-storage.js';
import { LoadSkillTool } from '../dist/ai/tools/load-skill.tool.js';
import { KnowledgeSearchTool } from '../dist/ai/tools/knowledge-search.tool.js';

test('PostgreSQL runtime role: workspace RLS, membership, references, Agent snapshots, independent copies and storage', {skip:process.env.KB_INTEGRATION!=='1'},async()=>{
 const url=process.env.DATABASE_URL;
 const root=new Client({connectionString:url});await root.connect();
 const schema='workspace_test_'+randomUUID().replaceAll('-','');let db;
 try{
  await root.query('BEGIN');await root.query(`CREATE SCHEMA ${schema}`);await root.query(`SET LOCAL search_path TO ${schema},public`);
  const directory=new URL('../migrations/',import.meta.url);
  for(const f of (await readdir(directory)).filter(f=>f.endsWith('.sql')).sort())await root.query((await readFile(new URL(f,directory),'utf8')).split('-- Down Migration')[0]);
  await root.query('COMMIT');
  const scopedUrl=new URL(url);scopedUrl.searchParams.set('options',`-csearch_path=${schema},public`);
  db=new DatabaseService({databaseUrl:scopedUrl.toString()});
  const actor=Number((await db.platformQuery("INSERT INTO admins(email,password_hash,display_name) VALUES('owner@fixture.invalid','fixture','owner') RETURNING id")).rows[0].id);
  const reader=Number((await db.platformQuery("INSERT INTO admins(email,password_hash,display_name) VALUES('reader@fixture.invalid','fixture','reader') RETURNING id")).rows[0].id);
  const workspaces=new WorkspaceService(db);const a=await workspaces.create(actor,{name:'A'}),b=await workspaces.create(actor,{name:'B'});
  await workspaces.setMember(actor,a.id,{adminId:reader,role:'reader'});
  assert.ok((await workspaces.access(reader,a.id)).permissionCodes.includes('prompts.read'));
  assert.equal((await workspaces.access(reader,a.id)).permissionCodes.includes('prompts.manage'),false);
  await assert.rejects(workspaces.access(reader,b.id),e=>e.getStatus()===403);
  await assert.rejects(workspaces.setMember(reader,a.id,{adminId:actor,role:'reader'}),e=>e.getStatus()===403);
  const info=await workspaces.updateInfo(actor,a.id,{name:'  A renamed  ',description:'Organised workspace',expected:{name:'A',description:''}});
  assert.deepEqual(info,{id:a.id,name:'A renamed',description:'Organised workspace'});
  await assert.rejects(workspaces.updateInfo(actor,a.id,{name:'stale',description:'',expected:{name:'A',description:''}}),e=>e.getStatus()===409);
  await assert.rejects(workspaces.updateInfo(reader,a.id,{name:'forged',expected:{name:'A renamed',description:'Organised workspace'}}),e=>e.getStatus()===403);
  await assert.rejects(workspaces.updateInfo(actor,a.id,{name:'  ',expected:{name:'A renamed',description:'Organised workspace'}}),e=>e.getStatus()===400);
  assert.equal((await workspaces.list(reader))[0].name,'A renamed');
  const vectorPlan=await inWorkspace(a.id,async()=>{
    const version=Number((await db.query("WITH p AS (INSERT INTO model_plans(kind,name) VALUES('embedding','Workspace vectors') RETURNING id) INSERT INTO model_plan_versions(plan_id,version,status,config) SELECT id,1,'published','{\"deployments\":[]}' FROM p RETURNING id")).rows[0].id);
    await db.query("INSERT INTO embedding_profiles(name,config,model_plan_version_id) VALUES('Workspace vectors','{\"provider\":\"openai-compatible\",\"baseUrl\":\"https://vectors.invalid/v1\",\"model\":\"fixture\",\"dimensions\":2}',$1)",[version]);
    return version;
  });
  await workspaces.saveSettings(actor,a.id,{defaultEmbeddingPlanVersionId:vectorPlan});
  assert.equal((await workspaces.settings(actor,a.id)).defaultEmbeddingPlanVersionId,vectorPlan);
  await assert.rejects(workspaces.saveSettings(actor,a.id,{defaultEmbeddingPlanVersionId:null,expectedDefaultEmbeddingPlanVersionId:null}),e=>e.getStatus()===409);
  await workspaces.saveSettings(actor,a.id,{defaultEmbeddingPlanVersionId:null,expectedDefaultEmbeddingPlanVersionId:vectorPlan});
  await workspaces.saveSettings(actor,a.id,{defaultEmbeddingPlanVersionId:vectorPlan,expectedDefaultEmbeddingPlanVersionId:null});
  await assert.rejects(workspaces.saveSettings(reader,a.id,{defaultEmbeddingPlanVersionId:null}),e=>e.getStatus()===403);
  await assert.rejects(workspaces.saveSettings(actor,b.id,{defaultEmbeddingPlanVersionId:vectorPlan}),e=>e.getStatus()===400);
  const prompts=new PromptService(db),runtime=new PromptRuntimeService(prompts);
  const tools=new ToolRegistry(),skills=new SkillRegistry();
  tools.register(new LoadSkillTool(skills));
  tools.register(new KnowledgeSearchTool({searchForAgent:async()=>({hits:[],retrievalMode:'lexical-only',vectorIndexedChunks:0})}));
  const agents=new AgentManagementService(db,{agent:DEFAULT_AGENT_CONFIGURATION},tools,skills,runtime,{});
  async function fixture(space,label){return inWorkspace(space,async()=>{
   assert.equal((await db.query('SELECT current_user')).rows[0].current_user,'agent_studio_workspace_runtime');
   const p=await prompts.create(actor,{promptKey:'shared.business',name:label,promptType:'system'});
   const pv=(await prompts.get(p.id)).versions[0];await prompts.updateDraft(actor,pv.versionId,{template:label,variables:{}});await prompts.publish(actor,pv.versionId);
   const model=Number((await db.query("WITH p AS (INSERT INTO model_plans(kind,name) VALUES('llm',$1) RETURNING id) INSERT INTO model_plan_versions(plan_id,version,status,config) SELECT id,1,'published','{\"deployments\":[]}' FROM p RETURNING id",[label])).rows[0].id);
   const kb=Number((await db.query('UPDATE knowledge_bases SET enabled_for_chat=true WHERE is_default RETURNING id')).rows[0].id);
   const skill=await agents.create(actor,{kind:'skill',key:'shared_skill',name:label+' Skill',config:{document:`---\nname: shared-skill\ndescription: Read references when needed\n---\n\nRead references/guide.md.`,resources:[{path:'references/guide.md',content:`PRIVATE_REFERENCE_${label}`} ]}});
   await agents.test(actor,skill.versionId,{});await agents.publish(actor,skill.versionId);
   const config={responsibility:label,promptVersionId:pv.versionId,modelPlanVersionId:model,toolVersionIds:[],skillVersionIds:[skill.versionId],knowledgeBaseIds:[kb],runtime:{maxToolCalls:8,maxPlannerRounds:12,toolTimeoutMs:30000,maxToolResultChars:16000}};
   const agent=await agents.create(actor,{kind:'agent',key:'shared_agent',name:label,config});await agents.test(actor,agent.versionId,{});await agents.publish(actor,agent.versionId);await agents.bind(actor,{environment:'dev',mode:'single',versionId:agent.versionId},agent.resourceId);
   return {p,pv,model,kb,skill,agent,config,snapshot:await agents.snapshot(agent.resourceId,'dev')};
  });}
  const fa=await fixture(a.id,'Alpha'),fb=await fixture(b.id,'Beta');
  assert.equal(fa.snapshot.workspaceId,a.id);assert.equal(fb.snapshot.workspaceId,b.id);
  assert.notEqual(fa.snapshot.agents.get(fa.agent.versionId).modelPlan.id,fb.snapshot.agents.get(fb.agent.versionId).modelPlan.id);
  const alphaSkill=fa.snapshot.agents.get(fa.agent.versionId).skills.get('shared_skill');
  assert.equal(alphaSkill.versionId,fa.skill.versionId);assert.equal(alphaSkill.resources[0].content,'PRIVATE_REFERENCE_Alpha');
  assert.throws(()=>{alphaSkill.resources[0].content='forged';},TypeError);
  assert.equal(fb.snapshot.agents.get(fb.agent.versionId).skills.get('shared_skill').resources[0].content,'PRIVATE_REFERENCE_Beta');
  await inWorkspace(a.id,async()=>{
   assert.equal((await db.query('SELECT id FROM prompt_resources WHERE id=$1',[fb.p.id])).rowCount,0);
   await assert.rejects(agents.snapshot(fb.agent.resourceId,'dev'),e=>e.getStatus()===409);
   await assert.rejects(agents.skillDocument(fb.skill.versionId),e=>e.getStatus()===404);
   const largeSkillIds=[];
   for(let i=0;i<4;i++) {
    const extra=await agents.create(actor,{kind:'skill',key:`extra_skill_${i}`,name:`Extra ${i}`,config:{document:`---\nname: extra-skill-${i}\ndescription: Bounded resource fixture\n---\n\nRead authorised references.`,resources:Array.from({length:16},(_,n)=>({path:`references/${n}.md`,content:'small'}))}});
    await agents.test(actor,extra.versionId,{});await agents.publish(actor,extra.versionId);largeSkillIds.push(extra.versionId);
   }
   const oversized=await agents.create(actor,{kind:'agent',key:'file_limit_agent',name:'File cap fixture',config:{...fa.config,skillVersionIds:largeSkillIds}});
   await assert.rejects(agents.test(actor,oversized.versionId,{}),e=>e.getStatus()===400&&e.message.includes('工作区限制'));
   await assert.rejects(db.query('INSERT INTO prompt_versions(resource_id,version,template) VALUES($1,99,\'cross\')',[fb.p.id]),e=>e.code==='23503');
   await assert.rejects(db.query('INSERT INTO agent_resource_versions(resource_id,version,config) VALUES($1,99,$2)',[fa.agent.resourceId,JSON.stringify({...fa.config,promptVersionId:fb.pv.versionId})]),e=>e.code==='23503');
   const clone=await agents.clone(actor,fa.agent.versionId);await agents.test(actor,clone.versionId,{});await agents.publish(actor,clone.versionId);await agents.bind(actor,{environment:'dev',mode:'single',versionId:clone.versionId},fa.agent.resourceId);
   assert.equal(fa.snapshot.entryVersionId,fa.agent.versionId);assert.equal((await agents.snapshot(fa.agent.resourceId,'dev')).entryVersionId,clone.versionId);
   assert.throws(()=>documentPath(`${b.id}/${randomUUID()}.pdf`,{uploadRoot:'/tmp'}));
   assert.ok(documentPath(`${a.id}/${randomUUID()}.pdf`,{uploadRoot:'/tmp'}).includes(`/documents/${a.id}/`));
  });
  // Copy into a clean space: all dependencies are recreated, never bound or published.
  const c=await workspaces.create(actor,{name:'C'});await workspaces.copy(actor,a.id,{targetWorkspaceId:c.id,kind:'agent',id:fa.agent.resourceId});
  await inWorkspace(c.id,async()=>{
   const copied=(await agents.list()).resources[0];const v=(await agents.get(copied.id)).versions[0];assert.equal(v.status,'draft');assert.notEqual(v.config.promptVersionId,fa.pv.versionId);assert.notEqual(v.config.modelPlanVersionId,fa.model);
   assert.equal((await db.query('SELECT 1 FROM agent_environment_bindings')).rowCount,0);
   for(const table of ['conversations','documents','integration_apps'])assert.equal((await db.query(`SELECT 1 FROM ${table}`)).rowCount,0);
   const copiedSkill=(await agents.get((await agents.list()).resources.find(r=>r.kind==='skill').id)).versions[0];
   assert.equal(copiedSkill.status,'draft');assert.deepEqual(copiedSkill.config.resources,[{path:'references/guide.md',content:'PRIVATE_REFERENCE_Alpha'}]);
  });
  await inWorkspace(a.id,async()=>{
    const prepared=await agents.skillDraft(actor,fa.skill.resourceId,{});
    let row=(await agents.list()).resources.find(r=>r.id===fa.skill.resourceId);
    assert.equal(row.hasUnpublishedChanges,false,'preparing an identical reusable-resource draft is not a change');
    assert.equal(row.versions.find(v=>v.id===fa.skill.versionId).description,'Read references when needed');
    const draft=(await agents.get(fa.skill.resourceId)).versions.find(v=>v.id===prepared.versionId);
    await agents.update(actor,draft.id,{revision:draft.revision,config:{...draft.config,document:draft.config.document.replace('Read references when needed','Updated guidance')}});
    row=(await agents.list()).resources.find(r=>r.id===fa.skill.resourceId);
    assert.equal(row.hasUnpublishedChanges,true);
    assert.equal(row.versions.find(v=>v.id===fa.skill.versionId).description,'Read references when needed','published list facts remain intact');
    assert.equal(fa.snapshot.agents.get(fa.agent.versionId).skills.get('shared_skill').description,'Read references when needed');
  });
  const overview=new ManagementOverviewService(db);
  await inWorkspace(b.id,async()=>{
    const result=await overview.overview((await workspaces.access(actor,b.id)).permissionCodes);
    assert.equal(result.agents.total,1);
    assert.equal(result.agents.published,1);
    assert.equal(result.agents.changed,0);
    assert.equal(result.agents.recent[0].name,'Beta');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_REFERENCE_'));
    assert.deepEqual(result.knowledge.documentFailures,[]);
    assert.equal(result.executions.total,0);
    const hidden=await overview.overview([]);
    assert.equal(hidden.agents,null);assert.equal(hidden.knowledge,null);assert.equal(hidden.executions,null);
  });
  await workspaces.status(actor,a.id,false);await assert.rejects(workspaces.access(actor,a.id),e=>e.getStatus()===403);
  await inWorkspace(a.id,async()=>assert.equal((await db.query('SELECT 1 FROM prompt_resources')).rowCount,0));
  assert.ok((await db.platformQuery("SELECT 1 FROM audit_logs WHERE action='workspace.member_updated'")).rowCount);
 }finally{if(db)await db.onModuleDestroy();await root.query('ROLLBACK');await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await root.end();}
});
