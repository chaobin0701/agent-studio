import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChatbotService } from '../dist/chatbot/chatbot.service.js';
import { SecurityRateLimitService } from '../dist/security/security-rate-limit.service.js';
import { InteractionWaiting } from '../dist/interactions/contracts.js';

function fixture() {
  const runId=randomUUID(),sessionId=randomUUID(),interactionId=randomUUID();
  const limiter=new SecurityRateLimitService({security:{chatConcurrency:1}});
  const counters={prepared:0,executed:0,cancelled:0};
  let finishExecution;
  const execution=new Promise((resolve,reject)=>{finishExecution={resolve,reject};});
  let preparation='fresh';
  const runs={
    prepareResumeForChatbot:async()=>{
      counters.prepared++;
      if(preparation==='failure')throw new Error('prepare failed');
      if(preparation==='replay')return {replayed:true};
      return {prepared:{admission:{callId:runId}},replayed:false};
    },
    execute:async()=>{counters.executed++;return execution;},
    publicResult:value=>value,
    cancelAdmission:async()=>{counters.cancelled++;},
  };
  const db={query:async()=>({rows:[],rowCount:1})};
  const attachments={forTurns:async()=>[],resolve:async()=>({contextFiles:[],images:[]})};
  const service=new ChatbotService(db,{snapshotPinned:async()=>({})},runs,{},limiter,{},attachments);
  service.turn=async()=>({status:'waiting',agentVersionId:2});
  service.session=async()=>({agentEnabled:true,agentId:1});
  const respond=()=>service.respond({adminId:1},sessionId,runId,interactionId,{kind:'approval',interactionId,revision:1,decision:'approve'});
  return {service,limiter,counters,runId,interactionId,respond,finishExecution,setPreparation:value=>{preparation=value;}};
}

test('a full execution ceiling rejects a chatbot response before consuming its waiting checkpoint',async()=>{
  const f=fixture(),release=f.limiter.acquireConcurrent('chat');
  await assert.rejects(f.respond(),error=>error.getStatus()===429);
  assert.deepEqual(f.counters,{prepared:0,executed:0,cancelled:0});
  assert.equal(f.service.hasActive(f.runId),false);
  release();
  assert.equal(await f.limiter.runConcurrent('chat',async()=>true),true);
});

test('a resumed chatbot responds immediately while its reserved slot covers the entire background execution',async()=>{
  const f=fixture();
  assert.deepEqual(await f.respond(),{runId:f.runId,replayed:false,stream:true});
  assert.equal(f.counters.executed,1);
  const done=f.service.active.get(f.runId).done;
  assert.equal(f.service.hasActive(f.runId),true);
  assert.throws(()=>f.limiter.acquireConcurrent('chat'),error=>error.getStatus()===429);
  f.finishExecution.resolve({answer:'done'});
  await done;
  assert.equal(f.service.hasActive(f.runId),false);
  assert.equal(f.counters.cancelled,0);
  assert.equal(await f.limiter.runConcurrent('chat',async()=>true),true);
});

test('idempotent replies and failed preparation release reservations without starting background execution',async()=>{
  const f=fixture();
  f.setPreparation('replay');
  assert.equal((await f.respond()).replayed,true);
  assert.equal(await f.limiter.runConcurrent('chat',async()=>true),true);
  f.setPreparation('failure');
  await assert.rejects(f.respond(),/prepare failed/);
  assert.equal(await f.limiter.runConcurrent('chat',async()=>true),true);
  assert.deepEqual(f.counters,{prepared:2,executed:0,cancelled:0});
});

test('waiting again or failing releases the reservation after persistence and cancellation cleanup',async()=>{
  for(const waiting of [true,false]) {
    const f=fixture();
    await f.respond();
    const done=f.service.active.get(f.runId).done;
    f.finishExecution.reject(waiting
      ?new InteractionWaiting({id:f.interactionId,runId:f.runId,kind:'question',status:'pending',revision:1,question:'继续？',options:[],allowCustom:true})
      :new Error('execution failed'));
    await done;
    assert.equal(f.counters.cancelled,waiting?0:1);
    assert.equal(await f.limiter.runConcurrent('chat',async()=>true),true);
  }
});

test('an execution reservation is released exactly once even if ownership is handed off',async()=>{
  const limiter=new SecurityRateLimitService({security:{chatConcurrency:1}});
  const release=limiter.acquireConcurrent('chat');
  release();
  const current=limiter.acquireConcurrent('chat');
  release();
  assert.throws(()=>limiter.acquireConcurrent('chat'),error=>error.getStatus()===429);
  current();
  assert.equal(await limiter.runConcurrent('chat',async()=>true),true);
});
