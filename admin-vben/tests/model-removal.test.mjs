import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url));
const ts=require('typescript'),{ref,computed}=require('vue');
const source=readFileSync(new URL('../apps/web-ele/src/views/models/resource-actions.vue',import.meta.url),'utf8');
const script=source.slice(source.indexOf('const currentReferences'),source.indexOf('</script>'));
const compiled=ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(rows){
 const requests=[];const context={computed,props:{beforeAction:async()=>true},base:ref('/model-management/llm/plans/42'),busy:ref(false),references:ref(rows),open:ref(true),action:ref('remove'),error:ref(''),api:{delete:async url=>{requests.push(url);return {ok:true,archived:rows.some(r=>r.usage==='historical')}}},emit:()=>{},ElMessage:{success:()=>{}}};
 runInNewContext(`${compiled}\nglobalThis.page={confirm,blocked,currentReferences,historicalReferences,automaticReferences};`,context);
 return {page:context.page,requests,context};
}
test('deleted Agent history and a releasable default never disable the model removal confirmation',async()=>{
 const f=fixture([{type:'agent',name:'Deleted Agent',usage:'historical'},{type:'binding',usage:'automatic'}]);
 assert.equal(f.page.blocked.value,false);assert.equal(f.page.currentReferences.value.length,0);assert.equal(f.page.historicalReferences.value.length,1);assert.equal(f.page.automaticReferences.value.length,1);
 await f.page.confirm();assert.deepEqual(f.requests,['/model-management/llm/plans/42']);assert.equal(f.context.open.value,false);
});
test('a genuine current Agent or plan reference still prevents removal without a request',async()=>{
 const f=fixture([{type:'agent',usage:'historical'},{type:'binding',usage:'automatic'},{type:'plan',usage:'current'}]);
 assert.equal(f.page.blocked.value,true);await f.page.confirm();assert.equal(f.requests.length,0);
});
