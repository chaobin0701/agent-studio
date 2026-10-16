import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fuseSearchResults } = require('../dist/documents/fuse-search-results.js');

const hit = (chunkId, documentId = 1, ordinal = chunkId) => ({
  chunkId, documentId, ordinal, documentTitle: '测试', originalFilename: 'test.md',
  headingPath: '标题', content: '内容', sourceStartLine: 1, sourceEndLine: 2, score: 0.5,
});

test('fusion rewards agreement across lexical and vector rankings', () => {
  const fused = fuseSearchResults([hit(1), hit(2)], [hit(2), hit(3)], 3);
  assert.deepEqual(fused.map((item) => item.chunkId), [2, 1, 3]);
  assert.deepEqual([fused[0].lexicalRank, fused[0].vectorRank], [2, 1]);
  assert.equal(new Set(fused.map((item) => item.chunkId)).size, 3);
});

test('fusion remains useful without vector results', () => {
  const fused = fuseSearchResults([hit(1), hit(2)], [], 1);
  assert.equal(fused.length, 1);
  assert.equal(fused[0].chunkId, 1);
  assert.equal(fused[0].vectorRank, null);
});
