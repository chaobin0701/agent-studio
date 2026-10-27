import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemMcpService } from '../dist/system-mcp/system-mcp.service.js';
import { ConversationService } from '../dist/chat/conversation.service.js';
import { currentWorkspaceId } from '../dist/workspaces/workspace-context.js';

test('MCP credential authentication hashes the bearer value and normalizes workspace IDs', async () => {
  const queries = [];
  const db = { platformQuery: async (sql, values) => {
    queries.push({ sql, values });
    if (sql.includes('FROM system_mcp_credentials c JOIN admins')) return { rows: [{ id: 7, adminId: 3, workspaceIds: ['12'], scopes: ['agents.read'] }] };
    return { rows: [], rowCount: 1 };
  }};
  const service = new SystemMcpService(db, {}, {}, {});
  const result = await service.authenticate('Bearer astm_test-secret');
  assert.deepEqual(result.workspaceIds, [12]);
  assert.equal(result.adminId, 3);
  assert.match(queries[0].sql, /token_hash=\$1/);
  assert.notEqual(queries[0].values[0], 'astm_test-secret');
  assert.equal(queries[0].values[0].length, 64);
  await assert.rejects(service.authenticate('Bearer invalid'), /credential required/);
});

test('MCP scopes require the selected workspace, token scope and current account membership permission', async () => {
  let permissions = ['agent_config.read'];
  const db = { platformQuery: async (sql) => sql.includes('FROM workspaces w')
    ? { rows: [{ id: 12, role: 'member', permission_codes: permissions }] }
    : { rows: permissions.map(code => ({ code })) } };
  const service = new SystemMcpService(db, {}, {}, {});
  const credential = { adminId: 3, workspaceIds: [12], scopes: ['agents.read'] };
  const value = await service.withScope(credential, 12, 'agents.read', async () => currentWorkspaceId());
  assert.equal(value, 12);
  await assert.rejects(service.withScope(credential, 13, 'agents.read', async () => 'unreachable'), /does not grant/);
  await assert.rejects(service.withScope(credential, 12, 'prompts.read', async () => 'unreachable'), /does not grant/);
  permissions = [];
  await assert.rejects(service.withScope(credential, 12, 'agents.read', async () => 'unreachable'), /permission was removed/);
});

