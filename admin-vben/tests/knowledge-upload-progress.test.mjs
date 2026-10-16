import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url));
const ts=require('typescript'),{ref}=require('vue');
const source=readFileSync(new URL('../apps/web-ele/src/views/knowledge/UploadDialog.vue',import.meta.url),'utf8');
const compiled=ts.transpileModule(source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\n/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(api){
 const props={base:'/knowledge-bases/3'},open=ref(true),events=[];
 const context={ref,api,props,FormData,setInterval,clearInterval,defineProps:()=>props,defineModel:()=>open,defineEmits:()=>name=>events.push(name),watch(){},onBeforeUnmount(){},ElMessage:{warning(){}},requestMessage:(_e,f)=>f};
 runInNewContext(`${compiled}\nglobalThis.page={poll,retryProgress,results,pollError,indexed,state,clear};`,context);
 return {page:context.page,props,open,events};
}
test('upload progress follows exact document IDs and never treats an older indexed revision as current',async()=>{
 const urls=[];
 const f=fixture({get:async url=>{urls.push(url);return url.includes('/documents?')?[{id:7,status:'ready',inCurrentIndex:true,indexedRevision:1,indexRevision:2}]:{};}});
 f.page.results.value=[{id:7,name:'file',ok:true}];await f.page.poll();
 assert.equal(urls[0],'/knowledge-bases/3/documents?limit=20&ids=7');assert.equal(f.page.indexed(f.page.results.value[0]),false);assert.equal(f.page.state(f.page.results.value[0]),'等待索引更新');assert.equal(f.events.length,0);
});
test('progress request failures stay visible and can be retried without uploading again',async()=>{
 let failed=true;
 const f=fixture({get:async url=>{if(failed)throw Error('network');return url.includes('/documents?')?[{id:7,status:'ready',inCurrentIndex:true,indexedRevision:2,indexRevision:2}]:{};}});
 try {f.page.results.value=[{id:7,ok:true}];await f.page.poll();assert.match(f.page.pollError.value,/进度刷新失败/);failed=false;await f.page.retryProgress();assert.equal(f.page.pollError.value,'');assert.equal(f.page.state(f.page.results.value[0]),'已加入索引');assert.equal(f.events.length,1);}finally{f.page.clear();}
});
test('a late upload progress response cannot overwrite a different knowledge base',async()=>{
 let resolve;const delayed=new Promise(r=>resolve=r);
 const f=fixture({get:()=>delayed});f.page.results.value=[{id:7,ok:true}];const poll=f.page.poll();f.props.base='/knowledge-bases/4';f.page.results.value=[{id:8,ok:true}];resolve([]);await poll;
 assert.equal(f.page.results.value[0].id,8);assert.equal(f.events.length,0);
});
