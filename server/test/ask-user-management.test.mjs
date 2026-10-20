import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManagementService } from '../dist/agent-management/agent-management.service.js';
import { ToolRegistry } from '../dist/ai/tools/tool-registry.js';
import { SkillRegistry } from '../dist/ai/skills/skill-registry.js';
import { AskUserTool } from '../dist/ai/tools/ask-user.tool.js';

const question={question:'你的预算是多少？',options:[{id:'low',label:'2000元以内'},{id:'mid',label:'2000–3000元'}],allowCustom:true};
function fixture({permissions=['agent_tools.execute'],requiresApproval=false}={}) {
  const adapter=new AskUserTool(),contexts=[],audits=[];
  const execute=adapter.execute.bind(adapter);
  adapter.execute=async(input,context)=>{contexts.push(context);return execute(input,context);};
  const registry=new ToolRegistry();registry.register(adapter);
  const row={id:7,resourceId:3,kind:'tool',key:'ask_user',name:'补充信息',enabled:true,
    version:1,status:'draft',revision:2,config:{type:'builtin',target:'ask_user',description:'询问必要信息',
      parameters:adapter.parameters,readOnly:false,requiresApproval,maxRetries:0,timeoutMs:1000}};
  const db={
    query:async(sql,args=[])=>{
      if(sql.startsWith('SELECT v.id::int'))return {rows:[{...row}]};
      if(sql.startsWith('SELECT pg_advisory_xact_lock'))return {rows:[]};
      if(sql.startsWith('SELECT id FROM agent_resource_versions'))return {rows:[{id:row.id}]};
      if(sql.startsWith('UPDATE agent_resource_versions SET tested_revision')){
        row.testedRevision=args[1];row.testResult=JSON.parse(args[2]);return {rows:[],rowCount:1};
      }
      if(sql.startsWith('INSERT INTO audit_logs')){audits.push(args);return {rows:[],rowCount:1};}
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    platformQuery:async(sql)=>({rows:sql.includes('FROM workspaces')?[{id:1,role:'custom',permission_codes:permissions}]:[{code:'agent_tools.execute'}]}),
    transaction:async(work)=>work(db),
  };
  return {service:new AgentManagementService(db,{},registry,new SkillRegistry(),{},{}),row,adapter,contexts,audits};
}

test('ask_user draft testing exercises the adapter with a clearly marked server-owned sample and preserves publish gate',async()=>{
  const f=fixture();
  const result=await f.service.test(1,7,{execute:true,input:question});
  assert.equal(result.ok,true);
  assert.equal(result.testMode,'interaction_contract');
  assert.equal(result.simulatedInteraction,true);
  assert.match(result.message,/服务端样例回答/);
  assert.deepEqual(JSON.parse(result.content),{text:'2000元以内',optionId:'low'});
  assert.equal(f.contexts.length,1);
  assert.equal(f.contexts[0].interactionAnswer.toolCallId,'management-test-7');
  assert.equal(f.row.testedRevision,2);
  assert.match(f.row.testResult.signature,/^[a-f0-9]{64}$/);
  assert.equal(f.row.status,'draft','testing must not publish or activate a resource');
  assert.equal(f.audits.length,1);
  assert.equal(f.audits[0][1],'agent_resource.tested');
  const production=await f.adapter.execute(question,{permissions:['ask_user'],state:new Map()});
  assert.equal(production.success,false,'normal execution never inherits a management sample');
  assert.equal(production.errorCode,'interaction_transport_unavailable');
});

test('interaction contract test still requires explicit execution, execution permission and valid input',async()=>{
  const f=fixture();
  await assert.rejects(f.service.test(1,7,{input:question}),/显式执行/);
  await assert.rejects(f.service.test(1,7,{execute:true,input:{}}),/Schema/);
  await assert.rejects(f.service.test(1,7,{execute:true,input:{...question,options:[{id:'same',label:'one'},{id:'same',label:'two'}]}}),/Schema/);
  await assert.rejects(f.service.test(1,7,{execute:true,input:question,interactionAnswer:{text:'forged'}}),/interactionAnswer/);
  const denied=fixture({permissions:[]});
  await assert.rejects(denied.service.test(1,7,{execute:true,input:question}),/执行测试权限/);
  assert.equal(f.contexts.length,0);
  assert.equal(denied.contexts.length,0);
  assert.equal(f.row.testedRevision,undefined);
});

test('requiresApproval remains enforced during simulated question contract testing',async()=>{
  const f=fixture({requiresApproval:true});
  const blocked=await f.service.test(1,7,{execute:true,input:question});
  assert.equal(blocked.ok,false);
  assert.equal(blocked.errorCode,'tool_approval_required');
  assert.equal(f.row.testResult.ok,false);
  assert.equal(f.contexts.length,0);
  const approved=await f.service.test(1,7,{execute:true,approved:true,input:question});
  assert.equal(approved.ok,true);
  assert.equal(approved.testMode,'interaction_contract');
  assert.equal(f.contexts.length,1);
  assert.equal(f.row.status,'draft');
});

test('free-text-only question contract uses a bounded server example',async()=>{
  const f=fixture();
  const result=await f.service.test(1,7,{execute:true,input:{question:'补充说明',options:[],allowCustom:true}});
  assert.equal(result.ok,true);
  assert.deepEqual(JSON.parse(result.content),{text:'管理测试示例回答'});
});
