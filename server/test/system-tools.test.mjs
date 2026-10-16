import { nativeChat } from "./helpers/native-chat.mjs";
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { AgentManagementService } from '../dist/agent-management/agent-management.service.js';
import { FOUNDATION_TOOL_KEYS, RETIRED_TASK_TOOL_KEYS, SYSTEM_TOOL_KEYS } from '../dist/agent-management/system-tools.js';
import { DEFAULT_AGENT_CONFIGURATION } from '../dist/config/agent-config.js';
import { ToolRegistry } from '../dist/ai/tools/tool-registry.js';
import { SkillRegistry } from '../dist/ai/skills/skill-registry.js';
import { LoadSkillTool } from '../dist/ai/tools/load-skill.tool.js';
import { KnowledgeSearchTool } from '../dist/ai/tools/knowledge-search.tool.js';
import { runtimeScope } from '../dist/agent-management/runtime-scope.js';
import { ToolsModule } from '../dist/ai/tools/tools.module.js';
import { SpecializedWorkflowRegistry } from '../dist/ai/workflows/specialized-workflow.js';

const native = name => ({name,description:name,inputSchema:z.object({}),execute:async()=>({success:true,content:'code-owned'})});
const resource = (key,id=1) => ({id,resourceId:id,key,kind:'tool',name:key,enabled:false,status:'published',version:1,config:{type:'builtin',target:key}});

test('production tool module registers no retired recursive task implementation',()=>{
  const registry=new ToolRegistry();
  const module=new ToolsModule(registry,native('search_knowledge'),native('load_skill'),new SpecializedWorkflowRegistry());
  module.onModuleInit();
  for(const name of RETIRED_TASK_TOOL_KEYS)assert.equal(registry.has(name),false);
  for(const name of FOUNDATION_TOOL_KEYS)assert.equal(registry.has(name),true);
});
function service(query) {
  const db={query,transaction:work=>work({query})};
  const tools=new ToolRegistry();
  for(const name of [...FOUNDATION_TOOL_KEYS,'get_order'])tools.register(native(name));
  return {tools,management:new AgentManagementService(db,{agent:DEFAULT_AGENT_CONFIGURATION},tools,new SkillRegistry(),{snapshot:async()=>({environment:'dev',prompts:{}})}, {})};
}

test('foundation tools are absent from management lists/options and detail routes',async()=>{
  const rows=[resource('search_knowledge'),resource('load_skill',2),resource('get_order',3),resource('run_skill',4),resource('delegate_agent',5)];
  const {management}=service(async sql=>({rows:sql.includes('jsonb_agg')?rows:sql.includes('WHERE r.id=$1')?[rows[0]]:[]}));
  assert.deepEqual((await management.list()).resources.map(r=>r.key),['get_order']);
  assert.deepEqual((await management.options()).tools.map(t=>t.key),['get_order']);
  await assert.rejects(management.get(1),e=>e.getStatus()===404);
});

test('managed resources cannot occupy system names or alias the code-owned implementations',async()=>{
  const {management}=service(async()=>{throw Error('must reject before writing');});
  for(const key of SYSTEM_TOOL_KEYS) {
    await assert.rejects(management.create(1,{kind:'tool',key,name:key,config:{type:'rest'}}),e=>e.getStatus()===400);
  }
  for(const target of SYSTEM_TOOL_KEYS) {
    await assert.rejects(management.create(1,{kind:'tool',key:'custom_alias',name:'Alias',config:{type:'builtin',target}}),e=>e.getStatus()===400);
  }
});

test('legacy foundation resources cannot be edited, cloned or disabled',async()=>{
  for(const key of FOUNDATION_TOOL_KEYS) {
    const row=resource(key);
    let writes=0;
    const {management}=service(async sql=>{
      if(/^\s*(UPDATE|INSERT)\b/.test(sql))writes++;
      return {rows:sql.includes('FROM agent_resource_versions')||sql.includes('SELECT kind,resource_key')?[row]:[]};
    });
    await assert.rejects(management.update(1,1,{revision:1,config:{}}),e=>e.getStatus()===400);
    await assert.rejects(management.clone(1,1),e=>e.getStatus()===400);
    await assert.rejects(management.enable(1,1,false),e=>e.getStatus()===400);
    assert.equal(writes,0);
  }
});

test('every Agent snapshot gets both native foundation tools even with no configured tools or resources',async()=>{
  const config={responsibility:'support',promptVersionId:10,modelPlanVersionId:20,toolVersionIds:[],skillVersionIds:[],knowledgeBaseIds:[],runtime:{},welcome:DEFAULT_AGENT_CONFIGURATION.welcome};
  const entry={id:30,resourceId:3,key:'support',kind:'agent',name:'Support',enabled:true,status:'published',version:1,config};
  const {management,tools}=service(async sql=>({rows:
    sql.includes("'single' AS mode")?[{mode:'single',id:30}]:
    sql.includes('r.prompt_key AS key')?[{id:10,resourceId:1,key:'business.support',version:1,template:'Business prompt',variables:{}}]:
    sql.includes('FROM model_plan_versions v JOIN model_plans p')?[{id:20,status:'published',kind:'llm',name:'Pinned fixture',version:1,config:{deployments:[]}}]:[]
  }));
  management.version=async()=>entry;
  management.validate=async()=>{};
  const snapshot=await management.snapshot(3,'dev');
  const agent=snapshot.agents.get(30);
  assert.equal(agent.modelPlan.id,config.modelPlanVersionId);
  assert.deepEqual([...agent.tools.keys()],FOUNDATION_TOOL_KEYS);
  assert.deepEqual(agent.configurationSnapshot.configuration.runtime.allowedTools,FOUNDATION_TOOL_KEYS);
  for(const name of FOUNDATION_TOOL_KEYS)assert.equal(agent.tools.get(name),tools.get(name));
  assert.deepEqual(agent.knowledge,[]);
  assert.equal(agent.skills.size,0);
});

