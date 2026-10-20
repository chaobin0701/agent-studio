import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { AgentRunService } from "../dist/executions/agent-run.service.js";
import { parseRunRequest } from "../dist/executions/run-request.js";
import { runResponse } from "../dist/executions/run-response.js";
import { InteractionSuspension,InteractionWaiting } from "../dist/interactions/contracts.js";
import { nativeChat } from "./helpers/native-chat.mjs";

function fixture(failPersistence=false) {
  const runId=randomUUID(),traceId=randomUUID(),snapshot=nativeChat({respond:()=>({content:"fixture"})}).snapshot;
  const request={kind:"question",question:"预算？",options:[{id:"b",label:"2000元"}],allowCustom:true};
  const card={id:randomUUID(),runId,kind:"question",status:"pending",revision:1,expiresAt:new Date(Date.now()+10000).toISOString(),...request};
  let paused=0,finished=0,cancelled=0,hosts=0;
  const db={query:async()=>({rows:[{id:runId}],rowCount:1})};
  const access={pause:async()=>{paused++;},finish:async()=>{finished++;},tokens:{accounting:()=>({}),callUsage:async()=>({inputTokens:0,outputTokens:0,totalTokens:0})}};
  const interactions={
    createHost:async()=>{hosts++;return {threadId:runId,checkpointer:new MemorySaver()};},
    saveWaiting:async(actualRun,actualTrace,error,transition)=>{assert.equal(actualRun,runId);assert.equal(actualTrace,traceId);assert.ok(error instanceof InteractionSuspension);if(failPersistence)throw Error("Private storage unavailable");await transition(db,new Date(card.expiresAt));return card;},
    cancel:async()=>{cancelled++;},
  };
  const execution={runTask:async(_snapshot,_input,context)=>{assert.equal(context.runId,runId);assert.equal(context.traceId,traceId);if(!context.interactionHost)throw Error("interaction_transport_unavailable");throw new InteractionSuspension(request,"native-interrupt",{harness:{},execution:{}});}};
  const tracing={span:async(_name,_kind,_versions,work)=>work({}),link:()=>undefined};
  const service=new AgentRunService(db,{},execution,access,tracing,undefined,interactions);
  const prepared={identity:{app:{id:randomUUID()}},composition:snapshot,input:parseRunRequest({task:"选择装备"}),admission:{callId:runId,cached:null},traceId};
  return {service,prepared,card,get paused(){return paused;},get finished(){return finished;},get cancelled(){return cancelled;},get hosts(){return hosts;}};
}

test("Run wait persists an interaction and pauses the same ledger without finishing or failing it",async()=>{
  const f=fixture();
  await assert.rejects(f.service.execute(f.prepared),error=>error instanceof InteractionWaiting&&error.interaction.id===f.card.id);
  assert.equal(f.paused,1);
  assert.equal(f.finished,0);
  assert.equal(f.cancelled,0);
  assert.equal(f.hosts,1);
});

test("a failed wait persistence closes the execution instead of leaving an unresumable active admission",async()=>{
  const f=fixture(true);
  await assert.rejects(f.service.execute(f.prepared),error=>!(error instanceof InteractionWaiting));
  assert.equal(f.paused,0);
  assert.equal(f.finished,1);
  assert.equal(f.cancelled,1);
});

test("administrative previews never create an interactive wait without an authorized resume entry",async()=>{
  const f=fixture();
  await assert.rejects(f.service.execute({...f.prepared,entryPoint:"agent_preview"}));
  assert.equal(f.hosts,0);
  assert.equal(f.paused,0);
});

test("Run SSE closes with interaction_required, and JSON uses 202 waiting, neither emits done nor error",async()=>{
  const runId=randomUUID(),card={id:randomUUID(),runId,kind:"approval",status:"pending",revision:1,expiresAt:new Date().toISOString(),toolName:"submit",arguments:{amount:20}};
  const runs={execute:async()=>{throw new InteractionWaiting(card);},publicResult:()=>assert.fail("waiting is not a final result")};
  const writes=[],response={destroyed:false,writableEnded:false,writableLength:0,setHeader(){},flushHeaders(){},write(value){writes.push(value);},end(){this.writableEnded=true;},status(code){this.statusCode=code;return this;},json(value){this.value=value;return this;}};
  await runResponse(runs,{input:{stream:true},admission:{callId:runId}},response,new AbortController());
  assert.ok(writes.some(value=>value.startsWith("event: interaction_required")));
  assert.ok(!writes.some(value=>value.startsWith("event: done")||value.startsWith("event: error")));
  response.writableEnded=false;
  await runResponse(runs,{input:{stream:false},admission:{callId:runId}},response,new AbortController());
  assert.equal(response.statusCode,202);
  assert.equal(response.value.status,"waiting");
  assert.equal(response.value.interaction.id,card.id);
});
