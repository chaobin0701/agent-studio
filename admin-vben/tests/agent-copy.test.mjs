import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {agentCopySource} from '../apps/web-ele/src/views/resources/resource-summary.ts';
const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url));
const ts=require('typescript'),{ref}=require('vue');
const source=readFileSync(new URL('../apps/web-ele/src/views/resources/index.vue',import.meta.url),'utf8');
const script=source.slice(source.indexOf('function openCopy('),source.indexOf('const leave = useUnsavedChanges('));
const compiled=ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(api){const calls=[],context={ref,agentCopySource,busy:ref(false),copyOpen:ref(false),copyName:ref(''),copySource:ref(),copyBaseline:ref(''),actionError:ref(''),route:{fullPath:'/agents'},crypto:{randomUUID},api,router:{push:async path=>calls.push(path)},ElMessage:{success(){}},run:async fn=>{try{await fn();}catch(e){context.actionError.value=e.message;}}};runInNewContext(`${compiled}\nglobalThis.page={openCopy,copyAgent};`,context);return {context,calls,page:context.page};}
const resource={currentVersionId:11,name:'Published',versions:[{id:12,name:'Draft',status:'draft'},{id:11,name:'Published',status:'published'}]};
test('the actual Agent copy handler clones the effective version into a named draft without publishing',async()=>{
 const requests=[],f=fixture({post:async(url,body)=>{requests.push([url,body]);return {resourceId:50};}});
 f.page.openCopy(resource);assert.equal(f.context.copyName.value,'Published 副本');
 f.context.copyName.value='My independent Agent';await f.page.copyAgent();
 assert.equal(requests.length,1);assert.equal(requests[0][0],'/agent-resources/versions/11/clone');assert.match(requests[0][1].key,/^agent_[a-f0-9]{32}$/);assert.equal(requests[0][1].name,'My independent Agent');assert.deepEqual(f.calls,['/agents/50']);assert.equal(f.context.copyOpen.value,false);
});
test('copy failure keeps the entered name and dialog; a departed route is not redirected by a late copy',async()=>{
 const failed=fixture({post:async()=>{throw Error('permission changed');}});failed.page.openCopy(resource);failed.context.copyName.value='Retain name';await failed.page.copyAgent();assert.equal(failed.context.copyOpen.value,true);assert.equal(failed.context.copyName.value,'Retain name');assert.equal(failed.context.actionError.value,'permission changed');
 let resolve;const delayed=fixture({post:()=>new Promise(r=>resolve=r)});delayed.page.openCopy(resource);const pending=delayed.page.copyAgent();delayed.context.route.fullPath='/skills';resolve({resourceId:50});await pending;assert.equal(delayed.calls.length,0);
});
