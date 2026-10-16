import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextMemoryService } from '../dist/chat/context-memory.service.js';
import { knowledgeResources, makeContextBlock, readContextBlocks } from '../dist/ai/context/context-contribution.js';
import { DEFAULT_AGENT_CONFIGURATION } from '../dist/config/agent-config.js';
const hit={chunkId:1,documentId:2,documentTitle:'Guide',originalFilename:'guide.md',headingPath:'',content:'Actual content',sourceStartLine:1,sourceEndLine:2,score:1};
const resources=knowledgeResources({success:true,content:'',data:{hits:[hit]}});
const block=makeContextBlock(resources,{conversationId:'a',source:'search_knowledge',origin:'model'});
const cfg=structuredClone(DEFAULT_AGENT_CONFIGURATION);
test('conversation-scoped evidence is restored once and mismatched envelopes are ignored',async()=>{
 const service=new ContextMemoryService({restoreEvidence:async h=>h});
 assert.equal((await service.restore('a',[block,block],cfg)).resources.length,1);
 assert.equal((await service.restore('b',[block],cfg)).resources.length,0);
 assert.equal(readContextBlocks([{...block,resources:[{kind:'external',data:hit}]}],'a').length,0);
});
test('modified or unavailable evidence is never restored as fact',async()=>{
 for(const current of [[],[{...hit,content:'Changed'}]]){
  const service=new ContextMemoryService({restoreEvidence:async()=>current});
  assert.equal((await service.restore('a',[block],cfg)).resources.length,0);
  await assert.rejects(service.validateResource(resources[0],cfg,new AbortController().signal));
 }
});
test('aborted resource reads and removed authorization fail closed',async()=>{
 const service=new ContextMemoryService({restoreEvidence:async h=>h});
 const controller=new AbortController();controller.abort();
 await assert.rejects(service.validateResource(resources[0],cfg,controller.signal));
 const removed=structuredClone(cfg);removed.runtime.allowedTools=[];
 await assert.rejects(service.validateResource(resources[0],removed,new AbortController().signal));
});
