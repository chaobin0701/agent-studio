import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { InteractionSuspension,InteractionWaiting } from "../dist/interactions/contracts.js";
import { IntegrationChatGateway } from "../dist/chat/integration-chat.gateway.js";
import { ConversationService } from "../dist/chat/conversation.service.js";
import { ChatApplicationService } from "../dist/chat/chat-application.service.js";
import { AgentApiController } from "../dist/chat/agent-api.controller.js";
import { nativeChat } from "./helpers/native-chat.mjs";
import { AskUserTool } from "../dist/ai/tools/ask-user.tool.js";

const question={kind:"question",question:"预算多少？",options:[{id:"b",label:"2000元"}],allowCustom:true};

test("legacy Gateway preserves the accounting identity and private host bridge when native Chat waits",async()=>{
  const callId=randomUUID(),conversationId=randomUUID(),ownerId=randomUUID(),appId=randomUUID();
  const composition=nativeChat({respond:()=>({content:"fixture"})}).snapshot;
  const identity={kind:"api",app:{id:appId,agentId:composition.agentId,environment:"test",authVersion:3}};
  const card={...question,id:randomUUID(),runId:callId,revision:1,status:"pending",expiresAt:new Date(Date.now()+60000).toISOString()};
  let finish=0,pause=0,captured;
  const db={query:async()=>({rows:[],rowCount:1})};
  const access={tokens:{accounting:()=>({})},pause:async(id)=>{assert.equal(id,callId);pause++;},finish:async()=>{finish++;}};
  const interactions={createHost:async(id,input)=>{assert.equal(id,callId);assert.equal(input.ownerId,ownerId);assert.equal(input.applicationId,appId);assert.equal(input.agentVersionId,composition.entryVersionId);assert.ok(!("identity" in input));captured=input;return {threadId:id,checkpointer:new MemorySaver()};},saveWaiting:async(id,trace,error,transition)=>{assert.equal(id,callId);assert.equal(trace,captured.traceId);assert.ok(error instanceof InteractionSuspension);await transition(db,new Date(card.expiresAt));return card;}};
  const application={ask:async(message,callbacks)=>{assert.equal(callbacks.integrationCallId,callId);assert.equal(callbacks.executionTraceId,captured.traceId);assert.equal(callbacks.interactionHost.threadId,callId);assert.equal(message.conversationId,conversationId);throw new InteractionSuspension(question,"native",{harness:{},execution:{legacyChatSnapshot:{}}});}};
  const gateway=new IntegrationChatGateway(access,application,db,{},interactions);
  await assert.rejects(gateway.execute({identity,ownerId,question:"帮我选装备",admission:{callId,conversationId,clientRequestId:"request-1",cached:null},compositionSnapshot:composition},"request"),error=>error instanceof InteractionWaiting&&error.interaction.runId===callId);
  assert.equal(finish,0);
  assert.equal(pause,1);
});

