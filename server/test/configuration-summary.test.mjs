import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { configurationSummary, publicConfiguration } from '../dist/integrations/configuration-summary.js';
import { IntegrationService } from '../dist/integrations/integration.service.js';
import { AgentApiController } from '../dist/chat/agent-api.controller.js';
const app={id:'app',name:'展示站',dailyRequests:100,dailyTokenLimit:120000,requestsPerMinute:10,limitSettings:{dailyRequests:true,dailyTokenLimit:false,requestsPerMinute:true}};
function snapshot(version=3) {
  const agent={version:{id:30,version,name:'助手'},modelPlan:{name:'方案',version:2,config:{apiKey:'PRIVATE'}},spec:{promptVersionId:4,toolVersionIds:[11,12,13],skillVersionIds:[14],runtime:{maxPlannerRounds:12,maxToolCalls:8},executionLimits:{maxModelCalls:32,maxToolCalls:40,maxTotalTokens:120000,enabled:{maxModelCalls:true,maxToolCalls:false,maxTotalTokens:false}},retrieval:{retrievalMode:'fulltext',topK:5,contextChars:12000}},knowledge:[{id:6,indexVersionId:7}],promptSnapshot:{prompts:{p:{key:'业务指导',versionId:4,version:12,template:'PRIVATE PROMPT'}}}};
  return {entryVersionId:30,agents:new Map([[30,agent]]),mode:'single',createdAt:'2026-10-26T10:00:00Z'};
}
const resources=[{id:11,name:'天气',version:1,toolType:'rest'},{id:12,name:'users',version:2,toolType:'mcp',mcpVersionId:5},{id:13,name:'orders',version:2,toolType:'mcp',mcpVersionId:5},{id:14,name:'故障排查',version:1}];
const summarize=(version=3)=>configurationSummary(snapshot(version),app,'run',resources,[{id:5,name:'Robot MCP',version:2}],[{id:6,name:'使用指南'}]);
test('turn summary stores versions, groups MCP once, and excludes prompt bodies, secrets and disabled budgets',()=>{
  const first=summarize(); const next=summarize(4);
  assert.equal(first.agent.version,'v3');assert.equal(next.agent.version,'v4');
  assert.equal(first.prompt.version,'v12');assert.equal(first.tools.length,1);assert.equal(first.skills.length,1);
  assert.deepEqual(first.mcp,[{name:'Robot MCP',version:'v2',toolCount:2}]);
  assert.deepEqual(first.budgets,{modelCalls:32});
  assert.deepEqual(first.application.policy,{dailyRequests:100,requestsPerMinute:10});
  assert.equal(JSON.stringify(first).includes('PRIVATE'),false);
  const publicValue=publicConfiguration(first);
  assert.equal(publicValue.agent.version,'v3');assert.equal(publicValue.knowledge[0].version,'索引 #7');
  assert.equal('application' in publicValue,false);assert.equal('prompt' in publicValue,false);
  assert.equal(publicConfiguration(null),null);
});
test('configuration reads are scoped to app and owner; old rounds stay absent, administrative reads retain saved policy',async()=>{
  const saved=summarize(),queries=[];
  const service=Object.create(IntegrationService.prototype);
  service.db={query:async(sql,values)=>{
    queries.push({sql,values});
    if(sql.startsWith('SELECT id FROM conversations'))return {rows:values[2]==='other'?[]:[{id:'conversation'}]};
    return {rows:[{id:'old',snapshot:null},{id:'new',snapshot:saved}]};
  }};
  const result=await service.conversationConfigurations('app','conversation','owner');
  assert.deepEqual(queries[0].values,['conversation','app','owner']);
  assert.equal(result.turns[0].snapshot,null);assert.equal(result.turns[1].number,2);
  assert.equal('application' in result.turns[1].snapshot,false);
  const admin=await service.conversationConfigurations('app','conversation');
  assert.equal(admin.turns[1].snapshot.application.policy.dailyRequests,100);
  await assert.rejects(service.conversationConfigurations('app','conversation','other'),e=>e.getStatus()===404);
});
test('API configuration endpoint derives the owner from existing application identity',async()=>{
  const identity={app:{id:'app'},scopes:['conversations:read']};let args;
  const controller=new AgentApiController({assertScope:(value,scope)=>{assert.equal(value,identity);assert.equal(scope,'conversations:read');},platformOwner:async(value,userId)=>{assert.equal(value,identity);assert.equal(userId,'external-user');return 'owner';},conversationConfigurations:async(...values)=>{args=values;return {turns:[]};}},{},{},{});
  await controller.configurations({integration:identity},'conversation','external-user');
  assert.deepEqual(args,['app','conversation','owner']);
});

test('chat admission records the pinned composition before execution; idempotent replay never replaces it',async()=>{
  const {IntegrationChatGateway}=await import('../dist/chat/integration-chat.gateway.js');
  const events=[], composition=snapshot();let cached=null;
  const access={admit:async()=>{events.push('admit');return {callId:'call',cached};},captureConfiguration:async(id,value,application)=>{assert.equal(id,'call');assert.equal(value,composition);assert.equal(application,app);events.push('capture');}};
  const gateway=new IntegrationChatGateway(access,{}, {}, {snapshot:async()=>composition});
  const identity={app:{...app,agentId:5,environment:'dev'}};
  access.captureConfiguration=async(id,value,application)=>{assert.equal(id,'call');assert.equal(value,composition);assert.equal(application,identity.app);events.push('capture');};
  await gateway.prepare(identity,'owner',undefined,'测试问题','request');
  assert.deepEqual(events,['admit','capture']);
  events.length=0;cached={answer:'existing'};
  await gateway.prepare(identity,'owner',undefined,'测试问题','request');
  assert.deepEqual(events,['admit']);
});
