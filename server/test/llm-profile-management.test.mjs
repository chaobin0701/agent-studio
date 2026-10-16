import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import { LlmProfileService } from '../dist/ai/providers/llm-profile.service.js';
import { LlmProfileController } from '../dist/ai/providers/llm-profile.controller.js';
import { ProviderAuthenticationError, ProviderTimeoutError } from '../dist/ai/providers/provider-errors.js';
import { PERMISSION_KEY } from '../dist/admin/permission.decorator.js';

const baseUrl = 'https://ark.cn-beijing.volces.com/api/v3';
const row = (id, extra = {}) => ({ id, name: `profile ${id}`, platform_key: 'volcengine', base_url: baseUrl, model: 'test-model', api_key_ciphertext: 'ciphertext', timeout_ms: 20000, context_window_tokens: 32000, max_output_tokens: 1200, enabled: true, is_default: false, supports_tool_calls: true, supports_streaming: true, ...extra });
const input = { name: 'unsaved configuration', platformKey: 'volcengine', baseUrl, model: 'unsaved-model', timeoutMs: 45000, contextWindowTokens: 64000, maxOutputTokens: 2048 };

function fixture(rows, options = {}) {
  const calls = []; const activated = []; const sent = []; const decrypted = []; const encrypted = [];
  let state = structuredClone(rows);
  const query = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('SELECT id::int')) return { rows: sql.includes('WHERE id = $1') ? state.filter(item => item.id === values[0]) : state };
    if (sql.startsWith('INSERT INTO llm_profiles')) {
      const item = row(Math.max(0, ...state.map(item => item.id)) + 1, {
        name: values[0], platform_key: values[1], base_url: values[2], model: values[3], api_key_ciphertext: values[4],
        timeout_ms: values[5], context_window_tokens: values[6], max_output_tokens: values[7],
        supports_tool_calls: values[9], supports_streaming: values[10],
      });
      state.push(item); return { rows: [item] };
    }
    if (sql.startsWith('DELETE FROM llm_profiles')) { state = state.filter(item => item.id !== values[0]); return { rows: [] }; }
    if (sql.startsWith('UPDATE llm_profiles SET is_default')) {
      state.forEach(item => { if (sql.includes('WHERE is_default') ? item.is_default : item.id === values[0]) item.is_default = sql.startsWith('UPDATE llm_profiles SET is_default = TRUE'); });
      return { rows: state.filter(item => item.id === values[0]) };
    }
    if (sql.startsWith('UPDATE llm_profiles SET enabled')) { const item = state.find(item => item.id === values[0]); item.enabled = values[1]; return { rows: [item] }; }
    if (sql.startsWith('UPDATE llm_profiles SET')) {
      const item = state.find(item => item.id === values[0]);
      if (item) for (const [,column,parameter] of sql.matchAll(/(\w+) = \$(\d+)/g)) {
        if (column !== 'id') item[column] = values[Number(parameter) - 1];
      }
      return { rows: item ? [item] : [] };
    }
    return { rows: [] };
  };
  const database = { query, transaction: async action => { const backup = structuredClone(state); try { return await action({ query }); } catch (error) { state = backup; throw error; } } };
  const config = { llm: { baseUrl, allowedBaseUrls: options.allowedBaseUrls ?? [baseUrl], apiKey: options.environmentKey } };
  const secrets = { encrypt: value => { encrypted.push(value); return `encrypted:${value}`; }, decrypt: value => { decrypted.push(value); return value.startsWith('encrypted:') ? value.slice('encrypted:'.length) : options.savedKey ?? '12-secret-api-key-89'; } };
  const registry = { activateProfile: value => activated.push(value), createFromProfile: profile => { sent.push(profile); return { chat: async request => { sent.push(request); if (options.providerError) throw options.providerError; return { content: options.content ?? (request.toolChoice ? '{}' : '{"message":"连接成功"}'), toolCalls: request.toolChoice ? options.toolCalls ?? [{ id: 'probe-1', name: 'connection_probe', arguments: { probe: 'connection-test' } }] : [], model: profile.model, durationMs: 45 }; } }; } };
  return { service: new LlmProfileService(database, config, secrets, registry), calls, activated, sent, decrypted, encrypted, state: () => state };
}