test('disabled historical foundation bindings do not override code or block Agent resolution',async()=>{
  const rows=[resource('search_knowledge'),resource('load_skill',2),{...resource('get_order',3),enabled:true},resource('run_skill',4),resource('delegate_agent',5)];
  const {management}=service(async(_sql,args)=>({rows:[rows.find(r=>r.id===args[0])]}));
  assert.deepEqual((await management.managedToolVersions({query:management.db.query},[1,2,3,4,5])).map(r=>r.key),['get_order']);
  rows[2].enabled=false;
  await assert.rejects(management.managedToolVersions({query:management.db.query},[3]),e=>e.getStatus()===409);
});

test('Skill and member snapshots need no task tools or injected recursive host callbacks',async()=>{
  const spec={responsibility:'Entry',promptVersionId:10,modelPlanVersionId:20,toolVersionIds:[],skillVersionIds:[40],knowledgeBaseIds:[],runtime:{},collaboration:{memberVersionIds:[31]}};
  const entry={id:30,resourceId:3,key:'entry',kind:'agent',name:'Entry',enabled:true,status:'published',version:1,config:spec};
  const member={...entry,id:31,resourceId:4,key:'member',config:{...spec,responsibility:'Member',collaboration:null}};
  const guide={id:40,resourceId:5,key:'guide',kind:'skill',name:'Guide',enabled:true,status:'published',version:1,config:{description:'Published guidance',instructions:'Read only; names do not grant execution.'}};
  const {management}=service(async sql=>({rows:
    sql.includes("'single' AS mode")?[{mode:'single',id:30}]:
    sql.includes('r.prompt_key AS key')?[{id:10,resourceId:1,key:'business.task',version:1,template:'Complete task',variables:{}}]:
    sql.includes('FROM model_plan_versions v JOIN model_plans p')?[{id:20,status:'published',kind:'llm',name:'Pinned fixture',version:1,config:{deployments:[]}}]:[]
  }));
  management.version=async(_query,id)=>new Map([[30,entry],[31,member],[40,guide]]).get(id);
  management.validate=async()=>{};
  const snapshot=await management.snapshot(3);
  assert.equal(snapshot.mode,'multi');
  assert.deepEqual(snapshot.collaboration.edges,[{from:30,to:31}]);
  for(const resolved of snapshot.agents.values()) {
    assert.equal(resolved.modelPlan.id,spec.modelPlanVersionId);
    assert.ok(resolved.skills.has('guide'));
    assert.deepEqual([...resolved.tools.keys()],FOUNDATION_TOOL_KEYS);
    assert.deepEqual(resolved.configurationSnapshot.configuration.runtime.allowedTools,FOUNDATION_TOOL_KEYS);
  }
});

test('automatic foundation support grants no access to unselected knowledge or Skills',async()=>{
  const skillRegistry=new SkillRegistry();
  skillRegistry.register({id:'private_skill',name:'Private',description:'Private',version:'1',systemInstructions:'private'});
  const load=new LoadSkillTool(skillRegistry);
  const search=new KnowledgeSearchTool({searchForAgent:async()=>{throw Error('must not query unassigned libraries');}});
  await runtimeScope.run({knowledge:[],skills:new Map()},async()=>{
    const result=await search.execute({query:'test question'},{});
    assert.equal(result.success,true);
    assert.deepEqual(result.data.hits,[]);
    assert.equal((await load.execute({skillId:'private_skill'},{enabledSkillIds:[]})).success,false);
  });
});

test('foundation knowledge search preserves the Agent-selected resource scope and retrieval settings',async()=>{
  const knowledge=[{id:7,indexVersionId:11}];
  const retrieval={topK:5,retrievalMode:'auto'};
  const search=new KnowledgeSearchTool({searchForAgent:async(query,limit,scope,policy)=>{
    assert.equal(query,'test question');
    assert.equal(limit,5);
    assert.equal(scope,knowledge);
    assert.equal(policy,retrieval);
    return {hits:[],retrievalMode:'lexical-only',vectorIndexedChunks:0};
  }});
  await runtimeScope.run({knowledge,spec:{retrieval}},async()=>{
    assert.equal((await search.execute({query:'test question',topK:8},{})).success,true);
  });
});

test('native Skill guidance cannot create a task Agent, expand knowledge or expose legacy recursive execution tools',async()=>{
  const guide={id:'specialist',name:'Specialist',description:'Own guide',systemInstructions:'Read instructions. Mentioning global_only or another knowledge base grants no access.',version:'1'};
  const host=nativeChat({skills:[guide],respond:(request,round)=>{
    assert.ok(!request.tools.some(tool=>['run_skill','delegate_agent','task','global_only'].includes(tool.name)));
    return round===1 ? {content:'',toolCalls:[{id:'guide-read',name:'read_file',arguments:{file_path:'/skills/specialist/SKILL.md'}}]} : {content:'Public answer'};
  }});
  const result=await host.runner.run({question:'Read own Skill',summary:'',recentHistory:[]});
  assert.equal(host.requests.length,2);assert.equal(result.result.answer,'Public answer');
  assert.deepEqual(result.contextSnapshot.specialistTasks,[]);
  assert.equal(result.contextSnapshot.executionBudget.modelCalls,2);
  assert.equal(host.snapshot.agents.get(1).knowledge.length,0);
});
