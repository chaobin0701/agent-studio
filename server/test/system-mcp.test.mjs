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
  assert.deepEqual(audits, [{ previousScopes: ['agents.read'], scopes: ['agents.manage'] }]);
  const authenticated = await service.authenticate('Bearer astm_existing-secret');
  assert.deepEqual(authenticated.scopes, ['agents.manage']);
  await assert.rejects(service.withScope(authenticated, 12, 'agents.read', async () => 'unreachable'), /does not grant/);
  credential.revoked = true;
  await assert.rejects(service.updateCredentialScopes(3, 7, { scopes: ['agents.read'] }), /不存在或已撤销/);
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
