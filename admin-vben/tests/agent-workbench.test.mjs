import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url));
const ts=require('typescript');
const {ref}=require('vue');
const {parse,compileTemplate}=require('vue/compiler-sfc');
const detail=readFileSync(new URL('../apps/web-ele/src/views/resources/agent-detail.vue',import.meta.url),'utf8');
const panel=readFileSync(new URL('../apps/web-ele/src/views/playground/RunPanel.vue',import.meta.url),'utf8');
const manager=readFileSync(new URL('../apps/web-ele/src/views/resources/index.vue',import.meta.url),'utf8');
const target=readFileSync(new URL('../apps/web-ele/src/views/playground/target.ts',import.meta.url),'utf8');
const {descriptor}=parse(detail);
const compiled=compileTemplate({source:descriptor.template.content,filename:'agent-detail.vue',id:'agent-configuration'});
const targetModule={exports:{}};
runInNewContext(ts.transpileModule(target,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,targetModule);
const {playgroundRoute,selectedDraftQuery}=targetModule.exports;

test('Agent detail keeps configuration and links to the standalone playground',()=>{
 assert.deepEqual(compiled.errors,[]);
 assert.match(detail, /<Fields[\s\S]*kind="agent"/);
 assert.match(detail, /@click="emit\('preview'\)"/);
 assert.doesNotMatch(detail, /<RunPanel|<ElSplitter|ElSegmented|query\.tab/);
 assert.match(manager, /version\.status === "draft" && !\(await preparePreview\(\)\)/);
 assert.match(manager, /playgroundRoute\(detail\.value, selected\.value\)/);
 assert.match(panel, /invalidTarget\.value \|\|/);
 assert.match(panel, /optionUrl\.value/);
});

test('playground routing pins saved draft revisions and rejects incomplete links',()=>{
 const agent={id:5,currentVersionId:10,versions:[{id:10,status:'published',revision:3},{id:11,status:'draft',revision:7}]};
 assert.deepEqual(JSON.parse(JSON.stringify(playgroundRoute(agent,11))),{path:'/agent-playground',query:{agentId:'5',draftVersionId:'11',draftRevision:'7'}});
 assert.deepEqual(JSON.parse(JSON.stringify(playgroundRoute(agent,10))),{path:'/agent-playground',query:{agentId:'5'}});
 assert.equal(playgroundRoute({...agent,versions:[{id:11,status:'draft'}]},11),undefined);
 assert.equal(playgroundRoute(agent,99),undefined);
 assert.equal(selectedDraftQuery({draftVersionId:'11'}).valid,false);
 assert.equal(selectedDraftQuery({draftVersionId:['11'],draftRevision:'7'}).valid,false);
 assert.equal(selectedDraftQuery({draftVersionId:'11',draftRevision:'0'}).valid,false);
 assert.deepEqual(JSON.parse(JSON.stringify(selectedDraftQuery({draftVersionId:'11',draftRevision:'7'}))),{valid:true,versionId:11,revision:7});
});

const handler=ts.transpileModule(manager.slice(manager.indexOf('async function preparePreview()'),manager.indexOf('const createBaseline = ref(')),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function previewFixture({saved=true,get=async()=>undefined}={}) {
 const calls=[],messages=[];
 const draft={id:11,status:'draft',revision:7};
 const agent={id:5,currentVersionId:10,versions:[{id:10,status:'published',revision:3},draft]};
 const context={
  route:{fullPath:'/agents/5'},workspace:{id:1,generation:0},
  previewing:ref(false),busy:ref(false),kind:ref('agent'),toolContentValid:ref(true),dirty:ref(false),
  detail:ref(agent),selected:ref(11),active:ref(draft),
  draftQueue:{flush:async()=>{if(saved) draft.revision=8;return saved;}},
  api:{get},router:{push:async(target)=>calls.push(target)},playgroundRoute,
  ElMessage:{warning:(value)=>messages.push(value),error:(value)=>messages.push(value)},
 };
 runInNewContext(`${handler}\nglobalThis.handlers={openPreview};`,context);
 return {context,calls,messages,openPreview:context.handlers.openPreview,agent,draft};
}

test('Agent trial opens the saved draft revision and never falls back after a failed save',async()=>{
 const saved=previewFixture();
 await saved.openPreview();
 assert.deepEqual(JSON.parse(JSON.stringify(saved.calls)),[{path:'/agent-playground',query:{agentId:'5',draftVersionId:'11',draftRevision:'8'}}]);
 const failed=previewFixture({saved:false});
 await failed.openPreview();
 assert.equal(failed.calls.length,0);
});

test('late Agent detail and list work never redirects after navigation or workspace change',async()=>{
 let release;
 const pending=new Promise((resolve)=>{release=resolve;});
 const detailFixture=previewFixture();
 detailFixture.context.draftQueue.flush=()=>pending;
 const detailRun=detailFixture.openPreview();
 detailFixture.context.route.fullPath='/tools';
 release(true);
 await detailRun;
 assert.equal(detailFixture.calls.length,0);

 let finish;
 const read=new Promise((resolve)=>{finish=resolve;});
 const listFixture=previewFixture({get:()=>read});
 listFixture.context.route.fullPath='/agents';
 const listRun=listFixture.openPreview({id:5});
 listFixture.context.workspace.generation++;
 finish(listFixture.agent);
 await listRun;
 assert.equal(listFixture.calls.length,0);
});
