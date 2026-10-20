import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash,randomUUID } from "node:crypto";
import { readFile,readdir } from "node:fs/promises";
import pg from "pg";
import { JwtService } from "@nestjs/jwt";
import { Annotation,StateGraph,START,END,Command,interrupt } from "@langchain/langgraph";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { DatabaseService } from "../dist/database.service.js";
import { inWorkspace } from "../dist/workspaces/workspace-context.js";
import { IntegrationService } from "../dist/integrations/integration.service.js";
import { InteractionService } from "../dist/interactions/interaction.service.js";
import { PostgresCheckpointSaver } from "../dist/interactions/postgres-checkpointer.js";
import { InteractionSuspension } from "../dist/interactions/contracts.js";

test("PostgreSQL human interactions: real checkpoints, restart/resume, concurrent decisions, expiry and workspace RLS",{skip:!process.env.TEST_DATABASE_URL,timeout:60000},async(t)=>{
  const connectionString=process.env.TEST_DATABASE_URL;
  const admin=new pg.Client({connectionString});
  const schema="interaction_"+randomUUID().replaceAll("-","");
  let db;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection=new URL(connectionString);
    connection.searchParams.set("options",`-csearch_path=${schema},public`);
    db=new DatabaseService({databaseUrl:connection.toString()});
    const dir=new URL("../migrations/",import.meta.url);
    for(const file of (await readdir(dir)).filter(file=>file.endsWith(".sql")).sort())
      await db.platformQuery((await readFile(new URL(file,dir),"utf8")).split("-- Down Migration")[0]);
    const secondWorkspace=(await db.platformQuery("INSERT INTO workspaces(name) VALUES('Isolated interaction tests') RETURNING id::int")).rows[0].id;
    const interactions=new InteractionService(db);
    const access=new IntegrationService(db,new JwtService({secret:"disposable-interaction-test-secret"}),{});
    const makeCall=(workspaceId=1)=>inWorkspace(workspaceId,async()=>{
      const appId=randomUUID(),owner=randomUUID(),runId=randomUUID();
      const agentId=(await db.query("INSERT INTO agent_resources(kind,resource_key,name) VALUES('agent',$1,'Interaction fixture') RETURNING id::int",["fixture_"+randomUUID().replaceAll("-","")])).rows[0].id;
      await db.query("INSERT INTO integration_apps(id,name,enabled,website_enabled,api_enabled,agent_id) VALUES($1,'Interaction fixture',true,true,true,$2)",[appId,agentId]);
      await db.query("INSERT INTO visitor_sessions(id,token_hash,application_id) VALUES($1,$2,$3)",[owner,createHash("sha256").update(randomUUID()).digest("hex"),appId]);
      await db.query("INSERT INTO integration_calls(id,app_id,visitor_session_id,idempotency_key,fingerprint,status,run_id) VALUES($1,$2,$3,$4,$5,'running',$1)",[runId,appId,owner,randomUUID(),"a".repeat(64)]);
      return {runId,appId,owner,agentId};
    });
    const ask={kind:"question",question:"预算是多少？",options:[{id:"mid",label:"2000–3000 元"}],allowCustom:true};
    await t.test("native pending writes can commit before their checkpoint without assuming SDK persistence order",async()=>{
      const call=await makeCall(),trace=randomUUID();
      const initial=await inWorkspace(1,()=>interactions.createHost(call.runId,{traceId:trace,agentId:call.agentId}));
      const checkpoint=emptyCheckpoint();
      const checkpointConfig={configurable:{thread_id:call.runId,checkpoint_ns:"",checkpoint_id:checkpoint.id}};
      // Pregel schedules put() on a checkpoint chain while putWrites() starts
      // independently; a valid saver must permit this exact commit ordering.
      await inWorkspace(1,()=>initial.checkpointer.putWrites(checkpointConfig,[["answer","pending native value"]],"native-task"));
      assert.equal((await inWorkspace(1,()=>db.query("SELECT * FROM agent_native_checkpoint_writes WHERE run_id=$1",[call.runId]))).rowCount,1);
      await inWorkspace(1,()=>initial.checkpointer.put({configurable:{thread_id:call.runId}},checkpoint,{source:"input",step:-1,parents:{}},{}));
      const tuple=await inWorkspace(1,()=>new PostgresCheckpointSaver(db,call.runId).getTuple(checkpointConfig));
      assert.deepEqual(tuple.pendingWrites,[["native-task","answer","pending native value"]]);
      await inWorkspace(1,()=>initial.checkpointer.deleteThread(call.runId));
      assert.equal((await inWorkspace(1,()=>db.query("SELECT * FROM agent_native_checkpoint_writes WHERE run_id=$1",[call.runId]))).rowCount,0);
      assert.equal((await inWorkspace(1,()=>db.query("SELECT * FROM agent_native_checkpoints WHERE run_id=$1",[call.runId]))).rowCount,0);
      await inWorkspace(1,()=>interactions.complete(call.runId));
    });
    const first=await makeCall();
    const traceId=randomUUID();
    let effects=0;
    const state=Annotation.Root({answer:Annotation({reducer:(_old,value)=>value,default:()=>""})});
    const graph=(checkpointer)=>new StateGraph(state).addNode("human",()=>{
      const response=interrupt(ask);
      effects++;
      return {answer:response.text};
    }).addEdge(START,"human").addEdge("human",END).compile({checkpointer});
    const host=await inWorkspace(1,()=>interactions.createHost(first.runId,{traceId,agentId:1,agentVersionId:1,fixture:"native deterministic graph; no model"}));
    const config={configurable:{thread_id:first.runId}};
    const stopped=await inWorkspace(1,()=>graph(host.checkpointer).invoke({answer:""},config));
    assert.equal(effects,0);
    assert.equal(stopped.__interrupt__[0].value.question,ask.question);
    const waiting=await inWorkspace(1,()=>interactions.saveWaiting(first.runId,traceId,new InteractionSuspension(ask,stopped.__interrupt__[0].id,{harness:{fixture:true},execution:{fixture:true}}),c=>access.pause(first.runId,c)));
    assert.equal(waiting.status,"pending");
    assert.equal((await inWorkspace(1,()=>db.query("SELECT status FROM integration_calls WHERE id=$1",[first.runId]))).rows[0].status,"waiting");

    await t.test("orphan native threads and cross-workspace references are rejected by SQL",async()=>{
      await assert.rejects(inWorkspace(1,()=>interactions.createHost(randomUUID(),{traceId:randomUUID()})),error=>error.code==="23503");
      const other=await makeCall(secondWorkspace);
      await assert.rejects(inWorkspace(1,()=>db.query("INSERT INTO agent_interaction_threads(run_id) VALUES($1)",[other.runId])),error=>error.code==="23503");
      await assert.rejects(inWorkspace(1,()=>db.query("INSERT INTO agent_interaction_threads(run_id,workspace_id) VALUES($1,$2)",[other.runId,secondWorkspace])),error=>["42501","23503"].includes(error.code));
    });

    await t.test("private checkpoint bytes and public cards respect workspace RLS",async()=>{
      await assert.rejects(inWorkspace(secondWorkspace,()=>interactions.thread(first.runId)),/不存在/);
      assert.deepEqual(await inWorkspace(secondWorkspace,()=>interactions.list(first.runId)),[]);
      const hidden=await inWorkspace(secondWorkspace,()=>new PostgresCheckpointSaver(db,first.runId).getTuple(config));
      assert.equal(hidden,undefined);
      await assert.rejects(inWorkspace(secondWorkspace,()=>new PostgresCheckpointSaver(db,first.runId).put(config,emptyCheckpoint(),{source:"input",step:-1,parents:{}},{})),/not active/);
      assert.equal((await inWorkspace(secondWorkspace,()=>db.query("SELECT * FROM agent_interactions WHERE id=$1",[waiting.id]))).rowCount,0);
    });

    await t.test("concurrent identical responses claim one resume; a different response conflicts",async()=>{
      const response={kind:"question",interactionId:waiting.id,revision:1,optionId:"mid"};
      const decisions=await Promise.all([1,2].map(()=>inWorkspace(1,()=>new InteractionService(db).respond(first.runId,response,c=>access.resume(first.runId,c)))));
      assert.equal(decisions.filter(value=>!value.replayed).length,1);
      assert.equal(decisions.filter(value=>value.replayed).length,1);
      assert.deepEqual(decisions[0].host.resume.value,{optionId:"mid",text:"2000–3000 元"});
      await assert.rejects(inWorkspace(1,()=>interactions.respond(first.runId,{kind:"question",interactionId:waiting.id,revision:1,text:"另一个回答"})),/已处理/);
      const claimed=decisions.find(value=>!value.replayed);
      // A fresh saver and graph represent a restarted API process. Native
      // serialization, not a replayed prompt/model request, resumes the node.
      const output=await inWorkspace(1,()=>graph(claimed.host.checkpointer).invoke(new Command({resume:{[claimed.host.resume.interruptId]:claimed.host.resume.value}}),config));
      assert.equal(output.answer,"2000–3000 元");
      assert.equal(effects,1);
      await inWorkspace(1,()=>interactions.complete(first.runId));
      assert.equal((await inWorkspace(1,()=>interactions.list(first.runId)))[0].status,"answered");
      assert.equal((await inWorkspace(1,()=>db.query("SELECT * FROM agent_native_checkpoints WHERE run_id=$1",[first.runId]))).rowCount,0);
      const replay=await inWorkspace(1,()=>interactions.respond(first.runId,response));
      assert.equal(replay.replayed,true);
      assert.equal(effects,1);
    });

    await t.test("sequential approvals sharing one native task keep separate pending cards",async()=>{
      const call=await makeCall(),trace=randomUUID();
      const initial=await inWorkspace(1,()=>interactions.createHost(call.runId,{traceId:trace,agentId:1,agentVersionId:1}));
      await inWorkspace(1,()=>initial.checkpointer.put({configurable:{thread_id:call.runId}},emptyCheckpoint(),{source:"input",step:-1,parents:{}},{}));
      const request={kind:"approval",toolName:"submit",description:"Submit fixture",toolVersionId:10,toolCallId:"first",arguments:{token:"private-fixture-token",amount:20}};
      const card=await inWorkspace(1,()=>interactions.saveWaiting(call.runId,trace,new InteractionSuspension(request,"one-native-task",{harness:{fixture:true},execution:{fixture:true}}),c=>access.pause(call.runId,c)));
      assert.equal(JSON.stringify(card).includes("private-fixture-token"),false);
      await inWorkspace(1,()=>interactions.respond(call.runId,{kind:"approval",interactionId:card.id,revision:1,decision:"approve"},c=>access.resume(call.runId,c)));
      const second=await inWorkspace(1,()=>interactions.saveWaiting(call.runId,trace,new InteractionSuspension({...request,toolCallId:"second",arguments:{amount:30}},"one-native-task",{harness:{fixture:true},execution:{fixture:true}}),c=>access.pause(call.runId,c)));
      assert.notEqual(card.id,second.id);
      const resolved=await inWorkspace(1,()=>interactions.respond(call.runId,{kind:"approval",interactionId:second.id,revision:1,decision:"reject"},c=>access.resume(call.runId,c)));
      assert.equal(resolved.interaction.status,"rejected");
      assert.deepEqual((await inWorkspace(1,()=>interactions.list(call.runId))).map(value=>value.status),["approved","rejected"]);
      await inWorkspace(1,()=>interactions.complete(call.runId));
    });

    await t.test("competing approve and reject decisions have exactly one committed winner",async()=>{
      const call=await makeCall(),trace=randomUUID();
      const initial=await inWorkspace(1,()=>interactions.createHost(call.runId,{traceId:trace,agentId:call.agentId}));
      await inWorkspace(1,()=>initial.checkpointer.put({configurable:{thread_id:call.runId}},emptyCheckpoint(),{source:"input",step:-1,parents:{}},{}));
      const request={kind:"approval",toolName:"submit",description:"Submit fixture",toolVersionId:11,toolCallId:"competing",arguments:{amount:20}};
      const card=await inWorkspace(1,()=>interactions.saveWaiting(call.runId,trace,new InteractionSuspension(request,"competing-native",{harness:{fixture:true},execution:{fixture:true}}),c=>access.pause(call.runId,c)));
      const results=await Promise.allSettled(["approve","reject"].map(decision=>inWorkspace(1,()=>interactions.respond(call.runId,{kind:"approval",interactionId:card.id,revision:1,decision},c=>access.resume(call.runId,c)))));
      assert.equal(results.filter(value=>value.status==="fulfilled").length,1);
      const rejected=results.find(value=>value.status==="rejected");
      assert.equal(rejected.reason.getStatus(),409);
      const winner=results.find(value=>value.status==="fulfilled").value.interaction.status;
      assert.equal((await inWorkspace(1,()=>interactions.list(call.runId)))[0].status,winner);
      await inWorkspace(1,()=>interactions.complete(call.runId));
    });

    await t.test("expired interactions cannot resume and purge their private checkpoints",async()=>{
      const call=await makeCall(),trace=randomUUID();
      const initial=await inWorkspace(1,()=>interactions.createHost(call.runId,{traceId:trace,agentId:1}));
      await inWorkspace(1,()=>initial.checkpointer.put({configurable:{thread_id:call.runId}},emptyCheckpoint(),{source:"input",step:-1,parents:{}},{}));
      const card=await inWorkspace(1,()=>interactions.saveWaiting(call.runId,trace,new InteractionSuspension(ask,"expire-native",{harness:{fixture:true},execution:{fixture:true}}),c=>access.pause(call.runId,c)));
      await inWorkspace(1,()=>db.query("UPDATE agent_interactions SET expires_at=now()-interval '1 second' WHERE id=$1",[card.id]));
      await inWorkspace(1,()=>db.query("UPDATE agent_interaction_threads SET expires_at=now()-interval '1 second' WHERE run_id=$1",[call.runId]));
      await assert.rejects(inWorkspace(1,()=>interactions.respond(call.runId,{kind:"question",interactionId:card.id,revision:1,text:"2000元"},c=>access.resume(call.runId,c))),/已过期/);
      const history=await inWorkspace(1,()=>interactions.list(call.runId));
      assert.equal(history[0].status,"expired");
      const thread=await inWorkspace(1,()=>interactions.thread(call.runId));
      assert.deepEqual(thread.host_input,{});
      assert.deepEqual(thread.continuation,{});
      assert.equal(thread.status,"expired");
      assert.equal((await inWorkspace(1,()=>db.query("SELECT * FROM agent_native_checkpoints WHERE run_id=$1",[call.runId]))).rowCount,0);
      assert.equal((await inWorkspace(1,()=>db.query("SELECT * FROM agent_native_checkpoint_writes WHERE run_id=$1",[call.runId]))).rowCount,0);
    });
  } finally {
    if(db)await db.onModuleDestroy();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
