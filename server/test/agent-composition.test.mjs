import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { runtimeScope, freeze, agentMemoryScope } from '../dist/agent-management/runtime-scope.js';
import { makeManagedTool } from '../dist/agent-management/managed-tool.js';
import { parseSkillDocument, exportSkillDocument } from '../dist/agent-management/skill-document.js';
import { skillSchema, toolSchema, collaborationSchema } from '../dist/agent-management/resource.types.js';
import { ToolRegistry } from '../dist/ai/tools/tool-registry.js';
import { SkillRegistry } from '../dist/ai/skills/skill-registry.js';
import { LoadSkillTool } from '../dist/ai/tools/load-skill.tool.js';
import { ToolExecutionService } from '../dist/ai/tools/tool-execution.js';
import { ToolPolicy } from '../dist/ai/tools/tool-policy.js';
import { DEFAULT_AGENT_CONFIGURATION } from '../dist/config/agent-config.js';
import { SearchService } from '../dist/documents/search.service.js';

const tool = name => ({ name, description:name, inputSchema:z.object({}).strict(), execute:async()=>({success:true,content:'ok'}) });
const skill = {id:'specialist',name:'专项',description:'专项指导',version:'1',systemInstructions:'核实后回答'};
const spec = skillSchema.parse({description:skill.description,instructions:skill.systemInstructions,allowedTools:['read','global_only'],allowedKnowledgeBaseIds:[2,999]});
function agent(id=1,key='support') {
 const configuration=structuredClone(DEFAULT_AGENT_CONFIGURATION);
 configuration.runtime.allowedTools=['read','private','load_skill'];
 return {version:{id,key,name:key,version:1},spec:{runtime:configuration.runtime,promptVersionId:1,toolVersionIds:[1],skillVersionIds:[2]},configurationSnapshot:{configuration,revision:'fixture',configurationVersion:1},promptSnapshot:{businessPrompt:'业务指导',delegationHints:'成员'},modelPlan:{id},tools:new Map(['read','private','load_skill'].map(n=>[n,tool(n)])),skills:new Map([[skill.id,skill]]),skillSpecs:new Map([[skill.id,spec]]),knowledge:[{id:1,indexVersionId:10},{id:2,indexVersionId:20}]};
}
function composition(policy='continue') {
 const a=agent(),b=agent(2,'member');
 return {mode:'multi',entryVersionId:1,agents:new Map([[1,a],[2,b]]),createdAt:'now',collaboration:{coordinatorVersionId:1,memberVersionIds:[2],edges:[{from:1,to:2},{from:2,to:1}],maxDepth:1,maxDelegations:3,failurePolicy:policy}};
}
const result = {result:{answer:'已核实',refused:false,citations:[]},contextSnapshot:{},sources:[],products:[],inputTokens:3,outputTokens:2,totalTokens:5};
const llm = {withPinnedModelPlan:async(_p,run)=>run()};
const context = () => ({traceId:'same-call',permissions:[],state:new Map()});

test('concurrent request registries have exact scopes and cannot fall back to global tools or Skills',async()=>{
 const tools=new ToolRegistry(),skills=new SkillRegistry();
 tools.register(tool('global_only'));skills.register({...skill,id:'global_only'});
 const a=agent(),b=agent(2);b.tools=new Map();b.skills=new Map();
 await Promise.all([runtimeScope.run(a,async()=>{
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(tools.has('read'),true);assert.equal(tools.has('global_only'),false);
  assert.throws(()=>tools.get('global_only'));assert.equal(skills.has(skill.id),true);assert.equal(skills.has('global_only'),false);
 }),runtimeScope.run(b,async()=>{
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(tools.list(),[]);assert.deepEqual(skills.list(),[]);
 })]);
 assert.equal(tools.has('global_only'),true);assert.equal(skills.has('global_only'),true);
 const frozen=freeze(composition());assert.throws(()=>frozen.agents.clear(),TypeError);
 assert.throws(()=>frozen.agents.get(1).knowledge.push({id:3}),TypeError);
 assert.equal(agentMemoryScope(frozen),agentMemoryScope({...frozen,createdAt:'later'}));
 assert.notEqual(agentMemoryScope(frozen),agentMemoryScope({...frozen,agents:new Map([[1,{...a,knowledge:[]}],[2,b]])}));
});