test("legacy conversation suspends without saved messages, blocks new turns, and resumes the original history/Trace/Run",async()=>{
  const id=randomUUID(),owner=randomUUID(),callId=randomUUID(),traceId=randomUUID(),runId=randomUUID();
  const composition=nativeChat({respond:()=>({content:"fixture"})}).snapshot;
  const queries=[];let row,starts=0,saves=0,snapshots=0,attempts=0;
  const originalSnapshot={conversationId:id,summary:"原摘要",summaryThroughMessageId:null,recentMessages:[],history:[{question:"此前的问题",answer:"此前的回答"}],agentTranscript:[],contextBlocks:[]};
  const db={query:async(sql,args=[])=>{
    queries.push(sql);
    if(sql.includes("FROM conversation_runs WHERE conversation_id = $1 AND client_request_id = $2"))return {rows:row&&args[1]===row.clientRequestId?[{...row}]:[],rowCount:row?1:0};
    if(sql.startsWith("UPDATE conversations SET busy_until = now()")){if(row?.status==="waiting"&&args[2]!==row.id)return {rows:[],rowCount:0};return {rows:[{id,busyUntil:"future"}],rowCount:1};}
    if(sql.includes("INSERT INTO conversation_runs")){starts++;row={id:runId,conversationId:id,clientRequestId:args[2],question:args[3],context:JSON.parse(args[4]),status:"running",integrationCallId:args[5],userMessageId:null,assistantMessageId:null};return {rows:[{id:runId}],rowCount:1};}
    if(sql.startsWith("UPDATE conversation_runs SET status='waiting'")){row.status="waiting";return {rows:[],rowCount:1};}
    if(sql.startsWith("UPDATE conversation_runs SET status='running'")){assert.equal(args[0],runId);assert.equal(args[1],callId);row.status="running";return {rows:[{id:runId}],rowCount:1};}
    if(sql.includes("FROM conversations WHERE id = $1 AND visitor_session_id = $2"))return {rows:[{id}],rowCount:1};
    if(sql.startsWith("UPDATE conversation_runs r SET status = 'expired'")||sql.startsWith("UPDATE conversations SET busy_until = NULL"))return {rows:[],rowCount:0};
    throw new Error(`Unexpected legacy SQL: ${sql}`);
  }};
  const llm={model:"fixture",withModelPlan:(work)=>work(),withPinnedModelPlan:(_plan,work)=>work()};
  const chat={askDetailed:async(_question,history,summary,_onContext,_onStep,_onCommentary,_skill,_callbacks,context)=>{
    attempts++;assert.deepEqual(history,originalSnapshot.history);assert.equal(summary,"原摘要");assert.equal(context.traceId,traceId);assert.equal(context.runId,runId);
    if(attempts===1)throw new InteractionSuspension(question,"native",{harness:{},execution:{}});
    assert.ok(context.interactionHost.resume);
    return {traceId,result:{answer:"已按预算推荐",refused:false,citations:[]},contextSnapshot:{},rawModelOutput:null,inputTokens:3,outputTokens:3,totalTokens:6};
  }};
  const management={snapshot:async()=>composition,prepareMemory:async()=>0};
  const service=new ConversationService(db,chat,llm,undefined,undefined,undefined,undefined,undefined,management);
  service.snapshot=async()=>{snapshots++;return structuredClone(originalSnapshot);};
  service.saveResult=async(_id,_question,run,_duration,actualRun)=>{assert.equal(actualRun,runId);assert.equal(run.traceId,traceId);saves++;row.status="completed";};
  service.updateSummary=async()=>{};
  const host={threadId:callId,checkpointer:new MemorySaver()},callbacks={interactionHost:host,integrationCallId:callId,executionTraceId:traceId};
  let waiting;
  try {await service.ask(owner,id,"帮我选装备",undefined,undefined,"request-1",undefined,callbacks);assert.fail("must wait");}
  catch(error){assert.ok(error instanceof InteractionSuspension,String(error.stack));waiting=error;}
  assert.equal(saves,0);
  assert.equal(row.status,"waiting");
  assert.equal(queries.some(sql=>sql.includes("INSERT INTO conversation_messages")||sql.includes("INSERT INTO chat_traces")),false);
  await assert.rejects(service.ask(owner,id,"另一个问题",undefined,undefined,"request-2"),/already answering/);
  const answer=await service.ask(owner,id,"帮我选装备",undefined,undefined,"request-1",undefined,{...callbacks,interactionHost:{...host,continuation:waiting.continuation,resume:{interruptId:waiting.interruptId,value:{text:"2000元"}}}});
  assert.equal(answer.answer,"已按预算推荐");
  assert.equal(starts,1);
  assert.equal(saves,1);
  assert.equal(snapshots,1);
});

test("legacy application does not publish failed/completed messages for a native human wait",async()=>{
  const events=[];
  const app=new ChatApplicationService({ask:async()=>{throw new InteractionSuspension(question,"native",{});}}, {publish:async(event)=>events.push(event)});
  await assert.rejects(app.ask({channel:"api",conversationId:randomUUID(),ownerId:randomUUID(),question:"test",clientRequestId:"client"}),error=>error instanceof InteractionSuspension);
  assert.ok(!events.some(event=>["run.failed","message.completed"].includes(event.type)));
});

