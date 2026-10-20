import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { InteractionService } from '../dist/interactions/interaction.service.js';

function fixture(mode) {
  const runId=randomUUID(),id=randomUUID();
  const expiresAt=new Date(Date.now()+(mode==='expiry'?-60000:60000)).toISOString();
  const request={kind:'approval',toolName:'write_record',description:'Write record',toolVersionId:4,toolCallId:'call-1',arguments:{password:'PRIVATE_SECRET',record:{value:1}}};
  const publicRequest={kind:'approval',toolName:'write_record',description:'Write record',arguments:{password:'[REDACTED]',record:{value:1}}};
  const approved=mode==='complete';
  const row={id,run_id:runId,interrupt_id:'native',revision:approved?2:1,kind:'approval',status:approved?'approved':'pending',request,public_request:publicRequest,request_key:'fixed-request-digest',response:approved?{decision:'approve'}:null,response_fingerprint:approved?createHash('sha256').update('{"decision":"approve"}').digest('hex'):null,expires_at:expiresAt};
  const history={...structuredClone(row),id:randomUUID(),request_key:'historic-request-digest',status:'approved',revision:2,response:{decision:'approve'}};
  const question={...structuredClone(row),id:randomUUID(),kind:'question',status:'answered',request:{kind:'question',question:'Which?',options:[],allowCustom:true},public_request:{kind:'question',question:'Which?',options:[],allowCustom:true},response:{text:'a'}};
  const rows=[row,history,question];
  const thread={run_id:runId,host_input:{private:'PRIVATE_CONTEXT'},continuation:{harness:{private:'PRIVATE_STATE'},execution:{}},interrupt_id:'native',status:approved?'resuming':'waiting',expires_at:expiresAt};
  const effects={writes:2,checkpoints:3,cleanup:[]};
  let inTransaction=false,failCheckpointDeletion=false;
  const c={query:async(sql,args=[])=>{
    assert.equal(inTransaction,true,'terminal state and native state must share one transaction');
    if(sql.startsWith('SELECT * FROM agent_interaction_threads'))return {rows:args[0]===runId?[structuredClone(thread)]:[]};
    if(sql.startsWith('SELECT * FROM agent_interactions'))return {rows:args[1]===runId?rows.filter(r=>r.id===args[0]).map(r=>structuredClone(r)):[]};
    if(sql.startsWith('UPDATE agent_interaction_threads')) {
      const next=sql.match(/status='([^']+)'/)[1];
      if(next==='expired' && new Date(thread.expires_at).getTime()>Date.now())return {rows:[],rowCount:0};
      thread.status=next;thread.host_input={};thread.continuation={};
      return {rows:next==='expired'?[{run_id:runId}]:[],rowCount:1};
    }
    if(sql.startsWith('UPDATE agent_interactions SET status=')) {
      const next=sql.match(/status='([^']+)'/)[1];
      const affected=rows.filter(r=>r.status==='pending'&&(!sql.includes('WHERE id=$1')||r.id===args[0]));
      affected.forEach(r=>{r.status=next;r.revision++;});
      return {rows:sql.includes('RETURNING')?affected.map(r=>structuredClone(r)):[],rowCount:affected.length};
    }
    if(sql.startsWith('UPDATE agent_interactions SET request=jsonb_set')) {
      effects.cleanup.push('arguments');
      rows.filter(r=>args[0].includes(r.run_id)&&r.kind==='approval'&&r.status!=='pending').forEach(r=>{r.request.arguments={};});
      return {rows:[],rowCount:2};
    }
    if(sql.startsWith('DELETE FROM agent_native_checkpoint_writes')){effects.cleanup.push('writes');effects.writes=0;return {rows:[],rowCount:2};}
    if(sql.startsWith('DELETE FROM agent_native_checkpoints')) {
      if(failCheckpointDeletion)throw new Error('checkpoint deletion failed');
      effects.cleanup.push('checkpoints');effects.checkpoints=0;return {rows:[],rowCount:3};
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }};
  const db={query:async()=>{throw new Error('non-transactional cleanup');},transaction:async(work)=>{
    const saved=structuredClone({thread,rows,effects});
    inTransaction=true;
    try{return await work(c);}
    catch(error){Object.assign(thread,saved.thread);rows.forEach((r,i)=>Object.assign(r,saved.rows[i]));Object.assign(effects,saved.effects);throw error;}
    finally{inTransaction=false;}
  }};
  const service=new InteractionService(db);
  const terminate=()=>mode==='complete'?service.complete(runId):mode==='cancel'?service.cancel(runId):mode==='cancelWaiting'?service.cancelWaiting(runId,id):service.purgeExpired();
  return {service,runId,id,row,history,question,thread,effects,terminate,failDeletion:()=>{failCheckpointDeletion=true;}};
}

for(const mode of ['complete','cancel','cancelWaiting','expiry']) {
  test(`${mode} removes private approval arguments and native state while retaining safe historical cards and idempotency`,async()=>{
    const f=fixture(mode);
    const preserved={public:structuredClone(f.row.public_request),requestKey:f.row.request_key,fingerprint:f.row.response_fingerprint,response:structuredClone(f.row.response),question:structuredClone(f.question.request)};
    await f.terminate();
    assert.deepEqual(f.row.request.arguments,{});
    assert.deepEqual(f.history.request.arguments,{});
    assert.deepEqual(f.row.public_request,preserved.public);
    assert.equal(f.row.request_key,preserved.requestKey);
    assert.equal(f.row.response_fingerprint,preserved.fingerprint);
    assert.deepEqual(f.row.response,preserved.response);
    assert.deepEqual(f.question.request,preserved.question);
    assert.deepEqual(f.thread.host_input,{});
    assert.deepEqual(f.thread.continuation,{});
    assert.deepEqual(f.effects,{writes:0,checkpoints:0,cleanup:['arguments','writes','checkpoints']});
    if(mode==='complete') {
      const replay=await f.service.respond(f.runId,{kind:'approval',interactionId:f.id,revision:1,decision:'approve'});
      assert.equal(replay.replayed,true);
      assert.deepEqual(replay.interaction.arguments,preserved.public.arguments);
      assert.equal(replay.interaction.status,'approved');
    }
  });
}

test('a failed terminal cleanup rolls back both raw approval argument removal and checkpoint deletion',async()=>{
  const f=fixture('complete');
  f.failDeletion();
  await assert.rejects(f.terminate(),/checkpoint deletion failed/);
  assert.equal(f.row.request.arguments.password,'PRIVATE_SECRET');
  assert.equal(f.thread.status,'resuming');
  assert.equal(f.thread.continuation.harness.private,'PRIVATE_STATE');
  assert.deepEqual(f.effects,{writes:2,checkpoints:3,cleanup:[]});
});
