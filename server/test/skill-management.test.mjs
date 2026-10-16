import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSkillDocument, exportSkillDocument, skillDocumentDiagnostics, normalizeSkillConfig, skillEditorDocument } from '../dist/agent-management/skill-document.js';
import { AgentManagementService } from '../dist/agent-management/agent-management.service.js';
import { AgentManagementController } from '../dist/agent-management/agent-management.controller.js';
import { skillSchema } from '../dist/agent-management/resource.types.js';
import { SkillRegistry } from '../dist/ai/skills/skill-registry.js';
import { ToolRegistry } from '../dist/ai/tools/tool-registry.js';

const document=(metadata,body='# 流程\n\n核实资料后回答。')=>`---\n${metadata}\n---\n\n${body}`;
const spec=()=>skillSchema.parse({description:'核实订单异常，在缺货或发货超时时使用',instructions:'核实资料后回答。',allowedTools:[],allowedKnowledgeBaseIds:[]});

test('standard names, string tools, metadata and BOM/CRLF are importable without changing the legacy Key',()=>{
 const p=parseSkillDocument('\uFEFF'+document('name: order-recovery\r\ndescription: 核实订单\r\nallowed-tools: get_order get_inventory\r\nmetadata:\r\n  title: 订单恢复\r\n  category: support\r\n  author: test').replaceAll('\n','\r\n').replaceAll('\r\r','\r'));
 assert.equal(p.key,'order_recovery');assert.equal(p.name,'订单恢复');assert.equal(p.config.portableName,'order-recovery');
 assert.deepEqual(p.config.allowedTools,['get_order','get_inventory']);assert.equal(p.config.metadata.author,'test');assert.deepEqual(p.diagnostics,[]);
 assert.equal(parseSkillDocument(document('name: order-recovery\ndescription: 订单'),{resourceKey:'legacy_support'}).key,'legacy_support');
});

test('legacy names and array-based permissions still load; a warning explains standard name normalization',()=>{
 const p=parseSkillDocument(document('name: order_recovery\ndescription: 订单\nallowed-tools: [get_order]\nallowed-kbs: [1, "2"]\ndisable-model-invocation: true'));
 assert.equal(p.key,'order_recovery');assert.equal(p.config.portableName,'order-recovery');assert.equal(p.config.disableModelInvocation,true);
 assert.deepEqual(p.config.allowedKnowledgeBaseIds,[1,2]);assert.ok(p.diagnostics.some(d=>d.field==='name'));
});

test('UUID knowledge references and foreign tool patterns are preserved declarations, never a silent permission grant',()=>{
 const input=document('name: order-recovery\ndescription: 订单\nallowed-tools: ["Bash(git:*)", Read]\nallowed-kbs: ["2483720c-c68d-491f-b0d4-201a160f0870"]');
 const p=parseSkillDocument(input);assert.deepEqual(p.config.allowedTools,[]);assert.deepEqual(p.config.allowedKnowledgeBaseIds,[]);assert.equal(p.diagnostics.filter(d=>d.severity==='warning').length,3);
 const mapped=parseSkillDocument(input,{toolMapping:{'Bash(git:*)':'read_order',Read:'read_order'},knowledgeBaseMapping:{'2483720c-c68d-491f-b0d4-201a160f0870':3}});
 assert.deepEqual(mapped.config.allowedTools,['read_order']);assert.deepEqual(mapped.config.allowedKnowledgeBaseIds,[3]);assert.deepEqual(mapped.diagnostics,[]);
});

test('unsupported runtime policy blocks publication but can be archived; informational extensions are preserved',()=>{
 const p=parseSkillDocument(document('name: order-recovery\ndescription: 订单\nrequires_network: true\ncustom-label: internal'));
 assert.equal(p.config.extraFrontmatter.requires_network,true);assert.equal(p.config.extraFrontmatter['custom-label'],'internal');
 assert.ok(p.diagnostics.some(d=>d.field==='requires_network'&&d.severity==='error'));
 assert.ok(p.diagnostics.some(d=>d.field==='custom-label'&&d.severity==='warning'));
 assert.match(exportSkillDocument(p.key,p.name,p.config,'portable'),/requires_network: true/);
 const roundtrip=parseSkillDocument(exportSkillDocument(p.key,p.name,p.config));assert.deepEqual(roundtrip.config.extraFrontmatter,p.config.extraFrontmatter);
 assert.ok(skillDocumentDiagnostics({...spec(),extraFrontmatter:{'allowed-tools':['danger']}}).some(d=>d.severity==='error'));
});

