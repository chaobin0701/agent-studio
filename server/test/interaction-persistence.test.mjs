import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { AIMessage,ToolMessage } from "@langchain/core/messages";
import { PostgresCheckpointSaver } from "../dist/interactions/postgres-checkpointer.js";
import { InteractionService } from "../dist/interactions/interaction.service.js";
import { InteractionSuspension } from "../dist/interactions/contracts.js";
import { AskUserTool } from "../dist/ai/tools/ask-user.tool.js";
import { nativeChat } from "./helpers/native-chat.mjs";

function checkpointStore() {
  const checkpoints=[],writes=[];
  const db={transaction:async(work)=>work(db),query:async(sql,args=[])=>{
    if(sql.startsWith("SELECT run_id FROM agent_interaction_threads")) return {rows:[{run_id:args[0]}],rowCount:1};
    if(sql.startsWith("SELECT (COALESCE(sum")) return {rows:[{n:0}],rowCount:1};
    if(sql.startsWith("INSERT INTO agent_native_checkpoints")) { checkpoints.push({run_id:args[0],namespace:args[1],checkpoint_id:args[2],parent_id:args[3],checkpoint_type:args[4],checkpoint:args[5],metadata_type:args[6],metadata:args[7]});return {rows:[],rowCount:1}; }
    if(sql.startsWith("INSERT INTO agent_native_checkpoint_writes")) { const row={run_id:args[0],namespace:args[1],checkpoint_id:args[2],task_id:args[3],task_path:args[4],idx:args[5],channel:args[6],value_type:args[7],value:args[8]};const old=writes.find(w=>w.run_id===row.run_id&&w.checkpoint_id===row.checkpoint_id&&w.task_id===row.task_id&&w.idx===row.idx);if(!old)writes.push(row);else if(sql.includes("DO UPDATE"))Object.assign(old,row);return {rows:[],rowCount:1}; }
    if(sql.startsWith("SELECT c.* FROM agent_native_checkpoints")) return {rows:checkpoints.filter(row=>row.run_id===args[0]&&row.namespace===args[1]&&(!args[2]||row.checkpoint_id===args[2])).slice(-1),rowCount:1};
    if(sql.startsWith("SELECT task_id,task_path")) return {rows:writes.filter(row=>row.run_id===args[0]&&row.namespace===args[1]&&row.checkpoint_id===args[2])};
    if(sql.startsWith("DELETE FROM agent_native_checkpoint_writes")) {writes.splice(0);return {rows:[],rowCount:1};}
    if(sql.startsWith("DELETE FROM agent_native_checkpoints")) {checkpoints.splice(0);return {rows:[],rowCount:1};}
    throw new Error(`Unexpected checkpoint SQL: ${sql}`);
  }};
  return {db,checkpoints,writes};
}

test("Postgres native saver preserves message constructors, pending-write order, and exact thread binding",async()=>{
  const store=checkpointStore(),runId=randomUUID(),saver=new PostgresCheckpointSaver(store.db,runId);
  const config={configurable:{thread_id:runId,checkpoint_ns:""}};
  const checkpoint={v:4,id:randomUUID(),ts:new Date().toISOString(),channel_values:{messages:[new AIMessage({content:"",tool_calls:[{id:"call-1",name:"write",args:{amount:20}}]}),new ToolMessage({tool_call_id:"call-0",content:"ok"})]},channel_versions:{messages:1},versions_seen:{}};
  const saved=await saver.put(config,checkpoint,{source:"loop",step:1,parents:{}},{messages:1});
  await saver.putWrites(saved,[["messages",new ToolMessage({tool_call_id:"call-1",content:"second"})]],"task-b","~2");
  await saver.putWrites(saved,[["messages",new ToolMessage({tool_call_id:"call-1",content:"first"})]],"task-a","~1");
  const tuple=await saver.getTuple(saved);
  assert.ok(AIMessage.isInstance(tuple.checkpoint.channel_values.messages[0]));
  assert.ok(ToolMessage.isInstance(tuple.checkpoint.channel_values.messages[1]));
  assert.deepEqual(tuple.checkpoint.channel_values.messages[0].tool_calls[0].args,{amount:20});
  assert.deepEqual(tuple.pendingWrites.map(write=>write[2].content),["first","second"]);
  assert.ok(ToolMessage.isInstance(tuple.pendingWrites[0][2]));
  await assert.rejects(saver.getTuple({configurable:{thread_id:randomUUID()}}),/authorized Run/);
  await assert.rejects(saver.deleteThread(randomUUID()),/Unauthorized/);
  await saver.deleteThread(runId);
  assert.equal(await saver.getTuple(saved),undefined);
});

