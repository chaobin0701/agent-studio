import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmService, ModelStreamProtocolError } from '../dist/chat/llm.service.js';
import { withModelCallAccounting, modelInputReservation } from '../dist/chat/model-call-accounting.js';
import { quotaExceeded } from '../dist/integrations/quota-error.js';

const usage = { inputTokens: 10, outputTokens: 3, totalTokens: 13 };
const response = content => ({ content, toolCalls: [], model: 'fixture', usage, finishReason: 'stop' });

test('each paid retry is metered, including empty output; no prompt text is stored by accounting', async () => {
  let calls=0; const events=[];
  const llm=new LlmService({ model:'fixture', maxOutputTokens:1200, chat:async()=>response(++calls===1?'':'ok') });
  const result=await withModelCallAccounting({ reserve:async(request,purpose)=>{
    events.push({ purpose, amount:modelInputReservation(request), maxTokens:request.maxTokens });
    return { settle:async tokens=>events.push(tokens) };
  } },()=>llm.completeDetailed('system','question','fixture','planner'));
  assert.equal(calls,2); assert.equal(result.totalTokens,26); assert.equal(events.length,4);
  assert.deepEqual(events[1],usage); assert.deepEqual(events[3],usage);
});

test('quota rejection propagates before the provider with no automatic retry', async () => {
  let calls=0, reservations=0;
  const llm=new LlmService({ model:'fixture', chat:async()=>{calls++;return response('ok');} });
  await assert.rejects(withModelCallAccounting({ reserve:async()=>{reservations++;throw quotaExceeded('daily_token_budget_insufficient','额度不足','2026-10-09T00:00:00+08:00');} },()=>llm.completeDetailed('s','q')),
    e=>e.getStatus()===429&&e.getResponse().code==='daily_token_budget_insufficient');
  assert.equal(calls,0); assert.equal(reservations,1);
});

test('settlement failure does not replay a paid model call', async () => {
  let calls=0;
  const llm=new LlmService({ model:'fixture', chat:async()=>{calls++;return response('ok');} });
  await assert.rejects(withModelCallAccounting({reserve:async()=>({settle:async()=>{throw new Error('accounting unavailable');}})},()=>llm.completeDetailed('s','q')),/accounting unavailable/);
  assert.equal(calls,1);
});

test('concurrent applications remain isolated and async summaries inherit their original accounting', async () => {
  const tags=[];
  const llm=new LlmService({ model:'fixture', chat:async()=>{await new Promise(r=>setTimeout(r,5));return response('ok');} });
  const context=tag=>({reserve:async(_request,purpose)=>({settle:async()=>tags.push(`${tag}:${purpose}`)})});
  let summary;
  await Promise.all(['A','B'].map(tag=>withModelCallAccounting(context(tag),async()=>{
    await llm.completeDetailed('s','q','fixture','planner');
    if(tag==='A') summary=new Promise(resolve=>setTimeout(()=>resolve(llm.completeDetailed('s','q','fixture','summary')),10));
  })));
  await summary;
  assert.deepEqual(tags.sort(),['A:planner','A:summary','B:planner']);
});

test('stream interruption is settled as missing usage without losing already delivered text', async () => {
  const deltas=[],settlements=[];
  const llm=new LlmService({ model:'fixture', async *stream(){yield {type:'text_delta',delta:'部分回答'};throw new Error('disconnected');} });
  await assert.rejects(withModelCallAccounting({reserve:async()=>({settle:async(tokens,error)=>settlements.push({tokens,error})})},()=>llm.streamText('s','q',text=>deltas.push(text))),/disconnected/);
  assert.deepEqual(deltas,['部分回答']); assert.equal(settlements.length,1); assert.equal(settlements[0].tokens.totalTokens,null);
});

test('provider output truncation keeps the answer stream unfinished', async () => {
  const deltas = [];
  const llm = new LlmService({ model: 'fixture', async *stream() {
    yield { type: 'text_delta', delta: '部分回答' };
    yield { type: 'completed', usage, finishReason: 'length' };
  } });
  await assert.rejects(
    withModelCallAccounting({ reserve: async () => ({ settle: async () => {} }) }, () => llm.streamText('s', 'q', text => deltas.push(text))),
    error => error instanceof ModelStreamProtocolError && error.reason === 'output_truncated',
  );
  assert.deepEqual(deltas, ['部分回答']);
});

test('planner stream assembles complete native calls before returning them', async () => {
  const llm = new LlmService({ model: 'fixture', async *stream() {
    yield { type: 'tool_call_delta', index: 1, id: 'call-b', name: 'get_product_detail', argumentsDelta: '{"productId":"two"' };
    yield { type: 'tool_call_delta', index: 0, id: 'call-a', name: 'get_product_detail', argumentsDelta: '{"productId":"one"}' };
    yield { type: 'tool_call_delta', index: 1, argumentsDelta: '}' };
    yield { type: 'completed', usage, finishReason: 'tool_calls' };
  } });
  const result = await withModelCallAccounting({ reserve: async () => ({ settle: async () => {} }) }, () => llm.streamDetailed('system', 'question', 'fixture', 'planner', { tools: [] }));
  assert.deepEqual(result.toolCalls, [
    { id: 'call-a', name: 'get_product_detail', arguments: { productId: 'one' } },
    { id: 'call-b', name: 'get_product_detail', arguments: { productId: 'two' } },
  ]);
});

test('planner stream rejects incomplete tool arguments before any caller can execute them', async () => {
  const llm = new LlmService({ model: 'fixture', async *stream() {
    yield { type: 'tool_call_delta', index: 0, id: 'call-a', name: 'get_product_detail', argumentsDelta: '{"productId":"one"' };
    yield { type: 'completed', usage, finishReason: 'tool_calls' };
  } });
  await assert.rejects(
    withModelCallAccounting({ reserve: async () => ({ settle: async () => {} }) }, () => llm.streamDetailed('system', 'question', 'fixture', 'planner')),
    error => error instanceof ModelStreamProtocolError && error.reason === 'invalid_tool_arguments',
  );
});
