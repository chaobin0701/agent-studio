import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { AdminExecutionController } from '../dist/observability/admin-execution.controller.js';
import { PERMISSION_KEY } from '../dist/admin/permission.decorator.js';

const traceId = '11111111-1111-4111-8111-111111111111';

test('conversation reader keeps execution read permission and rejects missing/unscoped records before reading history', async () => {
  assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, AdminExecutionController.prototype.conversation), ['conversations.read']);
  const calls = [];
  const controller = new AdminExecutionController({ query: async (sql, args) => { calls.push([sql, args]); return { rows: [] }; } }, {});
  await assert.rejects(controller.conversation(traceId), error => error.getStatus() === 404);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], [traceId]);
  for (const args of [[traceId, '0'], [traceId, 'bad'], [traceId, '1', '51']]) {
    await assert.rejects(controller.conversation(...args), error => error.getStatus() === 400);
  }
  assert.equal(calls.length, 1);
  const stateless = new AdminExecutionController({ query: async () => ({ rows: [{ id: traceId, conversationId: null }] }) }, {});
  assert.deepEqual(await stateless.conversation(traceId), { conversation: null, items: [], total: 0, page: 1, pageSize: 10 });
});

test('PostgreSQL conversation timeline: multi-turn pairing, failed attempts, pagination, current execution, isolation and safe projection', { skip: process.env.KB_INTEGRATION !== '1' }, async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Session-local fixtures cannot change the running application or its data.
    await client.query(`CREATE TEMP TABLE conversations(id uuid PRIMARY KEY, title text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TEMP TABLE conversation_messages(id bigint PRIMARY KEY, conversation_id uuid, role text, content text, refused boolean, created_at timestamptz);
      CREATE TEMP TABLE chat_traces(id uuid PRIMARY KEY, kind text DEFAULT 'answer', conversation_id uuid, user_message_id bigint, question text, final_answer text, refused boolean, status text, error_code text, input_tokens int, output_tokens int, total_tokens int, duration_ms int, created_at timestamptz, context_snapshot jsonb);`);
    const conversationId = '22222222-2222-4222-8222-222222222222';
    const otherId = '33333333-3333-4333-8333-333333333333';
    const failureId = '44444444-4444-4444-8444-444444444444';
    const summaryId = '55555555-5555-4555-8555-555555555555';
    await client.query(`INSERT INTO conversations(id,title) VALUES($1,'多轮测试'),($2,'OTHER_CONVERSATION')`, [conversationId, otherId]);
    for (let turn = 1; turn <= 12; turn++) {
      const created = new Date(Date.UTC(2026, 9, 27, 0, turn));
      await client.query(`INSERT INTO conversation_messages VALUES($1,$2,'user',$3,false,$4),($5,$2,'assistant',$6,false,$4)`, [turn * 2 - 1, conversationId, `问题${turn}`, created, turn * 2, `回答${turn}`]);
    }
    await client.query(`INSERT INTO conversation_messages VALUES(100,$1,'user','OTHER_PRIVATE_MESSAGE',false,now())`, [otherId]);
    await client.query(`INSERT INTO chat_traces(id,conversation_id,user_message_id,question,final_answer,status,total_tokens,duration_ms,created_at,context_snapshot) VALUES($1,$2,21,'问题11','回答11','completed',120,20,'2026-10-27T00:11:01Z','{"systemPrompt":"PRIVATE_PROMPT","toolResults":"PRIVATE_TOOL"}')`, [traceId, conversationId]);
    await client.query(`INSERT INTO chat_traces(id,conversation_id,question,status,error_code,duration_ms,created_at) VALUES($1,$2,'失败尝试','failed','MODEL_TIMEOUT',20,'2026-10-27T00:10:30Z')`, [failureId, conversationId]);
    await client.query(`INSERT INTO chat_traces(id,kind,conversation_id,question,final_answer,status,duration_ms,created_at) VALUES($1,'summary',$2,'PRIVATE_SUMMARY','PRIVATE_SUMMARY','completed',20,'2026-10-27T00:10:40Z')`, [summaryId, conversationId]);
    const controller = new AdminExecutionController({ query: (sql, args) => client.query(sql, args) }, {});
    const current = await controller.conversation(traceId);
    assert.equal(current.conversation.title, '多轮测试');
    assert.equal(current.total, 13);
    assert.equal(current.page, 2);
    assert.deepEqual(current.items.map(item => item.question), ['失败尝试', '问题11', '问题12']);
    assert.equal(current.items[0].errorCode, 'MODEL_TIMEOUT');
    assert.equal(current.items[1].traceId, traceId);
    assert.equal(current.items[1].finalAnswer, '回答11');
    assert.equal(current.items[2].traceId, null, 'conversation remains readable when trace recording was off');
    const first = await controller.conversation(traceId, '1');
    assert.equal(first.items.length, 10);
    assert.deepEqual(first.items.map(item => item.finalAnswer), Array.from({ length: 10 }, (_, i) => `回答${i + 1}`));
    assert.doesNotMatch(JSON.stringify([current, first]), /OTHER_PRIVATE|PRIVATE_PROMPT|PRIVATE_TOOL|PRIVATE_SUMMARY/);
    const failed = await controller.conversation(failureId, undefined, '5');
    assert.equal(failed.page, 3);
    assert.equal(failed.items[0].traceId, failureId);
    const empty = await controller.conversation(traceId, '4');
    assert.equal(empty.items.length, 0);
    await client.query(`UPDATE conversation_messages SET created_at='2026-10-27T00:01:00Z' WHERE id<=20`);
    const tied = await controller.conversation(traceId, '1');
    assert.deepEqual(tied.items.map(item => item.question), Array.from({ length: 10 }, (_, i) => `问题${i + 1}`));
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
