import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentController } from '../dist/documents/document.controller.js';
import { KnowledgeBaseController } from '../dist/documents/knowledge-base.controller.js';
import { DocumentService } from '../dist/documents/document.service.js';
import { PERMISSION_KEY } from '../dist/admin/permission.decorator.js';

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'grounded-upload-encoding-'));
  const saved = [], audit = [], queued = [];
  const database = { transaction: work => work({ query: async (sql, values) => {
    if (sql.startsWith('SELECT id,draft_config,index_epoch FROM knowledge_bases')) return { rows: [{ id: '5', draft_config: {} }] };
    if (sql.startsWith('INSERT INTO documents')) {
      const id = saved.length + 1;
      saved.push({ id, title: values[0], originalFilename: values[1], storageKey: values[2], sha256: values[3], size: values[4], status: values[7] });
      return { rows: [{ id, created_at: new Date() }] };
    }
    if (sql.includes('INSERT INTO audit_logs')) { audit.push(JSON.parse(values[2])); return { rows: [] }; }
    throw new Error('Unexpected query');
  } }) };
  const documents = new DocumentService(database, { enqueue: async (_client, id) => queued.push(id) }, { uploadRoot: root });
  const app = express();
  for (const [path, controller] of [['/legacy', DocumentController], ['/knowledge', KnowledgeBaseController]]) {
    // Test the actual interceptor registered by each production controller.
    const [Interceptor] = Reflect.getMetadata('__interceptors__', controller.prototype.upload);
    const interceptor = new Interceptor();
    app.post(path, async (request, response) => {
      try {
        const ctx = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) };
        const result = await interceptor.intercept(ctx, { handle: () => documents.upload(1, request.file, request.body.title, 5, undefined, request.body.deferProcessing === 'true') });
        response.status(202).json(result);
      } catch (error) { response.status(error.getStatus?.() ?? 500).json({ message: error.message }); }
    });
  }
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const upload = (path, name, field, content = '# 标题\n\n中文正文，内容不能因文件名编码而改变。') => {
    const form = new FormData(); form.append('file', new Blob([content]), name);
    if (field) form.append(...field);
    return fetch(url + path, { method: 'POST', body: form });
  };
  return { upload, saved, audit, queued, root, url };
}

test('both upload endpoints persist UTF-8 names, titles, audit fields and unchanged original bytes', async t => {
  const h = await harness(t);
  const content = '# 测试资料\n\n支持中文、é 和 emoji 🔥，原文保持 UTF-8。';
  for (const path of ['/legacy', '/knowledge']) {
    for (const name of ['服务支持与常见问题.md', '产品选购与规格说明.md', '关于我们.md', '品牌历史.md', '品牌介绍.md', 'café–résumé.md', '产品🔥.md', 'Cafe\u0301.md', 'readme.md']) {
      const response = await h.upload(path, name, ['deferProcessing', 'true'], content);
      assert.equal(response.status, 202);
      const result = await response.json();
      assert.equal(result.originalFilename, name.normalize('NFC'));
      assert.equal(result.title, name.normalize('NFC').replace(/\.md$/u, ''));
      assert.equal(result.status, 'pending');
      const stored = h.saved.at(-1);
      const bytes = await readFile(join(h.root, 'documents', stored.storageKey));
      assert.deepEqual(bytes, Buffer.from(content));
      assert.equal(stored.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(h.audit.at(-1).filename, name.normalize('NFC'));
    }
  }
  assert.deepEqual(h.queued, [], 'deferred upload must not start processing');
});

test('batch selection keeps each name associated with its own bytes, including duplicate filenames', async t => {
  const h = await harness(t);
  const names = ['品牌介绍.md', '品牌历史.md', '关于我们.md', '产品选购与规格说明.md', '服务支持与常见问题.md', '品牌介绍.md'];
  const results = await Promise.all(names.map(async (name, index) => {
    const content = `# ${name}\n\n批次中的独立内容 ${index}`;
    const response = await h.upload('/knowledge', name, ['deferProcessing', 'true'], content);
    assert.equal(response.status, 202);
    const result = await response.json();
    const stored = h.saved.find(item => item.id === result.id);
    assert.equal(result.originalFilename, name);
    assert.equal((await readFile(join(h.root, 'documents', stored.storageKey))).toString('utf8'), content);
    return result;
  }));
  assert.equal(new Set(results.map(item => item.id)).size, names.length);
  assert.equal(new Set(h.saved.map(item => item.storageKey)).size, names.length);
});

test('explicit Unicode titles stay unchanged and default uploads still enqueue parsing', async t => {
  const h = await harness(t);
  const response = await h.upload('/legacy', '售后政策.md', ['title', '独立标题 · 服务条款']);
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.title, '独立标题 · 服务条款');
  assert.equal(result.originalFilename, '售后政策.md');
  assert.equal(result.status, 'queued');
  assert.deepEqual(h.queued, [result.id]);
});

test('UTF-8 configuration retains upload permissions, file type and size/part limits', async t => {
  const h = await harness(t);
  for (const controller of [DocumentController, KnowledgeBaseController]) {
    assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, controller.prototype.upload), ['documents.upload']);
  }
  assert.equal((await h.upload('/legacy', '非法类型.exe')).status, 400);
  assert.equal((await h.upload('/knowledge', '超大文档.md', undefined, 'x'.repeat(2 * 1024 * 1024 + 1))).status, 413);
  for (const path of ['/legacy', '/knowledge']) {
    const form = new FormData();
    form.append('file', new Blob(['正文']), '第一份.md');
    form.append('file', new Blob(['正文']), '第二份.md');
    const response = await fetch(h.url + path, { method: 'POST', body: form });
    assert.ok([400, 413].includes(response.status), 'multiple file parts must still be rejected');
  }
  assert.equal(h.saved.length, 0);
});