test('platform export retains bindings; portable export omits local identifiers and invocation policy',()=>{
 const config={...spec(),portableName:'order-recovery',metadata:{author:'test','agent-studio-key':'legacy_support'},allowedTools:['read_order'],allowedKnowledgeBaseIds:[3],disableModelInvocation:true,license:'MIT',compatibility:'Requires order tools'};
 const platform=parseSkillDocument(exportSkillDocument('legacy_support','订单',config));
 assert.equal(platform.key,'legacy_support');assert.equal(platform.config.disableModelInvocation,true);assert.deepEqual(platform.config.allowedKnowledgeBaseIds,[3]);
 const portable=exportSkillDocument('legacy_support','订单',config,'portable');assert.doesNotMatch(portable,/allowed-kbs|disable-model-invocation|agent-studio-key/);
 const p=parseSkillDocument(portable);assert.equal(p.config.license,'MIT');assert.equal(p.config.metadata.author,'test');
});

test('YAML diagnostics identify line/column and reject duplicate keys, aliases, invalid booleans and non-object roots',()=>{
 assert.throws(()=>parseSkillDocument(document('name: test\ndescription: use when: broken')),/YAML 第 3 行、第/);
 assert.throws(()=>parseSkillDocument(document('name: test\nname: again\ndescription: x')),/YAML 第/);
 assert.throws(()=>parseSkillDocument(document('name: test\ndescription: &a hi\ncategory: *a')),/别名/);
 assert.throws(()=>parseSkillDocument(document('name: test\ndescription: x\ndisable-model-invocation: "false"')));
 assert.throws(()=>parseSkillDocument(document('[a, b]')),/键值对象/);
 assert.throws(()=>parseSkillDocument(document('name: test\ndescription: x\n__proto__: {}')),/保留字段/);
 assert.throws(()=>parseSkillDocument(document('name: test\ndescription: !env secret')),/标签/);
 assert.throws(()=>exportSkillDocument('test','test',{...spec(),description:'x'.repeat(1025)},'portable'),/1024/);
 assert.throws(()=>parseSkillDocument(document('name: ../file\ndescription: x')),/name/);
});

function fixture(){
 let resources=[{id:1,key:'legacy_support',name:'旧 Skill',kind:'skill',enabled:true},{id:2,key:'other',name:'别的资源',kind:'tool',enabled:true}];
 let versions=[{id:10,resourceId:1,key:'legacy_support',name:'旧 Skill',kind:'skill',enabled:true,version:1,status:'published',revision:1,config:spec(),testedRevision:1,testResult:{ok:true}},{id:20,resourceId:2,key:'other',name:'别的资源',kind:'tool',enabled:true,version:1,status:'draft',revision:1,config:{}}];
 const audits=[],sqls=[];
 const query=async(sql,args=[])=>{
  if(sql.includes("pg_advisory_xact_lock"))return {rows:[]};
  sqls.push(sql);
  if(sql.startsWith("SELECT enabled,archived_at,deleted_at FROM agent_resources"))return {rows:[{enabled:true}]};
  if(sql.startsWith('SELECT id FROM agent_resources'))return {rows:resources.filter(r=>r.id===args[0]&&r.kind==='skill')};
  if(sql.startsWith('SELECT resource_key'))return {rows:[{resource_key:'get_order'}]};
  if(sql.startsWith('SELECT id::int FROM knowledge_bases'))return {rows:[{id:1}]};
  if(sql.includes('FROM agent_resource_versions v JOIN agent_resources r'))return {rows:structuredClone(versions.filter(v=>sql.includes('WHERE r.id')?v.resourceId===args[0]:v.id===args[0]).sort((a,b)=>b.version-a.version))};
  if(sql.startsWith('SELECT id FROM agent_resource_versions'))return {rows:[]};
  if(sql.startsWith('INSERT INTO agent_resource_versions')){const r=resources.find(r=>r.id===args[0]),id=30+versions.length;versions.push({...r,id,resourceId:r.id,version:args[1],status:'draft',revision:1,config:JSON.parse(args[2]),testedRevision:null,testResult:null});return {rows:[{id}]};}
  if(sql.startsWith('UPDATE agent_resource_versions SET config')){const v=versions.find(v=>v.id===args[0]);v.config=JSON.parse(args[1]);v.revision++;v.testedRevision=null;v.testResult=null;return {rows:[]};}
  if(sql.startsWith('INSERT INTO audit_logs')){audits.push(args);return {rows:[]};}
  throw new Error('Unexpected fixture query: '+sql);
 };
 let tail=Promise.resolve();
 const db={query,transaction(work){const running=tail.then(()=>work({query}));tail=running.catch(()=>{});return running;}};
 const tools=new ToolRegistry();
 const service=new AgentManagementService(db,{},tools,new SkillRegistry(),{},{});
 return {service,versions:()=>versions,audits,sqls};
}

