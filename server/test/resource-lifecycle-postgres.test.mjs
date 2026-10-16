import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Client} from 'pg';
import {z} from 'zod';
import {AgentManagementService} from '../dist/agent-management/agent-management.service.js';
import {ToolManagementService} from '../dist/tool-management/tool-management.service.js';
import {ModelManagementService} from '../dist/model-management/model-management.service.js';
import {ToolRegistry} from '../dist/ai/tools/tool-registry.js';
import {SkillRegistry} from '../dist/ai/skills/skill-registry.js';
import {changeResourceLifecycle,resourceReferences,resourceState} from '../dist/agent-management/resource-lifecycle.js';
import {PERMISSION_KEY} from '../dist/admin/permission.decorator.js';
import {AgentManagementController} from '../dist/agent-management/agent-management.controller.js';
import {ToolManagementController} from '../dist/tool-management/tool-management.controller.js';

test('lifecycle state filters and mutation permissions are explicit',()=>{
 assert.equal(resourceState(undefined),'active');assert.equal(resourceState('deleted'),'deleted');assert.throws(()=>resourceState('invalid'),e=>e.getStatus()===400);
 for(const c of [AgentManagementController,ToolManagementController])for(const m of ['archive','remove','restore'])assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY,c.prototype[m]),['agent_config.manage']);
});

