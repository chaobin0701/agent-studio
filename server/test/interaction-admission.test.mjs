import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { AgentRunController } from '../dist/executions/agent-run.controller.js';
import { AgentApiController } from '../dist/chat/agent-api.controller.js';
import { ChatController } from '../dist/chat/chat.controller.js';

const exhausted=()=>new HttpException({code:'rate_limit_exceeded'},429);
function fixture() {
  let claimed=0,cancelled=0;
  const integration={kind:'platform',app:{id:randomUUID()}};
  const request={integration,ip:'127.0.0.1',socket:{},get:()=>undefined};
  const response=Object.assign(new EventEmitter(),{status(){return this;},json(value){return value;}});
  const prepared={input:{stream:false},admission:{callId:randomUUID()}};
  const host={prepareResume:async()=>{claimed++;return {prepared};},cancelAdmission:async()=>{cancelled++;},execute:async()=>({answer:'done'}),publicResult:x=>x};
  const limiter={runConcurrent:async()=>{throw exhausted();},runPlatform:async()=>{throw exhausted();},run:async()=>{throw exhausted();}};
  const access={assertScope(){},platformOwner:async()=>randomUUID()};
  const conversations={session:async()=>randomUUID()};
  return {host,limiter,access,conversations,request,response,claimed:()=>claimed,cancelled:()=>cancelled};
}

test('Run process limit refuses before claiming a human reply or purging its checkpoint',async()=>{
  const f=fixture(),controller=new AgentRunController(f.host,f.limiter),id=randomUUID();
  await assert.rejects(controller.respond(1,randomUUID(),id,f.request,undefined,{interactionId:id},f.response),e=>e.getStatus()===429);
  assert.equal(f.claimed(),0);
  assert.equal(f.cancelled(),0);
});

for(const kind of ['platform','website'])test(`legacy ${kind} limit preserves pending human reply`,async()=>{
  const f=fixture();f.request.integration.kind=kind;
  const controller=new AgentApiController(f.access,{},f.host,f.limiter);
  await assert.rejects(controller.respondInteraction(f.request,randomUUID(),randomUUID(),{},f.response,'owner'),e=>e.getStatus()===429);
  assert.equal(f.claimed(),0);
  assert.equal(f.cancelled(),0);
});

test('Cookie chat IP limit preserves pending human reply',async()=>{
  const f=fixture(),controller=new ChatController({},f.limiter,f.conversations,{},undefined,undefined,f.host,f.access);
  await assert.rejects(controller.respondInteraction(randomUUID(),randomUUID(),{},f.request,f.response),e=>e.getStatus()===429);
  assert.equal(f.claimed(),0);
  assert.equal(f.cancelled(),0);
});

test('Run resume claims and executes inside a single acquired process slot',async()=>{
  const f=fixture();let entered=0;
  f.limiter.runConcurrent=async(_scope,task)=>{entered++;return task();};
  f.host.prepareResume=async()=>{assert.equal(entered,1);return {prepared:{input:{stream:false},admission:{callId:randomUUID()}}};};
  const controller=new AgentRunController(f.host,f.limiter),id=randomUUID();
  assert.deepEqual(await controller.respond(1,randomUUID(),id,f.request,undefined,{interactionId:id},f.response),{answer:'done'});
  assert.equal(entered,1);
  assert.equal(f.cancelled(),0);
});
