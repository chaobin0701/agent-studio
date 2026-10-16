import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeModelBaseUrl } from '../dist/config/model-base-url.js';
import { ModelManagementService } from '../dist/model-management/model-management.service.js';
import { embeddingProfileSchema, embedWithProfile } from '../dist/documents/profile-embedding.js';

const targets = [
  'https://proxy.example.invalid/custom/api',
  'http://localhost:11434/v1',
  'http://127.0.0.1:9000/openai/v1',
  'http://192.168.10.20:8000/v1',
  'http://[::1]:11434/v1',
];

test('model base URLs accept HTTP/HTTPS proxies, custom paths, ports and local endpoints without a whitelist', () => {
  for (const target of targets) assert.equal(normalizeModelBaseUrl(`  ${target}///  `), target);
  assert.equal(normalizeModelBaseUrl('https://API.EXAMPLE.invalid:443/'), 'https://api.example.invalid');
});

test('invalid protocols, malformed URLs and embedded credentials cannot be used as API bases', () => {
  for (const target of ['', '/v1', 'api.example.invalid/v1', 'file:///tmp/model', 'ftp://model.invalid',
    'javascript:alert(1)', 'https://user:password@model.invalid', 'https://model.invalid?api_key=secret', 'https://model.invalid#v1']) {
    assert.throws(() => normalizeModelBaseUrl(target));
  }
});

function fixture() {
  const writes = [];
  const database = { transaction: async action => action({ query: async (sql, values) => {
    if (sql.startsWith('INSERT INTO model_accounts')) { writes.push(values); return { rows: [{ id: 42 }] }; }
    return { rows: [] };
  } }) };
  const service = new ModelManagementService(database, {}, { encrypt: value => `encrypted:${value}` });
  return { service, writes };
}

test('LLM and embedding supplier creation uses the supplied URL even on preset platforms, without runtime allowlist configuration', async () => {
  for (const kind of ['llm', 'embedding']) {
    for (const platformKey of ['openai', 'volcengine', 'custom']) {
      for (const baseUrl of targets) {
        const f = fixture();
        assert.equal((await f.service.createAccount(1, kind, { name: 'Custom endpoint', platformKey, baseUrl: ` ${baseUrl}/ `, apiKey: 'own-key' })).id, 42);
        assert.equal(f.writes.length, 1);
        assert.equal(f.writes[0][3], baseUrl);
        assert.equal(f.writes[0][4], 'encrypted:own-key');
      }
    }
  }
});

test('invalid supplier endpoints fail before any database write', async () => {
  for (const kind of ['llm', 'embedding']) {
    const f = fixture();
    for (const baseUrl of ['not a URL', 'ftp://model.invalid', 'https://user:password@model.invalid', 'https://model.invalid?q=x']) {
      await assert.rejects(f.service.createAccount(1, kind, { name: 'Invalid', platformKey: 'custom', baseUrl, apiKey: 'own-key' }), error => error.getStatus() === 400);
    }
    assert.equal(f.writes.length, 0);
  }
});

test('managed embedding calls can actually use unlisted proxy and local HTTP endpoints, not just save them', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer own-key');
    assert.equal(options.redirect, 'error');
    return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
  });
  for (const baseUrl of targets) {
    const profile = embeddingProfileSchema.parse({ provider: 'openai-compatible', baseUrl, model: 'vectors', dimensions: 2 });
    assert.deepEqual(await embedWithProfile(profile, ['text'], { embedding: {} }, { apiKey: 'own-key' }), [[1, 0]]);
    assert.equal(calls.at(-1), `${baseUrl}/embeddings`);
  }
});
