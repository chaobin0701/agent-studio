import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {createDraftQueue} from '../apps/web-ele/src/composables/draft-queue.ts';
const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url));
const ts=require('typescript'), {ref,computed}=require('vue');
function script(relative){
 const s=readFileSync(new URL(`../apps/web-ele/src/views/${relative}`,import.meta.url),'utf8');
 return ts.transpileModule(s.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\n/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
}
function fixture(kind='tool',manage=true){
 const calls=[];
 const resource={id:11,name:'Example',key:'example',kind,enabled:true,versions:[{id:31,version:1,revision:1,status:'published',config:{type:'rest',description:'Original',parameters:{type:'object',properties:{}},endpoint:{url:'https://example.invalid',method:'GET'}}}]};
 const route={params:{id:11},meta:{resourceKind:kind},fullPath:`/${kind}s/11`};
 const api={
  get:async(url)=>{calls.push({url});return url==='/agent-resources/options'?{}:url.startsWith('/agent-resources?')?{resources:[resource]}:JSON.parse(JSON.stringify(resource));},
  post:async(url,body)=>{calls.push({url,body});if(url.endsWith('/draft')){resource.versions.unshift({...JSON.parse(JSON.stringify(resource.versions[0])),id:32,status:'draft',version:2});return {versionId:32};}return {ok:true};},
  patch:async(url,body)=>{calls.push({url,body});return {revision:body.revision+1};},
 };
 const context={ref,computed,watch(){},defineAsyncComponent(){},onBeforeUnmount(){},createDraftQueue,
  useRoute:()=>route,useRouter:()=>({}),useAccessStore:()=>({accessCodes:manage?['agent_config.manage','agent_tools.execute']:[]}),
  useUnsavedChanges:(_dirty,flush)=>async()=>flush?flush():true,api,ElMessage:{success(){},warning(){},info(){}},ElMessageBox:{confirm:async()=>{}},setTimeout,clearTimeout};
 runInNewContext(`${script('resources/index.vue')}\nglobalThis.page={load,detail,selected,config,original,dirty,preparePreview,draftQueue,saveState,toolContentValid,openToolTest,testOpen,publish};`,context);
 return {...context,page:context.page,calls,resource};
}
test('Tool editor prepares one working draft and saves against its revision without publishing',async()=>{
 const f=fixture();await f.page.load();
 assert.equal(f.page.selected.value,32);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/draft')).length,1);
 await f.page.load();assert.equal(f.calls.filter(c=>c.url.endsWith('/draft')).length,1);
 f.page.config.value.description='Modified';
 assert.equal(await f.page.preparePreview(),true);
 assert.equal(f.page.dirty.value,false);
 const write=f.calls.find(c=>c.url==='/agent-resources/versions/32');
 assert.equal(write.body.revision,1);assert.equal(write.body.config.description,'Modified');
 assert.equal(f.page.detail.value.versions.find(v=>v.id===31).config.description,'Original');
 assert.equal(f.calls.some(c=>c.url.endsWith('/publish')||c.url.endsWith('/test')),false);
 f.page.draftQueue.dispose();
});
test('read-only resource viewers never create drafts; invalid editor buffers never save',async()=>{
 const viewer=fixture('tool',false);await viewer.page.load();
 assert.equal(viewer.page.selected.value,31);assert.equal(viewer.calls.some(c=>c.url.endsWith('/draft')),false);viewer.page.draftQueue.dispose();
 const f=fixture();await f.page.load();f.page.config.value.description='Unsaved';f.page.toolContentValid.value=false;
 assert.equal(await f.page.preparePreview(),false);assert.equal(f.calls.some(c=>c.url==='/agent-resources/versions/32'),false);f.page.draftQueue.dispose();
});
test('Tool tests flush changes first, and publish never silently executes an untested Tool',async()=>{
 const f=fixture();await f.page.load();f.page.config.value.description='New request';
 await f.page.openToolTest();assert.equal(f.page.testOpen.value,true);
 assert.equal(f.page.dirty.value,false);assert.equal(f.calls.some(c=>c.url.endsWith('/test')),false);
 await f.page.publish();assert.equal(f.calls.some(c=>c.url.endsWith('/publish')),false);assert.equal(f.calls.some(c=>c.url.endsWith('/test')),false);
 f.page.draftQueue.dispose();
});