function responseStore(request) {
  const runId=randomUUID(),id=randomUUID();
  const row={id,run_id:runId,interrupt_id:"interrupt-1",revision:1,kind:request.kind,status:"pending",request,public_request:request.kind==="question"?request:{kind:"approval",toolName:request.toolName,arguments:{amount:20}},response:null,response_fingerprint:null,expires_at:new Date(Date.now()+60000).toISOString()};
  const thread={run_id:runId,host_input:{traceId:randomUUID(),agentId:1},continuation:{harness:{},execution:{}},interrupt_id:row.interrupt_id,status:"waiting",expires_at:row.expires_at};
  let transitions=0;
  const db={transaction:async(work)=>work(db),query:async(sql,args=[])=>{
    if(sql.startsWith("SELECT * FROM agent_interaction_threads")) return {rows:args[0]===runId?[thread]:[]};
    if(sql.startsWith("SELECT * FROM agent_interactions")) return {rows:args[0]===id&&args[1]===runId?[row]:[]};
    if(sql.startsWith("UPDATE agent_interactions SET status=$2")) {Object.assign(row,{status:args[1],response:JSON.parse(args[2]),response_fingerprint:args[3],revision:row.revision+1});return {rows:[{...row}]};}
    if(sql.startsWith("UPDATE agent_interaction_threads SET status='resuming'")) {thread.status="resuming";return {rows:[],rowCount:1};}
    throw new Error(`Unexpected interaction SQL: ${sql}`);
  }};
  return {runId,id,row,thread,service:new InteractionService(db),transition:async()=>{transitions++;},get transitions(){return transitions;}};
}

test("a response grants only the saved approval, duplicate decisions are idempotent and conflicting decisions fail",async()=>{
  const fixture=responseStore({kind:"approval",toolName:"create_order",description:"Create an order",toolVersionId:12,toolCallId:"call-1",arguments:{amount:20}});
  const response={kind:"approval",interactionId:fixture.id,revision:1,decision:"approve"};
  const accepted=await fixture.service.respond(fixture.runId,response,fixture.transition);
  assert.equal(accepted.replayed,false);
  assert.deepEqual(accepted.host.resume,{interruptId:"interrupt-1",value:{decision:"approve"}});
  assert.equal(accepted.interaction.status,"approved");
  const replay=await fixture.service.respond(fixture.runId,response,fixture.transition);
  assert.equal(replay.replayed,true);
  assert.equal(fixture.transitions,1);
  await assert.rejects(fixture.service.respond(fixture.runId,{...response,decision:"reject"}),/已处理/);
  await assert.rejects(fixture.service.respond(fixture.runId,{...response,arguments:{amount:1}}),/有效的交互/);
  await assert.rejects(fixture.service.respond(randomUUID(),response),/不存在/);
});

test("questions normalize server-owned option labels and reject unknown choices, custom answers and stale/expired claims",async()=>{
  const fixture=responseStore({kind:"question",question:"预算？",options:[{id:"b2",label:"2000–3000 元"}],allowCustom:false});
  const response={kind:"question",interactionId:fixture.id,revision:1,optionId:"b2"};
  await assert.rejects(fixture.service.respond(fixture.runId,{...response,optionId:"missing"}),/选项不存在/);
  await assert.rejects(fixture.service.respond(fixture.runId,{kind:"question",interactionId:fixture.id,revision:1,text:"1元"}),/不允许自由填写/);
  await assert.rejects(fixture.service.respond(fixture.runId,{...response,revision:2}),/状态已变化/);
  fixture.row.expires_at=new Date(Date.now()-1000).toISOString();
  await assert.rejects(fixture.service.respond(fixture.runId,response),/已过期/);
  fixture.row.expires_at=new Date(Date.now()+60000).toISOString();
  const accepted=await fixture.service.respond(fixture.runId,response,fixture.transition);
  assert.deepEqual(accepted.host.resume.value,{optionId:"b2",text:"2000–3000 元"});
  assert.deepEqual(accepted.interaction.answer,{optionId:"b2",text:"2000–3000 元"});
});

test("private continuation must exist before a response can claim a Run",async()=>{
  const fixture=responseStore({kind:"question",question:"预算？",options:[],allowCustom:true});
  fixture.thread.continuation={harness:{}};
  await assert.rejects(fixture.service.respond(fixture.runId,{kind:"question",interactionId:fixture.id,revision:1,text:"2000元"},fixture.transition),/状态不完整/);
  assert.equal(fixture.transitions,0);
  assert.equal(fixture.row.status,"pending");
});

