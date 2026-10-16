import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url));
const ts=require('typescript'),{ref}=require('vue');
for(const [name,path,base] of [
 ['Agent/Skill/Tool/MCP','../apps/web-ele/src/components/ResourceLifecycle.vue','/agent-resources/42'],
 ['model','../apps/web-ele/src/views/models/resource-actions.vue','/model-management/llm/plans/42'],
]){
 const source=readFileSync(new URL(path,import.meta.url),'utf8');
 const script=source.slice(source.indexOf('function message('),source.indexOf('</script>'));
 const compiled=ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 function fixture(api){
  const events=[],notices=[];
  const context={props:{base:'/agent-resources',resource:{id:42},beforeAction:async()=>true},base:ref(base),busy:ref(false),blocked:ref(false),removed:ref(true),open:ref(false),action:ref('remove'),error:ref(''),references:ref([]),api,emit:(...args)=>events.push(args),ElMessage:{success:m=>notices.push(m)}};
  runInNewContext(`${compiled}\nglobalThis.page={choose,confirm};`,context);
  return {context,events,notices,page:context.page};
 }
 test(`${name} restore requires confirmation, keeps failure visible, retries the restore endpoint and never deletes`,async()=>{
  const requests=[];let failed=true;
  const f=fixture({get:async()=>{throw Error('Restore must not query removal references');},delete:async()=>{throw Error('Restore must not delete');},post:async url=>{requests.push(url);if(failed)throw {response:{data:{error:{message:'服务暂不可用'}}}};return {id:42};}});
  await f.page.choose('restore');assert.equal(f.context.action.value,'restore');assert.equal(f.context.open.value,true);assert.equal(requests.length,0);
  await f.page.confirm();assert.equal(f.context.open.value,true);assert.equal(f.context.error.value,'服务暂不可用');assert.equal(f.context.busy.value,false);assert.equal(f.events.length,0);assert.equal(f.notices.length,0);
  failed=false;await f.page.confirm();assert.deepEqual(requests,[base+'/restore',base+'/restore']);assert.equal(f.context.open.value,false);assert.equal(f.context.error.value,'');assert.deepEqual(f.events,[['changed','restore']]);assert.equal(f.notices.length,1);
 });
 test(`${name} restore still respects unsaved-edit protection and a pending operation`,async()=>{
  const f=fixture({post:async()=>{throw Error('Unexpected mutation');}});
  f.context.props.beforeAction=async()=>false;await f.page.choose('restore');assert.equal(f.context.open.value,false);
  f.context.props.beforeAction=async()=>true;f.context.busy.value=true;await f.page.choose('restore');assert.equal(f.context.open.value,false);
 });
}