test("legacy API emits interaction_required and closes without error/done, JSON returns 202 waiting",async()=>{
  const callId=randomUUID(),card={...question,id:randomUUID(),runId:callId,status:"pending",revision:1,expiresAt:new Date().toISOString()},writes=[];
  const prepared={identity:{kind:"api"},admission:{callId,conversationId:randomUUID(),clientRequestId:"r"}};
  const gateway={prepare:async()=>prepared,execute:async()=>{throw new InteractionWaiting(card);},publicResult:()=>assert.fail("not completed")};
  const access={assertScope(){},platformOwner:async()=>randomUUID(),finish:async()=>assert.fail("waiting must not be failed")};
  const rate={runPlatform:async(work)=>work()};
  const controller=new AgentApiController(access,{},gateway,rate);
  const request={integration:{kind:"api",app:{}},get:()=>undefined};
  const response={destroyed:false,writableEnded:false,setHeader(){},flushHeaders(){},write(value){writes.push(value);},end(){this.writableEnded=true;},once(){},off(){},json(value){this.value=value;return this;},status(value){this.statusCode=value;return this;}};
  await controller.messages(request,{message:"test",stream:true},response);
  assert.ok(writes.some(value=>value.startsWith("event: interaction_required")));
  assert.ok(!writes.some(value=>value.startsWith("event: done")||value.startsWith("event: error")));
  response.writableEnded=false;
  await controller.messages(request,{message:"test",stream:false},response);
  assert.equal(response.statusCode,202);
  assert.equal(response.value.status,"waiting");
});

test("legacy resume checks the conversation/application/owner before loading private state",async()=>{
  const gateway=new IntegrationChatGateway({assertScope(){}},{},{query:async()=>({rows:[]})},{},{thread:async()=>assert.fail("must not open another owner's private checkpoint")});
  const interactionId=randomUUID();
  await assert.rejects(gateway.prepareResume({app:{id:randomUUID()}},randomUUID(),randomUUID(),interactionId,{kind:"approval",interactionId,revision:1,decision:"approve"}),/不属于当前会话/);
});

test("legacy message history retains resolved cards even when their Runs are older than the Run page limit",async()=>{
  const conversationId=randomUUID(),callId=randomUUID(),owner=randomUUID();
  const card={...question,id:randomUUID(),runId:callId,status:"answered",revision:2,expiresAt:new Date().toISOString(),answer:{text:"2000元"}};
  const db={query:async(sql)=>{
    if(sql.includes("FROM conversations WHERE id = $1"))return {rows:[{id:conversationId}]};
    if(sql.includes("FROM conversation_messages WHERE conversation_id"))return {rows:[{id:1,role:"user",content:"帮我选装备"},{id:2,role:"assistant",content:"结果"}]};
    if(sql.includes("SELECT assistant_message_id::int"))return {rows:[{messageId:2,callId}]};
    if(sql.startsWith("UPDATE conversation_runs")||sql.startsWith("UPDATE conversations"))return {rows:[],rowCount:0};
    throw Error(`Unexpected history SQL: ${sql}`);
  }};
  const interactions={listMany:async(ids)=>{assert.deepEqual(ids,[callId]);return new Map([[callId,[card]]]);}};
  const service=new ConversationService(db,{}, {},undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,interactions);
  const messages=await service.messages(owner,conversationId);
  assert.deepEqual(messages[0].interactions,[]);
  assert.equal(messages[1].interactions[0].id,card.id);
});

test("legacy Chat orchestrator and adapter carry native checkpoints through question/resume without replaying the first model",async()=>{
  const runId=randomUUID(),traceId=randomUUID(),conversationId=randomUUID();
  const f=nativeChat({tools:[new AskUserTool()],respond:(_request,index)=>index===1?{content:"",toolCalls:[{id:"legacy-native-question",name:"ask_user",arguments:{question:"预算？",options:[{id:"b",label:"2000元"}],allowCustom:true}}]}:{content:"已按2000元继续"}});
  const host={threadId:randomUUID(),checkpointer:new MemorySaver()};
  const context={compositionSnapshot:f.snapshot,runId,traceId,conversationId,interactionHost:host};
  let waiting;
  try{await f.orchestrator.askDetailed("帮我选装备",[],"此前摘要",undefined,undefined,undefined,undefined,{onAnswerDelta(){}},context);assert.fail("must wait");}
  catch(error){assert.ok(error instanceof InteractionSuspension,String(error.stack));waiting=error;}
  assert.equal(f.requests.length,1);
  const result=await f.orchestrator.askDetailed("帮我选装备",[],"此前摘要",undefined,undefined,undefined,undefined,{onAnswerDelta(){}},{...context,interactionHost:{...host,continuation:waiting.continuation,resume:{interruptId:waiting.interruptId,value:{optionId:"b",text:"2000元"}}}});
  assert.equal(result.result.answer,"已按2000元继续");
  assert.equal(result.traceId,traceId);
  assert.equal(f.requests.length,2);
});