test('edit creates one working draft under a resource lock; repeated and concurrent clicks reuse it',async()=>{
 const f=fixture();const results=await Promise.all([f.service.skillDraft(1,1,{}),f.service.skillDraft(1,1,{}),f.service.skillDraft(1,1,{})]);
 assert.equal(new Set(results.map(r=>r.versionId)).size,1);assert.equal(results.filter(r=>!r.reused).length,1);assert.equal(f.versions().filter(v=>v.resourceId===1&&v.status==='draft').length,1);
 assert.ok(f.sqls.some(sql=>sql.includes("kind='skill'")&&sql.includes("FOR UPDATE")));
 assert.equal(f.audits.length,1);assert.equal(f.versions()[0].status,'published');
});

test('history branching is explicit and never overwrites a working draft or accepts another resource version',async()=>{
 const f=fixture();const first=await f.service.skillDraft(1,1,{}),second=await f.service.skillDraft(1,1,{fromVersionId:10,branch:true});
 assert.notEqual(first.versionId,second.versionId);assert.equal((await f.service.skillDraft(1,1,{})).versionId,second.versionId);
 await assert.rejects(f.service.skillDraft(1,1,{fromVersionId:20,branch:true}),e=>e.getStatus()===404);
 await assert.rejects(f.service.skillDraft(1,2,{}),e=>e.getStatus()===404);
 assert.equal(f.versions()[0].status,'published');
});

test('draft writes return the new revision; stale writes and attempts to change published versions are rejected',async()=>{
 const f=fixture(),draft=await f.service.skillDraft(1,1,{});
 const response=await f.service.update(1,draft.versionId,{revision:1,config:{...spec(),instructions:'新的正文'}});assert.equal(response.revision,2);
 await assert.rejects(f.service.update(1,draft.versionId,{revision:1,config:spec()}),e=>e.getStatus()===409);
 await assert.rejects(f.service.update(1,10,{revision:1,config:spec()}),e=>e.getStatus()===409);
 assert.equal(f.versions().find(v=>v.id===draft.versionId).config.instructions,'新的正文');
});

test('imports preserve external declarations without resolving or granting workspace capabilities',async()=>{
 const f=fixture();const p=await f.service.parseSkillDocument(document('name: external-support\ndescription: external\nallowed-tools: get_order unregistered_tool\nallowed-kbs: [1, 99]'),{});
 assert.deepEqual(p.config.allowedTools,['get_order','unregistered_tool']);assert.deepEqual(p.config.allowedKnowledgeBaseIds,[1,99]);
 const normalized=normalizeSkillConfig(p.config,p.key);assert.equal(normalized.permissionMode,'agent');assert.deepEqual(normalized.allowedTools,[]);assert.deepEqual(normalized.allowedKnowledgeBaseIds,[]);
 assert.match(normalized.document,/unregistered_tool/);assert.equal(f.sqls.length,0);
});

test('backend rejects unsupported execution policy but permits inert external declarations',async()=>{
 const f=fixture();const client={query:async()=>{throw Error('Skill declarations must not query capability ownership');}};
 await assert.rejects(f.service.validate(client,{id:1,kind:'skill',config:{...spec(),extraFrontmatter:{requires_network:true}}}),e=>e.getStatus()===400);
 const config={...spec(),unresolvedTools:['Bash'],unresolvedKnowledgeBases:['external-uuid']};
 await f.service.validate(client,{id:1,kind:'skill',config});
 assert.ok(skillDocumentDiagnostics(config).every(d=>d.severity==='warning'));
});

test('controller exposes precise import errors as 400s and never executes unsupported code',async()=>{
 const controller=new AgentManagementController({parseSkillDocument:async(text,mapping)=>parseSkillDocument(text,mapping)});
 await assert.rejects(controller.parseSkill({document:document('name: test\ndescription: broken: yaml')}),e=>e.getStatus()===400&&e.message.includes('第 3 行'));
 assert.match(controller.exportSkill({key:'test',name:'test',config:parseSkillDocument(document('name: test\ndescription: x\ncontext: fork')).config,format:'portable'}).document,/context: fork/);
});


