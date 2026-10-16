import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url));
const ts=require('typescript'),{ref,computed}=require('vue');
const source=readFileSync(new URL('../apps/web-ele/src/views/knowledge/index.vue',import.meta.url),'utf8');
const script=source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\n/gm,'');
const compiled=ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(api){
 const workspace={id:1,generation:0},route={params:{}};
 const context={ref,computed,api,requestClient:api,Set,JSON,setInterval,clearInterval,setTimeout,URL,
  useRoute:()=>route,useRouter:()=>({push:async()=>{}}),useWorkspaceStore:()=>workspace,
  useAccessStore:()=>({accessCodes:['documents.read','knowledge_bases.manage']}),
  useUnsavedChanges:()=>async()=>true,watch(){},onMounted(){},onBeforeUnmount(){},
  ElMessage:{warning(){},success(){}},ElMessageBox:{confirm:async()=>{}},
 };
 runInNewContext(`${compiled}\nglobalThis.page={load,loadChoices,openBase,run,items,detail,documents,profiles,defaultProfile,dialog,page,documentState,loading,failed,actionError};`,context);
 return {page:context.page,workspace,route};
}
test('late knowledge list responses and failures cannot overwrite a new workspace',async()=>{
 for(const fail of [false,true]){
  const first=deferred();let calls=0;
  const f=fixture({get:()=>++calls===1?first.promise:Promise.resolve([{id:2,name:'new workspace'}])});
  const old=f.page.load();f.workspace.id=2;f.workspace.generation++;await f.page.load();
  if(fail)first.reject(Error('old request'));else first.resolve([{id:1,name:'old workspace'}]);
  await old;assert.equal(f.page.items.value[0].name,'new workspace');assert.equal(f.page.failed.value,false);assert.equal(f.page.loading.value,false);
 }
});
test('knowledge document filters are submitted with pagination; operation failures stay inline',async()=>{
 const urls=[];
 const f=fixture({get:async url=>{urls.push(url);return url.endsWith('/documents?limit=21&offset=20&trash=false&state=archived')?[{id:8,archivedAt:'now'}]:url.endsWith('/versions')?[]:{id:3,name:'kb'};}});
 f.route.params.id=3;f.page.page.value=2;f.page.documentState.value='archived';await f.page.load();
 assert.ok(urls.includes('/knowledge-bases/3/documents?limit=21&offset=20&trash=false&state=archived'));assert.equal(f.page.documents.value[0].id,8);
 await f.page.run(async()=>{throw {response:{data:{error:{message:'当前配置不兼容'}}}};});assert.equal(f.page.actionError.value,'当前配置不兼容');
});
test('changing workspace while loading creation choices never opens a stale settings form',async()=>{
 const choices=deferred(),settings=deferred();
 const f=fixture({get:url=>url==='/knowledge-bases/embedding-profiles'?choices.promise:settings.promise});
 const open=f.page.openBase();f.workspace.id=2;f.workspace.generation++;
 choices.resolve([{id:7,name:'old profile'}]);settings.resolve({defaultEmbeddingPlanVersionId:9,embeddingPlans:[{id:9,profileId:7}]});await open;
 assert.equal(f.page.dialog.value,'');assert.equal(f.page.profiles.value.length,0);assert.equal(f.page.defaultProfile.value,undefined);
});