test('PostgreSQL unified lifecycle: current/draft/history, model release, MCP dependencies, restore and immutable history',{skip:process.env.KB_INTEGRATION!=='1'},async t=>{
 const c=new Client({host:process.env.POSTGRES_HOST??'127.0.0.1',port:Number(process.env.POSTGRES_PORT??5433),user:process.env.POSTGRES_USER??'grounded',password:process.env.POSTGRES_PASSWORD,database:process.env.POSTGRES_DB??'agent_studio'});await c.connect();
 try{
  await c.query('BEGIN');const schema='lifecycle_'+randomUUID().replaceAll('-','');await c.query(`CREATE SCHEMA "${schema}"`);await c.query(`SET LOCAL search_path TO "${schema}", public`);
  const dir=new URL('../migrations/',import.meta.url);for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await c.query((await readFile(new URL(f,dir),'utf8')).split('-- Down Migration')[0]);
  const actor=(await c.query("INSERT INTO admins(email,password_hash,display_name) VALUES('lifecycle@example.invalid','fixture','Lifecycle') RETURNING id::int")).rows[0].id;
  const db={query:(sql,args)=>c.query(sql,args),transaction:async fn=>{await c.query('SAVEPOINT call');try{const result=await fn(c);await c.query('RELEASE SAVEPOINT call');return result;}catch(e){await c.query('ROLLBACK TO SAVEPOINT call');await c.query('RELEASE SAVEPOINT call');throw e;}}};
  const tools=new ToolRegistry();tools.register({name:'lookup',description:'lookup',inputSchema:z.object({}),execute:async()=>({success:true,content:'fixture'})});
  const manager=new AgentManagementService(db,{},tools,new SkillRegistry(),{},{}),mcp=new ToolManagementService(db,{}),models=new ModelManagementService(db,{},{});
  const plan=(await c.query("WITH p AS(INSERT INTO model_plans(kind,name)VALUES('llm','Unused fixture')RETURNING id) INSERT INTO model_plan_versions(plan_id,version,status,config)SELECT id,1,'published','{\"deployments\":[]}' FROM p RETURNING id::int,plan_id::int")).rows[0];
  const make=async(kind,key,config,status='published')=>{const id=(await c.query('INSERT INTO agent_resources(kind,resource_key,name)VALUES($1,$2,$2)RETURNING id::int',[kind,key])).rows[0].id;const v=(await c.query('INSERT INTO agent_resource_versions(resource_id,version,status,config)VALUES($1,1,$2,$3)RETURNING id::int',[id,status,JSON.stringify(config)])).rows[0].id;return {id,v};};
  const tool=await make('tool','lookup',{type:'builtin',target:'lookup'});
  const skill=await make('skill','specialist',{description:'Guide',category:'',instructions:'guide',permissionMode:'agent',allowedTools:[],allowedKnowledgeBaseIds:[],disableModelInvocation:false});
  const agent=await make('agent','support',{modelPlanVersionId:plan.id,toolVersionIds:[tool.v],skillVersionIds:[skill.v]});await c.query('UPDATE agent_resources SET current_version_id=$2 WHERE id=$1',[agent.id,agent.v]);
  await c.query("INSERT INTO model_bindings(purpose,version_id) VALUES('default',$1)",[plan.id]);
  await t.test('active references protect Skill/Tool, including disabled but resumable Agents',async()=>{
   await assert.rejects(manager.lifecycle(actor,skill.id,'delete'),e=>e.getStatus()===409);
   await assert.rejects(models.remove(actor,'llm','plans',plan.plan_id),e=>e.getStatus()===409);
   assert.equal((await c.query('SELECT version_id::int FROM model_bindings')).rows[0].version_id,plan.id);
   await c.query('UPDATE agent_resources SET enabled=false WHERE id=$1',[agent.id]);
   await assert.rejects(manager.lifecycle(actor,tool.id,'archive'),e=>e.getStatus()===409);
   assert.ok((await resourceReferences(c,'skill',skill.id)).some(r=>r.usage==='current'));
  });
  await t.test('application bindings protect Agent deletion; removal releases model references',async()=>{
   const app=(await c.query("INSERT INTO integration_apps(id,name,agent_id)VALUES($1,'Bound app',$2)RETURNING id",[randomUUID(),agent.id])).rows[0].id;
   await assert.rejects(manager.lifecycle(actor,agent.id,'delete'),e=>e.getStatus()===409&&e.getResponse().references.some(r=>r.type==='application'));
   await c.query('DELETE FROM integration_apps WHERE id=$1',[app]);
   const before=(await c.query('SELECT config FROM agent_resource_versions WHERE id=$1',[agent.v])).rows[0].config;
   await c.query("INSERT INTO agent_resource_versions(resource_id,version,status,config) SELECT resource_id,2,'draft',config FROM agent_resource_versions WHERE id=$1",[agent.v]);
   await manager.lifecycle(actor,agent.id,'delete');
   assert.ok(!(await manager.list()).resources.some(r=>r.id===agent.id));assert.ok((await manager.list('deleted')).resources.some(r=>r.id===agent.id));
   assert.ok((await manager.get(agent.id)).deletedAt);
   await assert.rejects(manager.agentDraft(actor,agent.id,{}),e=>e.getStatus()===404);
   await assert.rejects(manager.enable(actor,agent.id,true),e=>e.getStatus()===404);
   await assert.rejects(manager.activate(actor,agent.id,{versionId:agent.v}),e=>e.getStatus()===404);
   const refs=await models.references('llm','plans',plan.plan_id);assert.ok(refs.some(r=>r.type==='agent'&&r.usage==='historical'));assert.ok(!refs.some(r=>r.usage==='current'));
   assert.ok(refs.some(r=>r.type==='binding'&&r.usage==='automatic'));
   models.workspacePlans.set(1,{id:plan.id});
   const removal=await models.remove(actor,'llm','plans',plan.plan_id);
   assert.equal(removal.archived,true,'historical model references do not block removal');
   assert.equal(removal.defaultCleared,true);
   assert.equal((await c.query('SELECT 1 FROM model_bindings')).rows.length,0);
   assert.equal(models.currentPlan,null);
   assert.deepEqual((await c.query('SELECT config FROM agent_resource_versions WHERE id=$1',[agent.v])).rows[0].config,before);
   await manager.lifecycle(actor,agent.id,'restore');const restored=await manager.get(agent.id);assert.equal(restored.enabled,false);assert.equal(restored.currentVersionId,null);
  });
  await t.test('draft references warn but do not block; deleted dependencies cannot be published or cloned',async()=>{
   const draft=await make('agent','working',{toolVersionIds:[tool.v],skillVersionIds:[skill.v]},'draft');
   assert.ok((await resourceReferences(c,'skill',skill.id)).some(r=>r.versionId===draft.v&&r.usage==='draft'));
   await manager.lifecycle(actor,skill.id,'archive');await manager.lifecycle(actor,tool.id,'delete');
   assert.ok((await manager.list('archived')).resources.some(r=>r.id===skill.id));
   assert.ok((await manager.skillDocument(skill.v)).document.includes('guide'),'removed Skills remain available for read-only history export');
   await assert.rejects(manager.clone(actor,tool.v),e=>e.getStatus()===404);
   await assert.rejects(manager.test(actor,draft.v,{}));
   await manager.lifecycle(actor,skill.id,'restore');assert.equal((await manager.get(skill.id)).enabled,false);
   const legacy=await make('skill','legacy_specialist',{description:'Guide',instructions:'Guide',category:'',permissionMode:'legacy',allowedTools:['lookup'],allowedKnowledgeBaseIds:[],disableModelInvocation:false});
   await manager.lifecycle(actor,legacy.id,'archive');await manager.lifecycle(actor,legacy.id,'restore');
   await manager.enable(actor,legacy.id,true);assert.equal((await manager.get(legacy.id)).enabled,true,'a guidance-only Skill does not depend on a deleted Tool; Agent remains the grant authority');
  });
  await t.test('MCP protects published/pinned Tools, allows history-only removal and restores disabled',async()=>{
   const id=(await c.query("INSERT INTO mcp_servers(server_key,name)VALUES('remote','Remote')RETURNING id::int")).rows[0].id;
   const v=(await c.query('INSERT INTO mcp_server_versions(server_id,version,config)VALUES($1,1,$2)RETURNING id::int',[id,JSON.stringify({url:'https://example.invalid/mcp',timeoutMs:30000})])).rows[0].id;
   const remote=await make('tool','remote_lookup',{type:'mcp',target:'lookup',mcpVersionId:v});
   await assert.rejects(mcp.lifecycle(actor,id,'delete'),e=>e.getStatus()===409);
   await manager.lifecycle(actor,remote.id,'archive');await mcp.lifecycle(actor,id,'archive');
   assert.ok(!(await mcp.servers()).servers.some(s=>s.id===id));assert.ok((await mcp.servers('archived')).servers.some(s=>s.id===id));assert.ok((await mcp.server(id)).archivedAt);
   await assert.rejects(mcp.connectionVersion(v),e=>e.getStatus()===404);
   await mcp.lifecycle(actor,id,'delete');await mcp.lifecycle(actor,id,'restore');assert.equal((await mcp.connectionVersion(v)).enabled,false);
  });
  await t.test('platform foundations are protected and missing/foreign resources cannot be mutated',async()=>{
   const foundation=await make('tool','load_skill',{type:'builtin',target:'load_skill'});
   await assert.rejects(manager.lifecycle(actor,foundation.id,'delete'),e=>e.getStatus()===400);
   await assert.rejects(changeResourceLifecycle(c,actor,'agent',tool.id,'delete'),e=>e.getStatus()===404);
   assert.ok((await c.query("SELECT 1 FROM audit_logs WHERE action='agent.delete'")).rows.length);
  });
 }finally{await c.query('ROLLBACK');await c.end();}
});