test('profile views include only masked key preview, never secrets or ciphertext', async () => {
  const f = fixture([row(1)]); const [view] = await f.service.list();
  assert.equal(view.apiKeyPreview, '12***89'); assert.equal(view.hasApiKey, true);
  assert.ok(!JSON.stringify(view).includes('secret-api-key')); assert.ok(!JSON.stringify(view).includes('ciphertext'));
  assert.ok(!('apiKey' in view));
});
test('short keys are fully masked; environment keys and missing keys have safe previews', async () => {
  assert.equal((await fixture([row(1)], { savedKey: 'abc' }).service.list())[0].apiKeyPreview, '********');
  assert.equal((await fixture([row(1, { api_key_ciphertext: null })], { environmentKey: 'ab-env-key-yz' }).service.list())[0].apiKeyPreview, 'ab***yz');
  assert.equal((await fixture([row(1, { api_key_ciphertext: null })]).service.list())[0].apiKeyPreview, null);
});
test('connection test uses unsaved form values without creating or activating a profile', async () => {
  const f = fixture([]); const result = await f.service.testConnection({ ...input, apiKey: 'new-api-key' });
  assert.equal(result.ok, true); assert.equal(result.model, 'unsaved-model'); assert.equal(result.responsePreview, '连接成功');
  assert.equal(f.sent[0].apiKey, 'new-api-key'); assert.equal(f.sent[0].timeoutMs, 45000);
  assert.equal(f.sent[1].maxTokens, 64); assert.equal(f.calls.length, 0); assert.equal(f.activated.length, 0);
  assert.deepEqual(result.capabilities, { nativeTools: true, structuredOutput: true });
  assert.equal(f.sent.length, 3); assert.equal(f.sent[1].responseFormat.type, 'json_schema');
  assert.deepEqual(f.sent[2].toolChoice, { name: 'connection_probe' });
  assert.equal(f.sent[2].responseFormat.type, 'json_schema');
});
test('connection capabilities reject text-only endpoints, legacy calls and malformed native arguments without activating anything', async () => {
  for (const options of [{ content: '连接成功' }, { content: '{"message":"错误内容"}' }, { toolCalls: [] }, { toolCalls: [{ id: '1', name: 'connection_probe', arguments: { probe: 'wrong' } }] }]) {
    const f = fixture([], options);
    await assert.rejects(f.service.testConnection({ ...input, apiKey: 'test-key' }), error => error.getStatus() === 400);
    assert.equal(f.calls.length, 0); assert.equal(f.activated.length, 0);
  }
  const f = fixture([row(1, { supports_tool_calls: false })]);
  await assert.rejects(f.service.activate(1, 1), /原生工具调用/);
  assert.equal(f.activated.length, 0);
});
test('editing with blank key reuses saved credentials but sends the edited model', async () => {
  const f = fixture([row(1)]); await f.service.testConnection({ ...input, profileId: 1 });
  assert.equal(f.sent[0].apiKey, '12-secret-api-key-89'); assert.equal(f.sent[0].model, 'unsaved-model');
  assert.ok(f.calls.every(call => call.sql.startsWith('SELECT')));
});
test('test rejects non-HTTP URL and unknown profile before contacting provider', async () => {
  const f = fixture([]);
  await assert.rejects(f.service.testConnection({ ...input, baseUrl: 'ftp://internal.example', apiKey: 'key' }), error => error.getStatus() === 400);
  await assert.rejects(f.service.testConnection({ ...input, profileId: 99 }), error => error.getStatus() === 404);
  assert.equal(f.sent.length, 0);
});
test('platform presets and deployment allowlists do not restrict explicitly configured model endpoints', async () => {
  for (const target of ['https://proxy.example.invalid/custom/v2', 'http://127.0.0.1:11434/v1']) {
    const f = fixture([]);
    const result = await f.service.testConnection({ ...input, platformKey: 'openai', baseUrl: target, apiKey: 'own-key' });
    assert.equal(result.ok, true);
    assert.equal(f.sent[0].baseUrl, target);
    assert.equal(f.sent[0].apiKey, 'own-key');
  }
});
test('custom endpoints never borrow environment credentials, including edits to saved environment profiles', async () => {
  for (const profileId of [undefined, 1]) {
    const f = fixture([row(1, { api_key_ciphertext: null })], { environmentKey: 'environment-only-key' });
    await assert.rejects(f.service.testConnection({ ...input, profileId, baseUrl: 'http://localhost:11434/v1' }), /不能借用环境密钥/);
    assert.equal(f.sent.length, 0);
    await assert.rejects(f.service.create(1, { ...input, baseUrl: 'https://proxy.example.invalid/v1' }), /不能借用环境密钥/);
    assert.equal(f.calls.filter(c => c.sql.startsWith('INSERT')).length, 0);
  }
  const f = fixture([], { environmentKey: 'environment-only-key' });
  assert.equal((await f.service.testConnection(input)).ok, true);
  assert.equal(f.sent[0].apiKey, 'environment-only-key');
});
test('empty outputs and provider errors become actionable safe test failures', async () => {
  await assert.rejects(fixture([], { content: '  ' }).service.testConnection({ ...input, apiKey: 'key' }), /返回为空/);
  await assert.rejects(fixture([], { providerError: new ProviderAuthenticationError() }).service.testConnection({ ...input, apiKey: 'key' }), /密钥无效/);
  await assert.rejects(fixture([], { providerError: new ProviderTimeoutError() }).service.testConnection({ ...input, apiKey: 'key' }), /连接超时/);
});
test('deleting an unused profile writes audit in the transaction', async () => {
  const f = fixture([row(1), row(2, { is_default: true })]);
  assert.deepEqual(await f.service.remove(7, 1), { deleted: true, activeProfileId: null });
  assert.deepEqual(f.state().map(item => item.id), [2]); assert.equal(f.activated.length, 0);
  const audit = f.calls.find(call => call.sql.includes('llm_profile.deleted')); assert.ok(audit); assert.equal(audit.values[0], 7);
  assert.ok(!JSON.stringify(audit).includes('secret-api-key'));
});
test('current profile deletion requires a distinct enabled replacement; invalid choices do not delete', async () => {
  const f = fixture([row(1, { is_default: true }), row(2, { enabled: false })]);
  for (const payload of [{}, { replacementId: 1 }, { replacementId: 99 }, { replacementId: 2 }]) await assert.rejects(f.service.remove(7, 1, payload));
  assert.equal(f.state().length, 2); assert.equal(f.state()[0].is_default, true);
  assert.ok(!f.calls.some(call => call.sql.startsWith('DELETE')));
});
test('current profile switches to enabled replacement and deletes atomically', async () => {
  const f = fixture([row(1, { is_default: true }), row(2)]);
  assert.deepEqual(await f.service.remove(7, 1, { replacementId: 2 }), { deleted: true, activeProfileId: 2 });
  assert.equal(f.state().length, 1); assert.equal(f.state()[0].is_default, true); assert.equal(f.activated[0].id, 2);
  assert.ok(f.calls[0].sql.includes('LOCK TABLE'));
});
test('unknown/invalid deletions are rejected and active configuration cannot be disabled', async () => {
  const f = fixture([row(1, { is_default: true })]);
  await assert.rejects(f.service.remove(7, 99), error => error.getStatus() === 404);
  await assert.rejects(f.service.remove(7, 1, { replacementId: '2' }), error => error.getStatus() === 400);
  await assert.rejects(f.service.setEnabled(7, 1, false), /请先切换/);
});
test('updating current profile refreshes runtime, using database is_default field', async () => {
  const f = fixture([row(1, { is_default: true })]);
  await f.service.update(7, 1, { name: 'updated' });
  assert.equal(f.activated[0].name, 'updated');
});
test('created platform is immutable for current, inactive and disabled configurations', async () => {
  const platforms = { volcengine: baseUrl, openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com/v1', custom: 'https://compatible.example/v1' };
  for (const [savedPlatform, savedUrl] of Object.entries(platforms)) {
    for (const [nextPlatform, nextUrl] of Object.entries(platforms)) {
      if (savedPlatform === nextPlatform) continue;
      for (const flags of [{is_default: true}, {is_default: false}, {enabled: false}]) {
        const f = fixture([row(1, {...flags, platform_key: savedPlatform, base_url: savedUrl})], {allowedBaseUrls: Object.values(platforms)});
        await assert.rejects(f.service.update(7, 1, {platformKey: nextPlatform, baseUrl: nextUrl, apiKey: 'new-key'}), error => error.getStatus() === 400 && error.message.includes('不可修改平台'));
        assert.equal(f.state()[0].platform_key, savedPlatform);
        assert.ok(f.calls.every(call => call.sql.startsWith('SELECT')));
        assert.equal(f.encrypted.length, 0); assert.equal(f.decrypted.length, 0); assert.equal(f.activated.length, 0);
      }
    }
  }
});
test('same-platform edits and omitted platform keys remain supported without writing platform_key', async () => {
  const f = fixture([row(1, {is_default: true})]);
  await f.service.update(7, 1, {platformKey: 'volcengine', model: 'new-model', timeoutMs: 45000, apiKey: 'new-own-key'});
  assert.equal(f.state()[0].platform_key, 'volcengine'); assert.equal(f.state()[0].model, 'new-model');
  assert.equal(f.activated[0].apiKey, 'new-own-key');
  assert.ok(!f.calls.some(call => /UPDATE llm_profiles SET .*platform_key\s*=/.test(call.sql)));
  const fields = JSON.parse(f.calls.find(call => call.sql.includes('llm_profile.updated')).values[2]).fields;
  assert.ok(!fields.includes('platformKey'));
  await f.service.update(7, 1, {name: 'renamed'});
  assert.equal(f.state()[0].name, 'renamed'); assert.equal(f.state()[0].platform_key, 'volcengine');
});
test('partial edits do not apply creation defaults, and empty updates are rejected', async () => {
  const f = fixture([row(1, {timeout_ms: 60000, context_window_tokens: 128000, max_output_tokens: 8192, supports_tool_calls: false, supports_streaming: false})]);
  await f.service.update(7, 1, {name: 'name-only'});
  const saved = f.state()[0];
  assert.equal(saved.platform_key, 'volcengine'); assert.equal(saved.timeout_ms, 60000);
  assert.equal(saved.context_window_tokens, 128000); assert.equal(saved.max_output_tokens, 8192);
  assert.equal(saved.supports_tool_calls, false); assert.equal(saved.supports_streaming, false);
  const writes = f.calls.filter(call => call.sql.startsWith('UPDATE llm_profiles'));
  assert.equal(writes.length, 1); assert.ok(!writes[0].sql.includes('timeout_ms ='));
  for (const input of [{}, {platformKey: 'unsupported'}, {extra: 'unsupported'}]) {
    await assert.rejects(f.service.update(7, 1, input), error => error.getStatus() === 400);
  }
});
test('editing connection tests cannot borrow an existing key for another platform', async () => {
  for (const apiKey of [undefined, 'explicit-test-key']) {
    const f = fixture([row(1)], {allowedBaseUrls: [baseUrl, 'https://api.deepseek.com/v1']});
    await assert.rejects(f.service.testConnection({...input, profileId: 1, platformKey: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey}), /不可修改平台/);
    assert.equal(f.sent.length, 0); assert.equal(f.decrypted.length, 0); assert.equal(f.activated.length, 0);
  }
});
test('new-platform replacement is a distinct record; activation keeps the original unchanged', async () => {
  const f = fixture([row(1, {is_default: true})], {allowedBaseUrls: [baseUrl, 'https://api.deepseek.com/v1']});
  const created = await f.service.create(7, {...input, platformKey: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'deepseek-own-key'});
  assert.equal(created.platformKey, 'deepseek'); assert.equal(created.isDefault, false);
  assert.equal(f.state()[0].is_default, true);
  await f.service.activate(7, created.id);
  assert.equal(f.state().length, 2); assert.equal(f.state()[0].platform_key, 'volcengine');
  assert.equal(f.state()[0].is_default, false); assert.equal(f.state()[1].is_default, true);
  assert.equal(f.activated[0].apiKey, 'deepseek-own-key');
  assert.ok(!f.calls.some(call => call.sql.startsWith('DELETE')));
  assert.ok(!JSON.stringify(f.calls.filter(call => call.sql.includes('audit_logs'))).includes('deepseek-own-key'));
});
test('test and delete endpoints retain model management permission', () => {
  for (const method of ['testConnection', 'test', 'remove', 'update']) assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, LlmProfileController.prototype[method]), ['model_profiles.manage']);
});
