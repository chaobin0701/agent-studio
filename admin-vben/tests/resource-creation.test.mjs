import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {newResourceKey,validResourceKey} from '../apps/web-ele/src/components/create-resource-key.ts';
import {frontmatterSection} from '../apps/web-ele/src/views/resources/skill/frontmatter.ts';
import {createDraftQueue} from '../apps/web-ele/src/composables/draft-queue.ts';
const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url));
const ts=require('typescript'),{ref,computed}=require('vue');
const skillExports={};
runInNewContext(ts.transpileModule(readFileSync(new URL('../apps/web-ele/src/views/resources/skill/create-document.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:skillExports,require:name=>name==='./frontmatter'?{frontmatterSection}:require(name)});
const {createSkillDocument,skillCreateKey}=skillExports;

function fixture(kind,post){
 const file=kind==='mcp'?'mcp/index.vue':kind==='prompt'?'prompts/index.vue':'resources/index.vue';
 const source=readFileSync(new URL('../apps/web-ele/src/views/'+file,import.meta.url),'utf8');
 const script=source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\n/gm,'');
 const requests=[],navigated=[],guards=[];let allowDiscard=false;
 const route={params:{},meta:{resourceKind:kind},fullPath:'/'+kind+'s'};
 const context={ref,computed,watch(){},defineAsyncComponent(){},onBeforeUnmount(){},setTimeout,clearTimeout,URL,
  newResourceKey,validResourceKey,createSkillDocument,skillCreateKey,createDraftQueue,
  useRoute:()=>route,useRouter:()=>({push:async path=>navigated.push(path)}),useAccessStore:()=>({accessCodes:['agent_config.manage','agent_tools.execute','prompts.manage']}),
  useUnsavedChanges:(dirty)=>{guards.push(dirty);return async()=>!dirty.value||allowDiscard;},
  api:{post:async(url,body)=>{requests.push({url,body:JSON.parse(JSON.stringify(body))});return post?post(url,body):{id:51,resourceId:51};}},
  ElMessage:{success(){},warning(){},info(){}},ElMessageBox:{confirm:async()=>{}},
 };
 const specific=kind==='prompt'?'form:createForm,formRef:createFormRef,error:actionError,rules:createRules':kind==='mcp'?'form:draft,formRef:createForm,error,rules:createRules':'form:skillCreate,formRef:skillCreateForm,error:actionError,rules:skillCreateRules,name,key,config,formDirty';
 runInNewContext(ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+`\nglobalThis.page={openCreate,closeCreate,create,createOpen,busy,generatedCreateKey,${specific}};`,context);
 context.page.formRef.value={validate:async()=>true,clearValidate(){}};
 function fill(){
  const p=context.page;p.openCreate();
  if(kind==='tool'){p.name.value='Example tool';p.config.value.endpoint.url='https://example.invalid/tool';p.config.value.description='Look up facts';}
  else if(kind==='skill')Object.assign(p.form.value,{name:'Example Skill',description:'Use for facts'});
  else if(kind==='mcp'){p.form.value.name=' Example MCP ';p.form.value.config.url=' https://example.invalid/mcp ';}
  else Object.assign(p.form.value,{name:' Example Prompt ',template:'Keep this content'});
 }
 return {page:context.page,requests,navigated,route,guards,fill,discard:()=>{allowDiscard=true;}};
}

test('generated keys fit managed resources and portable Skill identity without requiring technical input',()=>{
 const keys=new Set();for(const kind of ['agent','skill','tool','mcp','prompt'])for(let i=0;i<10;i++){const key=newResourceKey(kind);assert(validResourceKey(key));assert(key.length<=64);keys.add(key);if(kind==='skill')assert.match(skillCreateKey(key).name,/^skill-[a-f0-9]+$/);}
 assert.equal(keys.size,50);assert(!validResourceKey('1_bad'));assert(!validResourceKey('has-dash'));assert(!validResourceKey('a'.repeat(81)));
});
for(const kind of ['skill','tool','prompt','mcp']){
 test(`${kind} creation retains input and the generated identity after failure; retry does not silently choose another key`,async()=>{
  let failed=true;const f=fixture(kind,async()=>{if(failed)throw {response:{data:{error:{message:'Temporary failure'}}}};return {id:51,resourceId:51};});f.fill();
  const key=f.page.generatedCreateKey.value;await f.page.create();
  assert.equal(f.requests.length,1);assert.equal(f.page.createOpen.value,true);assert.equal(f.page.error.value,'Temporary failure');
  assert.equal(f.requests[0].body[kind==='prompt'?'promptKey':'key'],key);
  if(kind==='prompt')assert.equal(f.page.form.value.template,'Keep this content');
  if(kind==='skill')assert.match(f.requests[0].body.config.document,new RegExp('name: '+skillCreateKey(key).name));
  failed=false;await f.page.create();assert.equal(f.requests.length,2);assert.equal(f.requests[1].body[kind==='prompt'?'promptKey':'key'],key);assert.equal(f.page.createOpen.value,false);assert.equal(f.navigated.length,1);
 });
 test(`${kind} close protects typed changes and pending submits, while late creation cannot redirect a departed page`,async()=>{
  let resolve;const f=fixture(kind,()=>new Promise(r=>resolve=r));f.page.openCreate();await f.page.closeCreate();assert.equal(f.page.createOpen.value,false,'empty modal can close without a discard confirmation');
  f.fill();await f.page.closeCreate();assert.equal(f.page.createOpen.value,true,'typed input survives a cancelled discard');
  const pending=f.page.create();await new Promise(setImmediate);assert.equal(f.requests.length,1);assert.equal(f.page.busy.value,true);
  await f.page.create();await f.page.closeCreate();assert.equal(f.requests.length,1);assert.equal(f.page.createOpen.value,true);
  f.route.fullPath='/overview';resolve({id:51,resourceId:51});await pending;assert.equal(f.navigated.length,0);
  const racing=fixture(kind);racing.fill();racing.discard();const closing=racing.page.closeCreate();racing.page.busy.value=true;await closing;assert.equal(racing.page.createOpen.value,true,'a submit admitted while discard confirmation resolves still owns the modal');
 });
}
test('MCP and Prompt use real field validators and failed validation never sends a create request',async()=>{
 const mcp=fixture('mcp');mcp.fill();const check=(validator,value)=>new Promise(resolve=>validator({},value,error=>resolve(error)));
 const url=mcp.page.rules['config.url'][0].validator;
 assert(await check(url,''));assert(await check(url,'file:///tmp/service'));assert(await check(url,'https://user:secret@example.invalid/mcp'));assert.equal(await check(url,'https://example.invalid/mcp'),undefined);
 assert.equal(await check(mcp.page.rules.key[0].validator,''),undefined);assert(await check(mcp.page.rules.key[0].validator,'bad-key'));
 const prompt=fixture('prompt');prompt.fill();assert.equal(await check(prompt.page.rules.promptKey[0].validator,'support.business'),undefined);assert(await check(prompt.page.rules.promptKey[0].validator,'Not valid'));
 for(const f of [mcp,prompt]){f.page.formRef.value.validate=async()=>{throw Error('invalid');};await f.page.create();assert.equal(f.requests.length,0);assert.equal(f.page.createOpen.value,true);f.discard();await f.page.closeCreate();assert.equal(f.page.createOpen.value,false);}
});