test("skip has its own durable response, is idempotent and cannot be combined with an answer",async()=>{
  const f=responseStore({kind:"question",question:"预算？",options:[{id:"one",label:"2000元"}],allowCustom:false});
  const response={kind:"question",interactionId:f.id,revision:1,skip:true};
  await assert.rejects(f.service.respond(f.runId,{...response,optionId:"one"}),/有效的交互/);
  await assert.rejects(f.service.respond(f.runId,{...response,text:"forged"}),/有效的交互/);
  const accepted=await f.service.respond(f.runId,response,f.transition);
  assert.equal(accepted.interaction.status,"skipped");
  assert.deepEqual(accepted.host.resume.value,{skipped:true});
  assert.deepEqual(accepted.interaction.answer,{skipped:true});
  assert.equal((await f.service.respond(f.runId,response,f.transition)).replayed,true);
  assert.equal(f.transitions,1);
});

test("native Deep Agents resumes through a recreated Postgres saver without a second model question",async()=>{
  const store=checkpointStore(),runId=randomUUID(),traceId=randomUUID();
  let modelCalls=0;
  const f=nativeChat({tools:[new AskUserTool()],respond:()=>++modelCalls===1?{content:"",toolCalls:[{id:"native-q",name:"ask_user",arguments:{question:"预算？",options:[{id:"b",label:"2000元"}],allowCustom:true}}]}:{content:"已采用2000元预算"}});
  const task={messages:[{role:"user",content:"选择装备"}],versions:{agentVersionId:1},limits:{maxDecisions:8,maxToolCalls:10,maxModelCalls:8,maxDurationMs:180000}};
  let waiting;
  try { await f.execution.runTask(f.snapshot,task,{runId,traceId,interactionHost:{threadId:runId,checkpointer:new PostgresCheckpointSaver(store.db,runId)}});assert.fail("must suspend"); }
  catch(error) {assert.ok(error instanceof InteractionSuspension,String(error.stack));waiting=error;}
  assert.equal(modelCalls,1);
  assert.ok(store.checkpoints.length>0);
  const result=await f.execution.runTask(f.snapshot,task,{runId,traceId,interactionHost:{threadId:runId,checkpointer:new PostgresCheckpointSaver(store.db,runId),continuation:JSON.parse(JSON.stringify(waiting.continuation)),resume:{interruptId:waiting.interruptId,value:{optionId:"b",text:"2000元"}}}});
  assert.equal(result.output.answer,"已采用2000元预算");
  assert.equal(modelCalls,2);
});

test("sequential approvals sharing a native interrupt ID create independent durable cards",async()=>{
  const runId=randomUUID(),traceId=randomUUID(),rows=[];
  const thread={run_id:runId,host_input:{traceId},continuation:{},status:"running",expires_at:new Date(Date.now()+60000).toISOString()};
  const db={transaction:async(work)=>work(db),query:async(sql,args=[])=>{
    if(sql.startsWith("SELECT * FROM agent_interaction_threads"))return {rows:[thread]};
    if(sql.startsWith("SELECT 1 FROM agent_native_checkpoints"))return {rows:[{}],rowCount:1};
    if(sql.startsWith("INSERT INTO agent_interactions")){
      const existing=rows.find(row=>row.request_key===args[7]);
      if(existing)return {rows:[existing]};
      const row={id:args[0],run_id:args[1],interrupt_id:args[2],kind:args[3],request:JSON.parse(args[4]),public_request:JSON.parse(args[5]),expires_at:args[6],request_key:args[7],revision:1,status:"pending"};rows.push(row);return {rows:[row]};
    }
    if(sql.startsWith("UPDATE agent_interaction_threads SET status='waiting'")){thread.status="waiting";return {rows:[],rowCount:1};}
    throw new Error(`Unexpected SQL: ${sql}`);
  }};
  const service=new InteractionService(db);
  const one={kind:"approval",toolName:"one",description:"one",toolVersionId:20,toolCallId:"first",arguments:{value:1}};
  const two={...one,toolName:"two",toolVersionId:21,toolCallId:"second"};
  const first=await service.saveWaiting(runId,traceId,new InteractionSuspension(one,"same-native-task",{harness:{},execution:{}}));
  rows[0].status="approved";thread.status="resuming";
  const second=await service.saveWaiting(runId,traceId,new InteractionSuspension(two,"same-native-task",{harness:{},execution:{}}));
  assert.notEqual(first.id,second.id);
  assert.equal(rows.length,2);
  assert.notEqual(rows[0].request_key,rows[1].request_key);
});
