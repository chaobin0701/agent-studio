import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {createDraftQueue} from '../apps/web-ele/src/composables/draft-queue.ts';
const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url));
const ts=require('typescript'),{ref,computed}=require('vue');
const source=readFileSync(new URL('../apps/web-ele/src/views/models/plan-detail.vue',import.meta.url),'utf8');
const script=source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\n/gm,'');
const compiled=ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture({testOk=true,publishFails=false,pointerMatches=true,manage=true,published=false}={}){
 const calls=[];
 const deployment={id:11,name:'primary',account_id:7,enabled:true,config:{model:'original'}};
 const versions=[{id:4,plan_id:2,name:'模型方案',version:1,status:published?'published':'draft',revision:1,config:{deployments:[{id:11,accountId:7,name:'primary',baseUrl:'https://example.invalid',config:{model:'original'}}]}}];
 const plan={id:2,name:'模型方案',current_version_id:published?4:null};
 const listing=()=>JSON.parse(JSON.stringify({plans:[plan],versions,deployments:[deployment],accounts:[{id:7,name:'account',enabled:true}]}));
 const api={
  get:async url=>{calls.push(['GET',url]);return listing();},
  patch:async(url,body)=>{calls.push(['PATCH',url,body]);const v=versions.find(v=>v.id===body.sourceVersionId);assert.equal(v.revision,body.revision);v.revision++;v.name=body.name.trim();plan.name=v.name;if(body.refreshDeployments)v.config.deployments[0].config={...deployment.config};v.test_result=null;return JSON.parse(JSON.stringify(v));},
  post:async(url,body)=>{calls.push(['POST',url,body]);if(url.endsWith('/draft')){const v={...JSON.parse(JSON.stringify(versions[0])),id:5,status:'draft',version:2,revision:1};versions.unshift(v);return {versionId:5,reused:false};}
   const version=versions.find(v=>v.id===Number(url.split('/').at(-2)));
   assert.ok(version);const combined=url.endsWith('/test-and-publish');assert.ok(combined||url.endsWith('/test'));
   if(publishFails&&combined)throw Error('发布期间凭据发生变化');
   const result={ok:testOk,published:combined&&testOk,deployments:[{id:11,ok:testOk,message:testOk?'验证通过':'供应商拒绝'}]};version.test_result=result;
   if(combined&&testOk){version.status='published';plan.current_version_id=pointerMatches?version.id:null;}return result;
  }
 };
 const context={ref,computed,api,createDraftQueue,setTimeout,clearTimeout,
  defineAsyncComponent(){},useRoute:()=>({meta:{modelKind:'llm'},params:{id:2},fullPath:'/models/llm/plans/2'}),useRouter:()=>({}),
  useAccessStore:()=>({accessCodes:manage?['model_profiles.manage']:['model_profiles.read']}),useWorkspaceStore:()=>({generation:0}),
  useUnsavedChanges:(_dirty,flush)=>async()=>flush?flush():true,onBeforeUnmount(){},watch(){},
  ElMessage:{success(){}},ElMessageBox:{confirm:async()=>{}},
 };
 runInNewContext(`${compiled}\nglobalThis.page={load,flush,execute,edit,listing,name,queue,dirty,result,publishedNotice,error,selected,active,saveState,syncDeployments,changedDeployments};`,context);
 return {page:context.page,api,calls,versions,plan,deployment};
}
test('opening a model plan prepares/reuses a working draft without testing or publication',async()=>{
 const f=fixture({published:true});try{await f.page.load();assert.equal(f.page.selected.value,5);await f.page.load();assert.equal(f.calls.filter(([,u])=>u.endsWith('/draft')).length,1);assert.ok(!f.calls.some(([,u])=>u.endsWith('/test')||u.endsWith('/test-and-publish')));}finally{f.page.queue.dispose();}
});
test('model autosave preserves pinned deployments; refreshing them is explicit',async()=>{
 const f=fixture();try{await f.page.load();f.deployment.config.model='newer';f.page.listing.value.deployments[0].config.model='newer';f.page.name.value='改名';assert.equal(await f.page.flush(),true);const saved=f.calls.find(([m])=>m==='PATCH');assert.equal(saved[2].refreshDeployments,false);assert.equal(f.page.active.value.config.deployments[0].config.model,'original');assert.equal(f.page.changedDeployments.value.length,1);await f.page.syncDeployments();assert.equal(f.calls.filter(([m])=>m==='PATCH').at(-1)[2].refreshDeployments,true);assert.equal(f.page.active.value.config.deployments[0].config.model,'newer');assert.equal(f.page.dirty.value,false);}finally{f.page.queue.dispose();}
});
test('testing alone cannot display publication; one publish verifies persisted version and pointer',async()=>{
 const f=fixture();try{await f.page.load();await f.page.execute();assert.equal(f.page.result.value.ok,true);assert.equal(f.page.publishedNotice.value,false);assert.equal(f.plan.current_version_id,null);await f.page.execute(true);assert.equal(f.page.publishedNotice.value,true);assert.equal(f.page.active.value.status,'published');assert.equal(f.calls.at(-1)[0],'GET');}finally{f.page.queue.dispose();}
});
test('failed tests and publication errors never report a successful release',async()=>{
 for(const settings of [{testOk:false},{publishFails:true}]){const f=fixture(settings);try{await f.page.load();await f.page.execute(true);assert.equal(f.page.publishedNotice.value,false);assert.equal(f.plan.current_version_id,null);assert.ok(f.page.result.value?.ok===false||f.page.error.value);}finally{f.page.queue.dispose();}}
});
test('a positive combined response without persisted current pointer is not publication evidence',async()=>{
 const f=fixture({pointerMatches:false});try{await f.page.load();await f.page.execute(true);assert.equal(f.page.publishedNotice.value,false);assert.match(f.page.error.value,/未确认/);}finally{f.page.queue.dispose();}
});
test('read-only viewers cannot create drafts, save edits or execute model tests',async()=>{
 const f=fixture({manage:false,published:true});try{await f.page.load();assert.equal(f.page.selected.value,4);await f.page.execute(true);assert.ok(!f.calls.some(([method])=>method==='POST'||method==='PATCH'));}finally{f.page.queue.dispose();}
});
