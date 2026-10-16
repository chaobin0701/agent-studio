import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import { AdminDashboardService, dashboardWindow } from '../dist/admin/admin-dashboard.service.js';
import { AdminDashboardController } from '../dist/admin/admin-dashboard.controller.js';
import { PERMISSION_KEY } from '../dist/admin/permission.decorator.js';

const now = new Date('2026-10-08T03:42:30.000Z');
const fields = {
  answers: { requestCount: 65, answeredCount: 50, refusedCount: 10, failedCount: 5, averageDurationMs: 2300, p95DurationMs: 5000, totalTokens: '123456', tokenRecordedCount: 60 },
  audience: { conversationCount: 12, visitorCount: 9 },
  runs: { runningCount: 1, expiredCount: 0, failedRunCount: 5 },
  knowledge: { baseCount: 3, enabledBaseCount: 2, documentCount: 84, readyCount: 72, retrievableCount: 68, processingCount: 7, failedCount: 5, chunkCount: 1234 },
};
function fixture(overrides = {}) {
  const statements = [];
  const database = { query: async (sql, values) => {
    const type = /dashboard:([\w-]+)/.exec(sql)?.[1];
    statements.push({ type, sql, values });
    if (type === 'trend') return { rows: [{ time: '2026-10-08T00:00:00+08:00', label: '10-08', answered: 50, refused: 10, failed: 5 }] };
    if (type === 'attention' || type === 'failed-documents') return { rows: [] };
    return { rows: [{ ...fields[type], ...overrides[type] }] };
  } };
  return { service: new AdminDashboardService(database), statements };
}

test('dashboard window uses Shanghai natural days and a rolling 24-hour period', () => {
  assert.deepEqual(dashboardWindow('7d', now), { key: '7d', since: '2026-10-01T16:00:00.000Z', until: now.toISOString(), timezone: 'Asia/Shanghai', bucket: 'day' });
  assert.equal(dashboardWindow('30d', now).since, '2026-09-08T16:00:00.000Z');
  assert.equal(dashboardWindow('24h', now).since, '2026-10-07T03:42:30.000Z');
  assert.equal(dashboardWindow('24h', now).bucket, 'hour');
  // A UTC evening already belongs to the following Shanghai calendar date.
  assert.equal(dashboardWindow('7d', new Date('2026-10-08T17:00:00Z')).since, '2026-10-02T16:00:00.000Z');
});
test('invalid ranges and lack of permission never execute statistics queries', async () => {
  const f = fixture();
  for (const value of ['', '365d', 7, null, ['7d']]) await assert.rejects(f.service.overview(value, ['conversations.read']), error => error.getStatus() === 400);
  await assert.rejects(f.service.overview('7d', ['model_profiles.read']), error => error.getStatus() === 403);
  assert.equal(f.statements.length, 0);
});
test('aggregated metrics are not capped by frontend pagination and unknown latency remains null', async () => {
  const f = fixture({ answers: { averageDurationMs: null, p95DurationMs: null } });
  const result = await f.service.overview('7d', ['conversations.read', 'documents.read']);
  assert.equal(result.activity.requestCount, 65); assert.equal(result.knowledge.documentCount, 84);
  assert.equal(result.activity.totalTokens, 123456); assert.equal(result.activity.averageDurationMs, null);
  const query = f.statements.find(item => item.type === 'answers');
  assert.match(query.sql, /kind='answer'/); assert.match(query.sql, /status='completed' AND refused=true/);
  assert.match(query.sql, /status='failed'/); assert.ok(!query.sql.includes('LIMIT'));
});
test('empty question activity does not invent a latency or a success rate', async () => {
  const f = fixture({ answers: { requestCount: 0, answeredCount: 0, refusedCount: 0, failedCount: 0, averageDurationMs: null, p95DurationMs: null, totalTokens: null, tokenRecordedCount: 0 } });
  const result = await f.service.overview('24h', ['conversations.read']);
  assert.equal(result.activity.totalTokens, 0); assert.equal(result.activity.p95DurationMs, null);
  assert.equal(result.knowledge, null); assert.ok(!('successRate' in result.activity));
});
test('permission-limited responses omit inaccessible sections and do not query them', async () => {
  const knowledge = fixture(); const knowledgeResult = await knowledge.service.overview('7d', ['knowledge_bases.manage']);
  assert.equal(knowledgeResult.activity, null); assert.ok(knowledgeResult.knowledge);
  assert.deepEqual(knowledge.statements.map(item => item.type).sort(), ['failed-documents', 'knowledge']);
  const chat = fixture(); const chatResult = await chat.service.overview('7d', ['conversations.read']);
  assert.equal(chatResult.knowledge, null); assert.ok(!chat.statements.some(item => item.type === 'knowledge'));
});
test('knowledge snapshot excludes archived resources and counts real searchable chunks', async () => {
  const f = fixture(); await f.service.overview('7d', ['documents.read']);
  const query = f.statements.find(item => item.type === 'knowledge').sql;
  assert.match(query, /knowledge_bases WHERE archived_at IS NULL/); assert.match(query, /d\.archived_at IS NULL AND d\.source_type='file'/);
  assert.match(query, /d\.enabled_for_retrieval AND d\.status='ready'/); assert.match(query, /kb\.enabled_for_chat/);
  assert.match(query, /kb\.active_index_version_id/); assert.match(query, /count\(DISTINCT document_id\)/);
});
test('trend fills empty buckets and excludes summary traces; audience excludes empty sessions', async () => {
  const f = fixture(); await f.service.overview('30d', ['conversations.read']);
  assert.match(f.statements.find(item => item.type === 'trend').sql, /generate_series/);
  assert.match(f.statements.find(item => item.type === 'trend').sql, /COALESCE\(t\.answered,0\)/);
  assert.match(f.statements.find(item => item.type === 'audience').sql, /m\.role='user'/);
  assert.equal(f.statements.find(item => item.type === 'trend').values[2], 'day');
});
test('running and overdue metrics use real queued/running states, not a fictitious pending state', async () => {
  const f = fixture(); await f.service.overview('7d', ['conversations.read']);
  for (const type of ['runs', 'attention']) {
    const query = f.statements.find(item => item.type === type).sql;
    assert.match(query, /status IN \('queued','running'\)/);
    assert.ok(!query.includes("'pending'"));
  }
  assert.match(f.statements.find(item => item.type === 'attention').sql, /t\.conversation_id IS NOT NULL/);
});
test('overview controller uses server-resolved permissions and defaults to seven days', async () => {
  const calls = [];
  const controller = new AdminDashboardController({ overview: (...args) => { calls.push(args); return {}; } }, { me: async admin => { assert.equal(admin.id, 7); return { permissionCodes: ['documents.read'] }; } });
  await controller.overview({ admin: { id: 7 } });
  assert.deepEqual(calls, [['7d', ['documents.read']]]);
  assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, AdminDashboardController.prototype.overview), ['conversations.read', 'documents.read', 'knowledge_bases.manage']);
});