test('Skills default to automatic loading; legacy explicit-only metadata is preserved but no longer blocks invocation',async()=>{
 const config={...spec,disableModelInvocation:true};
 const document=exportSkillDocument(skill.id,skill.name,config);
 const parsed=parseSkillDocument(document);
 assert.equal(parsed.key,skill.id);assert.equal(parsed.name,skill.name);
 for(const field of Object.keys(config)) assert.deepEqual(parsed.config[field],config[field]);
 assert.ok(parsed.diagnostics.some(d=>d.field==='disable-model-invocation'&&d.severity==='warning'));
 assert.throws(()=>parseSkillDocument('---\nname: ../file\n---\ntext'));
 const s=composition(),a=s.agents.get(1);a.skillSpecs.set(skill.id,config);
 const load=new LoadSkillTool(new SkillRegistry());
 const out=await runtimeScope.run(a,()=>load.execute({skillId:skill.id},{...context(),enabledSkillIds:[skill.id]}));
 assert.equal(out.success,true);
});

test('REST schema reaches the model and execution; approval prevents calls; retry reuses write idempotency key',async(t)=>{
 const schema={type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false};
 const v={id:8,key:'remote',config:toolSchema.parse({type:'rest',description:'remote',parameters:schema,endpoint:{url:'https://fixture.invalid/query',method:'POST'},readOnly:false,idempotencyHeader:'Idempotency-Key',requiresApproval:true,maxRetries:2})};
 const managed=makeManagedTool(v,()=>{throw Error('REST has no registry lookup');});
 const registry=new ToolRegistry();registry.register(managed);
 const execution=new ToolExecutionService(registry,new ToolPolicy());
 assert.deepEqual(execution.toolDefinitions()[0].parameters,schema);
 assert.equal(managed.inputSchema.safeParse({}).success,false);
 const keys=[];let calls=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{keys.push(options.headers['Idempotency-Key']);calls++;return calls===1?Response.json({}, {status:503}):Response.json({answer:'ok'});});
 const denied=await execution.execute('remote',{query:'q'},context(),execution.createState());
 assert.equal(denied.result.errorCode,'tool_approval_required');assert.equal(calls,0);
 const out=await execution.execute('remote',{query:'q'},{...context(),approvedTools:['remote']},execution.createState(),{retryDelaysMs:[0]});
 assert.equal(out.result.success,true);assert.equal(out.trace.attempts,2);assert.equal(keys[0],keys[1]);assert.match(keys[0],/^[a-f0-9]{64}$/);
 const unsafe=toolSchema.safeParse({...v.config,idempotencyHeader:undefined});assert.equal(unsafe.success,false);
});

test('tool timeout aborts the attempt and never retries when the managed retry count is zero',async()=>{
 let calls=0,aborted=false;
 const slow={...tool('slow'),planning:{canBatch:false,isIdempotent:true},runtimeLimits:{maxRetries:0,timeoutMs:15},execute:(_input,ctx)=>{calls++;ctx.signal.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});}};
 const registry=new ToolRegistry();registry.register(slow);
 const runtime=new ToolExecutionService(registry,new ToolPolicy());
 const out=await runtime.execute('slow',{},context(),runtime.createState());
 assert.equal(out.result.errorCode,'tool_timeout');assert.equal(calls,1);assert.equal(aborted,true);
});

test('restored knowledge excludes other bases and changed index versions while retaining a pinned older index',async()=>{
 const old={chunkId:1,documentId:1,documentTitle:'A',originalFilename:'a.txt',ordinal:1,headingPath:'',content:'text',sourceStartLine:1,sourceEndLine:1,score:4,indexKind:'published',knowledgeBaseId:2,indexVersionId:20};
 const other={...old,chunkId:2,knowledgeBaseId:3};
 let pinned;
 const search=new SearchService({query:async(sql,args)=>{if(sql.includes('FROM index_chunks')) {pinned=args[1];return {rows:[old,other]};}return {rows:[]};}});
 assert.deepEqual(await search.restoreEvidence([old,other],[{id:2,indexVersionId:20}]),[old]);assert.deepEqual(pinned,[20]);
 assert.deepEqual(await search.restoreEvidence([old],[{id:2,indexVersionId:21}]),[]);
 assert.deepEqual(await search.restoreEvidence([old],[]),[]);
});
