import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import 'reflect-metadata';
import { AdminDashboardService } from '../dist/admin/admin-dashboard.service.js';

// Explicit opt-in. Everything lives in a unique schema inside a rolled-back transaction;
// no migrations, existing tables, credentials or production records are changed.
test('dashboard SQL aggregates time boundaries, queued runs and searchable indexes in PostgreSQL', {
  skip: !process.env.DASHBOARD_TEST_DATABASE_URL,
}, async () => {
  const client = new pg.Client({ connectionString: process.env.DASHBOARD_TEST_DATABASE_URL });
  const schema = `dashboard_test_${randomUUID().replaceAll('-', '_')}`;
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE conversations (id uuid, visitor_session_id uuid);
      CREATE TABLE conversation_messages (id int, conversation_id uuid, role text, created_at timestamptz);
      CREATE TABLE chat_traces (id uuid, conversation_id uuid, user_message_id int, question text, kind text,
        status text, refused boolean, duration_ms int, total_tokens int, error_code text, created_at timestamptz);
      CREATE TABLE conversation_runs (conversation_id uuid, user_message_id int, question text, status text,
        error_code text, expires_at timestamptz, created_at timestamptz);
      CREATE TABLE knowledge_bases (id int, name text, archived_at timestamptz, enabled_for_chat boolean, active_index_version_id int);
      CREATE TABLE documents (id int, knowledge_base_id int, title text, source_type text, status text,
        archived_at timestamptz, enabled_for_retrieval boolean, updated_at timestamptz);
      CREATE TABLE document_chunks (id int, document_id int);
      CREATE TABLE knowledge_index_versions (id int, status text);
      CREATE TABLE index_chunks (id int, document_id int, version_id int, kind text);
    `);
    const conversationIds = Array.from({ length: 4 }, () => randomUUID());
    const visitorId = randomUUID();
    const recordedAt = new Date(Date.now() - 300000).toISOString();
    for (const id of conversationIds) {
      await client.query('INSERT INTO conversations VALUES ($1,$2)', [id, visitorId]);
    }
    await client.query(`INSERT INTO conversation_messages VALUES
      (1,$1,'user',$3),(2,$2,'user',$3),(3,$1,'assistant',$3),(4,$4,'user',now()-interval '90 days')`,
    [conversationIds[0], conversationIds[1], recordedAt, conversationIds[3]]);
    await client.query(`INSERT INTO chat_traces
      SELECT gen_random_uuid(),$1,1,'answered question','answer','completed',false,100,20,NULL,$2
      FROM generate_series(1,55)`, [conversationIds[0], recordedAt]);
    const failedTraceId = randomUUID();
    await client.query(`INSERT INTO chat_traces VALUES
      ($1,$2,2,'refused question','answer','completed',true,300,20,NULL,$4),
      ($3,$2,2,'failed question','answer','failed',NULL,600,NULL,'provider_timeout',$4),
      (gen_random_uuid(),$2,NULL,'summary','summary','completed',false,9999,9999,NULL,$4),
      (gen_random_uuid(),$2,NULL,'old question','answer','completed',false,1,1,NULL,now()-interval '90 days'),
      (gen_random_uuid(),$2,NULL,'future question','answer','completed',false,1,1,NULL,now()+interval '1 day')`,
    [randomUUID(), conversationIds[1], failedTraceId, recordedAt]);
    await client.query(`INSERT INTO conversation_runs VALUES
      ($1,2,'failed question','failed','provider_timeout',now(),$3),
      ($2,NULL,'untraced failure','failed','answer_failed',now(),$3),
      ($2,NULL,'queued','queued',NULL,now()+interval '5 minutes',$3),
      ($2,NULL,'overdue queued','queued',NULL,now()-interval '1 minute',$3),
      ($2,NULL,'finished expired','expired','request_expired',now()-interval '1 minute',$3)`,
    [conversationIds[1], conversationIds[0], recordedAt]);
    await client.query(`INSERT INTO knowledge_bases VALUES
      (1,'live',NULL,true,NULL),(2,'disabled',NULL,false,NULL),(3,'archived',now(),true,NULL),
      (4,'versioned',NULL,true,100),(5,'empty',NULL,true,NULL);
      INSERT INTO documents VALUES
      (1,1,'ready','file','ready',NULL,true,now()),
      (2,1,'retrieval off','file','ready',NULL,false,now()),
      (3,1,'failed live','file','failed',NULL,true,now()),
      (4,1,'pending','file','pending',NULL,true,now()),
      (5,1,'archived file','file','ready',now(),true,now()),
      (6,1,'FAQ','faq','ready',NULL,true,now()),
      (7,2,'disabled base file','file','ready',NULL,true,now()),
      (8,3,'archived base file','file','ready',NULL,true,now()),
      (9,4,'reprocessing failed, old index retained','file','failed',NULL,true,now());
      INSERT INTO document_chunks VALUES (1,1),(2,1),(3,2),(4,3),(5,5),(6,6),(7,7),(8,8);
      INSERT INTO knowledge_index_versions VALUES (99,'ready'),(100,'ready');
      INSERT INTO index_chunks VALUES (9,9,100,'general'),(10,9,100,'parent'),(11,9,99,'general');
    `);
    // The real service uses a pool; this transaction-bound fixture serializes queries
    // because one pg Client must not run concurrent queries.
    let queued = Promise.resolve();
    const service = new AdminDashboardService({ query: (...args) => {
      const result = queued.then(() => client.query(...args));
      queued = result.then(() => undefined, () => undefined);
      return result;
    } });
    const result = await service.overview('7d', ['conversations.read', 'documents.read']);
    const a = result.activity;
    assert.equal(a.requestCount, 57);
    assert.equal(a.answeredCount, 55);
    assert.equal(a.refusedCount, 1);
    assert.equal(a.failedCount, 1);
    assert.equal(a.totalTokens, 1120);
    assert.equal(a.tokenRecordedCount, 56);
    assert.equal(a.averageDurationMs, 104);
    assert.equal(a.p95DurationMs, 100);
    assert.equal(a.conversationCount, 2);
    assert.equal(a.visitorCount, 1);
    assert.equal(a.runningCount, 1);
    assert.equal(a.expiredCount, 1);
    assert.equal(a.failedRunCount, 2);
    assert.equal(a.trend.length, 7);
    assert.equal(a.trend.reduce((sum, point) => sum + point.answered + point.refused + point.failed, 0), 57);
    assert.equal(a.recentFailures.length, 3, 'exactly linked failed run must not duplicate its failed trace');
    assert.ok(a.recentFailures.some(item => item.traceId === failedTraceId));
    assert.ok(a.recentFailures.some(item => item.question === 'overdue queued' && item.status === 'expired'));
    assert.deepEqual(Object.fromEntries(Object.entries(result.knowledge).filter(([key]) => key !== 'recentFailures')), {
      baseCount: 4, enabledBaseCount: 3, documentCount: 6, readyCount: 3,
      retrievableCount: 2, chunkCount: 3, processingCount: 1, failedCount: 2,
    });
    assert.deepEqual(new Set(result.knowledge.recentFailures.map(item => item.id)), new Set([3, 9]));
    assert.equal((await service.overview('24h', ['documents.read'])).activity, null);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
