import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { InteractionService } from '../dist/interactions/interaction.service.js';

/** An offline transactional boundary with a real mutex: concurrent responses and
 * cancellation contend on the same thread lock, as the PostgreSQL host does. */
function fixture() {
  const runId=randomUUID(),id=randomUUID();
  const row={id,run_id:runId,interrupt_id:'native',revision:1,kind:'approval',status:'pending',
    request:{kind:'approval',toolName:'write_record',toolVersionId:4,toolCallId:'write-1',description:'Write',arguments:{value:1}},
    public_request:{kind:'approval',toolName:'write_record',description:'Write',arguments:{value:1}},
    response:null,response_fingerprint:null,expires_at:new Date(Date.now()+60000).toISOString()};
  const thread={run_id:runId,host_input:{},continuation:{harness:{},execution:{}},interrupt_id:'native',status:'waiting',expires_at:row.expires_at};
  const effects={resume:0,cancel:0,deleted:0,ledger:'waiting',conversation:'waiting'};
  let queued=Promise.resolve();
  const client={query:async(sql,args=[])=>{
    if(sql.startsWith('SELECT * FROM agent_interaction_threads'))return {rows:args[0]===runId?[structuredClone(thread)]:[]};
    if(sql.startsWith('SELECT * FROM agent_interactions'))return {rows:args[0]===id&&args[1]===runId?[structuredClone(row)]:[]};
    if(sql.startsWith('UPDATE agent_interactions SET status=$2')){
      Object.assign(row,{status:args[1],response:JSON.parse(args[2]),response_fingerprint:args[3],revision:row.revision+1});return {rows:[structuredClone(row)]};
    }
    if(sql.startsWith("UPDATE agent_interactions SET status='cancelled'")){
      if(row.status!=='pending')return {rows:[],rowCount:0};
      row.status='cancelled';row.revision++;return {rows:[structuredClone(row)],rowCount:1};
    }
    if(sql.startsWith("UPDATE agent_interaction_threads SET status='resuming'")){thread.status='resuming';return {rows:[],rowCount:1};}
    if(sql.startsWith("UPDATE agent_interaction_threads SET status='cancelled'")){thread.status='cancelled';thread.host_input={};thread.continuation={};return {rows:[],rowCount:1};}
    if(sql.startsWith("UPDATE agent_interactions SET request=jsonb_set")){if(row.status!=='pending')row.request.arguments={};return {rows:[],rowCount:1};}
    if(sql.startsWith('DELETE FROM agent_native_checkpoint_writes'))return {rows:[],rowCount:1};
    if(sql.startsWith('DELETE FROM agent_native_checkpoints')){effects.deleted++;return {rows:[],rowCount:1};}
    throw new Error(`Unexpected SQL: ${sql}`);
  }};
  const db={query:client.query,transaction:async(work)=>{
    let release;
    const previous=queued;
    queued=new Promise(resolve=>{release=resolve;});
    await previous;
    const snapshot=structuredClone({row,thread,effects});
    try{return await work(client);}
    catch(error){Object.assign(row,snapshot.row);Object.assign(thread,snapshot.thread);Object.assign(effects,snapshot.effects);throw error;}
    finally{release();}
  }};
  return {runId,id,row,thread,effects,service:new InteractionService(db),
    resume:async(c)=>{assert.equal(c,client);await setImmediate();effects.resume++;effects.ledger='running';effects.conversation='running';},
    cancel:async(c)=>{assert.equal(c,client);await setImmediate();effects.cancel++;effects.ledger='failed';effects.conversation='interrupted';}};
}
const answer=(f)=>({kind:'approval',interactionId:f.id,revision:1,decision:'approve'});

test('response winning the thread lock makes stale public cancellation conflict without clearing active state',async()=>{
  const f=fixture();
  const results=await Promise.allSettled([
    f.service.respond(f.runId,answer(f),f.resume),
    f.service.cancelWaiting(f.runId,f.id,f.cancel),
  ]);
  assert.equal(results[0].status,'fulfilled');
  assert.equal(results[1].status,'rejected');
  assert.equal(results[1].reason.getStatus(),409);
  assert.equal(f.thread.status,'resuming');
  assert.equal(f.row.status,'approved');
  assert.deepEqual(f.effects,{resume:1,cancel:0,deleted:0,ledger:'running',conversation:'running'});
});

test('waiting cancellation winning the thread lock prevents a concurrent approval from continuing',async()=>{
  const f=fixture();
  const results=await Promise.allSettled([
    f.service.cancelWaiting(f.runId,f.id,f.cancel),
    f.service.respond(f.runId,answer(f),f.resume),
  ]);
  assert.equal(results[0].status,'fulfilled');
  assert.equal(results[0].value.status,'cancelled');
  assert.equal(results[1].status,'rejected');
  assert.equal(results[1].reason.getStatus(),409);
  assert.equal(f.thread.status,'cancelled');
  assert.deepEqual(f.thread.continuation,{});
  assert.equal(f.row.status,'cancelled');
  assert.deepEqual(f.effects,{resume:0,cancel:1,deleted:1,ledger:'failed',conversation:'interrupted'});
});

test('public waiting cancellation rejects old or expired cards and rolls back a failed host transition',async()=>{
  const f=fixture();
  f.row.expires_at=new Date(Date.now()-1).toISOString();
  await assert.rejects(f.service.cancelWaiting(f.runId,f.id,f.cancel),/过期/);
  assert.equal(f.effects.cancel,0);
  f.row.expires_at=new Date(Date.now()+60000).toISOString();
  await assert.rejects(f.service.cancelWaiting(f.runId,randomUUID(),f.cancel),/不存在/);
  f.thread.interrupt_id='different';
  await assert.rejects(f.service.cancelWaiting(f.runId,f.id,f.cancel),/已处理/);
  f.thread.interrupt_id='native';
  await assert.rejects(f.service.cancelWaiting(f.runId,f.id,async(c)=>{await f.cancel(c);throw new Error('Concurrent host change');}),/host change/);
  assert.equal(f.row.status,'pending');
  assert.equal(f.thread.status,'waiting');
  assert.deepEqual(f.effects,{resume:0,cancel:0,deleted:0,ledger:'waiting',conversation:'waiting'});
});