test('canonical SKILL.md preserves comments, unknown fields and body; projections cannot override it',()=>{
 const input=document('name: order-recovery # stable name\ndescription: 核实订单\nlicense: MIT\ncompatibility: Requires order tools\nmetadata:\n  author: original\ncustom-label: portable','# 步骤\n\n    indented example\n\n');
 const parsed=parseSkillDocument(input);
 assert.equal(exportSkillDocument(parsed.key,parsed.name,parsed.config),input);
 const normalized=normalizeSkillConfig({...parsed.config,instructions:'tampered',description:'tampered',allowedKnowledgeBaseIds:[999]},'legacy_support');
 assert.equal(normalized.instructions,'# 步骤\n\n    indented example');assert.equal(normalized.description,'核实订单');
 assert.equal(normalized.permissionMode,'agent');assert.deepEqual(normalized.allowedKnowledgeBaseIds,[]);
 const exported=exportSkillDocument('legacy_support','后台标题',normalized,'portable');
 assert.match(exported,/# stable name/);assert.match(exported,/custom-label: portable/);assert.match(exported,/license: MIT/);assert.match(exported,/author: original/);
 assert.ok(exported.endsWith('# 步骤\n\n    indented example\n\n'));
});

test('minimal new Skill has no platform permission fields; legacy editor seed does not silently migrate published policy',()=>{
 const seed=skillEditorDocument('legacy_support','旧名字',{...spec(),category:'support',allowedTools:['read_order'],allowedKnowledgeBaseIds:[1],disableModelInvocation:true});
 assert.doesNotMatch(seed,/allowed-tools|allowed-kbs|disable-model-invocation|category|agent-studio-key/);
 const normalized=normalizeSkillConfig({...spec(),document:seed},'legacy_support');assert.equal(normalized.permissionMode,'agent');
 assert.equal(normalizeSkillConfig(spec(),'legacy_support').permissionMode,'agent');
});

test('draft write stores source-derived fields, preserving immutable legacy identity and original YAML',async()=>{
 const f=fixture(),draft=await f.service.skillDraft(1,1,{}),input=document('name: portable-support # keep\ndescription: 修订任务','修订后的正文');
 const r=await f.service.update(1,draft.versionId,{revision:1,config:{document:input,instructions:'wrong'}});
 assert.equal(r.config.document,input);assert.equal(r.config.description,'修订任务');assert.equal(r.config.instructions,'修订后的正文');
 assert.equal(r.config.portableName,'portable-support');assert.equal(r.config.permissionMode,'agent');
 assert.equal(f.versions().find(v=>v.id===draft.versionId).key,'legacy_support');
 assert.equal(f.versions()[0].config.document,undefined);
 await assert.rejects(f.service.update(1,draft.versionId,{revision:2,config:{document:document('name: x\ndescription: bad: yaml')}}),e=>e.getStatus()===400);
});


test('portable tool/KB declarations do not become local bindings on save',()=>{
 const input=document('name: portable-support\ndescription: portable\nallowed-tools: get_order\nallowed-kbs: [999999]');
 const config=normalizeSkillConfig({document:input},'portable_support');
 assert.deepEqual(config.allowedTools,[]);assert.deepEqual(config.allowedKnowledgeBaseIds,[]);assert.equal(config.document,input);
 assert.match(exportSkillDocument('portable_support','portable',config),/allowed-kbs: \[999999\]/);
});

test('empty document body is valid draft data but never passes test or publish validation',async()=>{
 const f=fixture(),draft=await f.service.skillDraft(1,1,{});
 const input=document('name: draft-support\ndescription: 稍后补充正文','');
 const r=await f.service.update(1,draft.versionId,{revision:1,config:{document:input}});
 assert.equal(r.config.instructions,'');assert.equal(r.config.document,input);
 const version=f.versions().find(v=>v.id===draft.versionId);
 await assert.rejects(f.service.test(1,version.id,{}),e=>e.getStatus()===400&&e.message.includes('补充 Skill 正文'));
 await assert.rejects(f.service.publish(1,version.id),e=>e.getStatus()===400&&e.message.includes('补充 Skill 正文'));
 const filled=await f.service.update(1,version.id,{revision:2,config:{document:input+'核实后回答。'}});
 assert.equal(filled.config.instructions,'核实后回答。');
 await f.service.validate({query:async()=>({rows:[]})},{...version,config:filled.config});
});

test('legacy JSON Skill bindings become inert declarations without changing historical input',()=>{
 const legacy={...spec(),permissionMode:'legacy',allowedTools:['removed_tool'],allowedKnowledgeBaseIds:[999],disableModelInvocation:true};
 const before=structuredClone(legacy),normal=normalizeSkillConfig(legacy,'legacy_support');
 assert.deepEqual(legacy,before);
 assert.equal(normal.permissionMode,'agent');
 assert.deepEqual(normal.allowedTools,[]);assert.deepEqual(normal.allowedKnowledgeBaseIds,[]);
 assert.match(normal.document,/removed_tool/);assert.match(normal.document,/999/);
 assert.equal(normal.instructions,legacy.instructions);
});
