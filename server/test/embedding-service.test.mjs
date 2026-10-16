import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EmbeddingService, EMBEDDING_DIMENSIONS } = require('../dist/documents/embedding.service.js');

test('embedding service refuses to run without a configured key', async () => {
  const oldKey = process.env.EMBEDDING_API_KEY;
  try {
    delete process.env.EMBEDDING_API_KEY;
    const service = new EmbeddingService();
    assert.equal(service.enabled, false);
    await assert.rejects(service.embed(['question']), /not configured/);
  } finally {
    if (oldKey === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = oldKey;
  }
});

test('embedding service sends each text separately to the multimodal endpoint', async () => {
  const received = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/api/v3/embeddings/multimodal');
    assert.equal(request.headers.authorization, 'Bearer test-only-key');
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: { embedding: Array(EMBEDDING_DIMENSIONS).fill(received.length / 10) } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const oldKey = process.env.EMBEDDING_API_KEY;
  const oldUrl = process.env.EMBEDDING_BASE_URL;
  try {
    process.env.EMBEDDING_API_KEY = 'test-only-key';
    process.env.EMBEDDING_BASE_URL = `http://127.0.0.1:${server.address().port}/api/v3`;
    const embeddings = await new EmbeddingService().embed(['one', 'two']);
    assert.deepEqual(received.map((item) => item.input), [
      [{ type: 'text', text: 'one' }],
      [{ type: 'text', text: 'two' }],
    ]);
    assert.equal(received[0].model, 'doubao-embedding-vision-251215');
    assert.equal(received[0].encoding_format, 'float');
    assert.deepEqual(embeddings.map((vector) => vector[0]), [0.1, 0.2]);
  } finally {
    if (oldKey === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = oldKey;
    if (oldUrl === undefined) delete process.env.EMBEDDING_BASE_URL;
    else process.env.EMBEDDING_BASE_URL = oldUrl;
    server.close();
  }
});

test('embedding service rejects malformed vectors', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const oldKey = process.env.EMBEDDING_API_KEY;
  const oldUrl = process.env.EMBEDDING_BASE_URL;
  try {
    process.env.EMBEDDING_API_KEY = 'test-only-key';
    process.env.EMBEDDING_BASE_URL = `http://127.0.0.1:${server.address().port}/api/v3`;
    await assert.rejects(new EmbeddingService().embed(['question']), /invalid vector/);
  } finally {
    if (oldKey === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = oldKey;
    if (oldUrl === undefined) delete process.env.EMBEDDING_BASE_URL;
    else process.env.EMBEDDING_BASE_URL = oldUrl;
    server.close();
  }
});