test('credential creation stores only a hash, checks permissions and returns the bearer once', async () => {
  const writes = [];
  const db = {
    platformQuery: async (sql, values) => {
      writes.push({ sql, values });
      if (sql.includes('FROM workspaces w')) return { rows: [{ id: 12, role: 'member', permission_codes: ['agent_config.read'] }] };
      if (sql.includes('SELECT code FROM permissions')) return { rows: [{ code: 'agent_config.read' }] };
      if (sql.includes('INSERT INTO system_mcp_credentials')) return { rows: [{ id: 11 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const service = new SystemMcpService(db, {}, {}, {});
  const created = await service.createCredential(3, { name: 'IDE', workspaceIds: [12], scopes: ['agents.read'] });
  assert.match(created.token, /^astm_/);
  const insert = writes.find(({ sql }) => sql.includes('INSERT INTO system_mcp_credentials'));
  assert.notEqual(insert.values[2], created.token);
  assert.equal(insert.values[2].length, 64);
  await assert.rejects(service.createCredential(3, { name: 'Too wide', workspaceIds: [12], scopes: ['prompts.read'] }), /lacks|缺少/);
});

test('system MCP resource projection redacts private content, endpoints, headers and credentials', () => {
  const service = new SystemMcpService({}, {}, {}, {}, {}, {});
  assert.deepEqual(service.safeConfiguration({
    responsibility: 'safe metadata', endpoint: 'https://internal.example',
    nested: { template: 'prompt body', instructions: 'skill body', apiKey: 'secret', headers: { Authorization: 'Bearer x' }, toolVersionIds: [1] },
  }), {
    responsibility: 'safe metadata', endpoint: '[redacted]',
    nested: { template: '[redacted]', instructions: '[redacted]', apiKey: '[redacted]', headers: '[redacted]', toolVersionIds: [1] },
  });
});

test('scope edits enforce credential ownership and permissions in every bound workspace, then apply on the next authentication', async () => {
  const credential = { id: 7, adminId: 3, workspaceIds: ['12', '13'], scopes: ['agents.read'], revoked: false };
  const audits = [];
  const checkedWorkspaces = [];
  let permissions = ['agent_config.read'];
  let writeCount = 0;
  const db = { platformQuery: async (sql, values) => {
    if (sql.includes('FROM system_mcp_credentials WHERE')) {
      return { rows: values[1] === credential.adminId && !credential.revoked ? [structuredClone(credential)] : [] };
    }
    if (sql.includes('FROM workspaces w')) {
      checkedWorkspaces.push(values[1]);
      return { rows: [{ id: values[1], role: 'member', permission_codes: permissions }] };
    }
    if (sql.includes('SELECT code FROM permissions')) return { rows: permissions.map(code => ({ code })) };
    if (sql.includes('SET scopes=')) {
      writeCount++;
      credential.scopes = values[2];
      return { rowCount: 1, rows: [{ id: credential.id }] };
    }
    if (sql.includes('INSERT INTO audit_logs')) audits.push(JSON.parse(values[2]));
    if (sql.includes('FROM system_mcp_credentials c JOIN admins')) return { rows: [structuredClone(credential)] };
    return { rows: [], rowCount: 1 };
  }};
  const service = new SystemMcpService(db, {}, {}, {});
  await assert.rejects(service.updateCredentialScopes(9, 7, { scopes: ['agents.read'] }), /不存在或已撤销/);
  await assert.rejects(service.updateCredentialScopes(3, 7, { scopes: ['agents.manage'] }), /缺少/);
  assert.equal(writeCount, 0);
  permissions = ['agent_config.read', 'agent_config.manage'];
  checkedWorkspaces.length = 0;
  await service.updateCredentialScopes(3, 7, { scopes: ['agents.manage'] });
  assert.deepEqual(checkedWorkspaces, [12, 13]);
  assert.deepEqual(audits, [{ previousScopes: ['agents.read'], scopes: ['agents.manage'], previousWorkspaceIds: ['12', '13'], workspaceIds: [12, 13] }]);
  const authenticated = await service.authenticate('Bearer astm_existing-secret');
  assert.deepEqual(authenticated.scopes, ['agents.manage']);
  await assert.rejects(service.withScope(authenticated, 12, 'agents.read', async () => 'unreachable'), /does not grant/);
  credential.revoked = true;
  await assert.rejects(service.updateCredentialScopes(3, 7, { scopes: ['agents.read'] }), /不存在或已撤销/);
});

test('all-workspace and wildcard scopes remain dynamic and still require current workspace permissions', async () => {
  const writes = [];
  let permissions = ['agent_config.read'];
  const db = { platformQuery: async (sql, values) => {
    writes.push({ sql, values });
    if (sql.includes('SELECT w.id::int AS id FROM workspaces w')) return { rows: [{ id: 12 }, { id: 13 }] };
    if (sql.includes('FROM workspaces w')) return { rows: [{ id: Number(values[1]), role: 'member', permission_codes: permissions }] };
    if (sql.includes('SELECT code FROM permissions')) return { rows: [{ code: 'agent_config.read' }, { code: 'agent_config.manage' }] };
    if (sql.includes('INSERT INTO system_mcp_credentials')) return { rows: [{ id: 8 }] };
    return { rows: [], rowCount: 1 };
  }};
  const service = new SystemMcpService(db, {}, {}, {});
  const created = await service.createCredential(3, { name: 'All', workspaceIds: [0], scopes: ['*'] });
  const insert = writes.find(({ sql }) => sql.includes('INSERT INTO system_mcp_credentials'));
  assert.deepEqual(insert.values[3], [0]);
  assert.deepEqual(insert.values[4], ['*']);
  const credential = { adminId: 3, workspaceIds: [0], scopes: ['*'] };
  assert.equal(await service.withScope(credential, 13, 'agents.read', async () => 'allowed'), 'allowed');
  permissions = [];
  await assert.rejects(service.withScope(credential, 13, 'agents.read', async () => 'unreachable'), /permission was removed/);
  await assert.rejects(service.createCredential(3, { name: 'Invalid', workspaceIds: [0, 12], scopes: ['*'] }), /全部工作区/);
});

test('workspace list tool data is limited by credential scope and dynamically accessible memberships', async () => {
  const db = { platformQuery: async () => ({ rows: [{ id: 12, name: 'A' }, { id: 13, name: 'B' }] }) };
  const service = new SystemMcpService(db, {}, {}, {});
  assert.deepEqual(await service.listWorkspaces({ adminId: 3, workspaceIds: [12], scopes: ['workspaces.read'] }), [{ id: 12, name: 'A' }]);
  assert.deepEqual(await service.listWorkspaces({ adminId: 3, workspaceIds: [0], scopes: ['*'] }), [{ id: 12, name: 'A' }, { id: 13, name: 'B' }]);
  await assert.rejects(service.listWorkspaces({ adminId: 3, workspaceIds: [12], scopes: ['agents.read'] }), /workspaces.read/);
});

test('execution records use bounded pagination, allowlisted context, and recording policy hides conversation content', async () => {
  const sqlCalls = [];
  const db = {
    query: async (sql, values) => {
      sqlCalls.push({ sql, values });
      if (sql.includes('count(*)')) return { rows: [{ total: 21 }] };
      if (sql.includes('FROM chat_traces WHERE id=$1')) return { rows: [{ id: '00000000-0000-4000-8000-000000000001', conversationId: null, question: 'private', finalAnswer: 'private answer', status: 'failed', errorCode: 'answer_failed', contextSnapshot: { executionInput: { question: 'secret prompt' }, executionSteps: [{ name: 'safe', arguments: 'private args' }] } }] };
      return { rows: [] };
    },
    platformQuery: async () => ({ rows: [{ auditEnabled: true, conversationContentEnabled: false, traceEnabled: true, usageEnabled: true }] }),
  };
  const service = new SystemMcpService(db, {}, {}, {});
  const page = await service.executionList({ agentId: 4, conversationId: '00000000-0000-4000-8000-000000000002', status: 'failed', from: '2026-01-01T00:00:00.000Z', page: 2, pageSize: 5 });
  assert.equal(page.total, 21);
  assert.equal(page.page, 2);
  assert.equal(sqlCalls[0].values.at(-2), 5);
  assert.equal(sqlCalls[0].values.at(-1), 5);
  assert.match(sqlCalls[0].sql, /workspace_id = \$1/);
  assert.match(sqlCalls[0].sql, /conversation_id = \$3::uuid/);
  const detail = await service.executionDetail('00000000-0000-4000-8000-000000000001');
  assert.equal(detail.question, null);
  assert.equal(detail.finalAnswer, null);
  assert.equal(JSON.stringify(detail).includes('secret prompt'), false);
  assert.equal(JSON.stringify(detail).includes('private args'), false);
});

test('Agent profile reports missing associations without returning Prompt bodies or model credentials', async () => {
  const agent = {
    get: async () => ({ id: 9, key: 'assistant', name: 'Assistant', kind: 'agent', enabled: true, currentVersionId: 30,
      versions: [{ id: 30, version: 10, status: 'published', config: { promptVersionId: 4, modelPlanVersionId: 5, embeddingPlanVersionId: null, retrieval: { retrievalMode: 'fulltext', topK: 5 }, toolVersionIds: [11], skillVersionIds: [12], knowledgeBaseIds: [6], collaboration: null, executionLimits: { maxModelCalls: 20 }, businessPrompt: 'PRIVATE PROMPT' } }] }),
  };
  const db = { query: async (sql) => {
    if (sql.includes('FROM prompt_versions')) return { rows: [{ versionId: 4, version: 2, status: 'published', name: 'Prompt' }] };
    if (sql.includes('FROM model_plan_versions')) return { rows: [{ versionId: 5, version: 3, status: 'published', name: 'Model Plan' }] };
    if (sql.includes('FROM agent_resource_versions')) return { rows: [] };
    if (sql.includes('FROM knowledge_bases')) return { rows: [{ id: 6, name: 'KB', enabled: true, archived_at: null }] };
    return { rows: [] };
  }};
  const service = new SystemMcpService(db, agent, {}, {});
  const profile = await service.agentConfigurationProfile(9);
  assert.equal(profile.version.number, 10);
  assert.equal(profile.profile.prompt.status, 'ok');
  assert.equal(profile.profile.model.name, 'Model Plan');
  assert.deepEqual(profile.issues.map(issue => issue.status), ['missing', 'missing']);
  assert.equal(JSON.stringify(profile).includes('PRIVATE PROMPT'), false);
});

test('required security audit cannot be disabled through recording policy updates', async () => {
  const service = new SystemMcpService({ platformQuery: async () => { assert.fail('invalid policy must not be written'); } }, {}, {}, {});
  await assert.rejects(service.updateRecordingPolicy(3, { auditEnabled: false, traceEnabled: true, conversationContentEnabled: false, usageEnabled: true }), /安全审计记录为平台强制保留项/);
});

test('recording policy disables diagnostic traces and strips trace content and token counters without affecting core writes', async () => {
  const writes = [];
  const instance = Object.create(ConversationService.prototype);
  instance.database = { query: async (sql, values) => { writes.push({ sql, values }); } };
  instance.recordingPolicy = { current: async () => ({ traceEnabled: false }) };
  await instance.recordTrace({ id: 'trace', conversationId: 'conversation', userMessageId: null, question: 'private question', contextSnapshot: {}, model: null, rawModelOutput: null, finalAnswer: null, refused: null, status: 'failed', errorCode: 'answer_failed', inputTokens: 1, outputTokens: 2, totalTokens: 3, durationMs: 4 });
  assert.equal(writes.length, 0);
  instance.recordingPolicy = { current: async () => ({ traceEnabled: true, conversationContentEnabled: false, usageEnabled: false }) };
  await instance.recordTrace({ id: 'trace', conversationId: 'conversation', userMessageId: null, question: 'private question', contextSnapshot: {}, model: null, rawModelOutput: 'private output', finalAnswer: 'private answer', refused: null, status: 'failed', errorCode: 'answer_failed', inputTokens: 1, outputTokens: 2, totalTokens: 3, durationMs: 4 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].values[3], '');
  assert.equal(writes[0].values[6], null);
  assert.equal(writes[0].values[7], null);
  assert.deepEqual(writes[0].values.slice(11, 14), [null, null, null]);
});
