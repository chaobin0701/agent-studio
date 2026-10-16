import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseMarkdownDocument } = require('../dist/documents/extract-markdown.js');

test('groups paragraphs by heading and keeps source lines', () => {
  const parsed = parseMarkdownDocument('# 配送\n\n## 发货时间\n\n付款后一个工作日内发货。\n\n物流信息可能稍后更新。\n\n## 运费\n\n满 99 元免基础运费。\n');
  assert.equal(parsed.chunks.length, 2);
  assert.equal(parsed.chunks[0].headingPath, '配送 > 发货时间');
  assert.deepEqual([parsed.chunks[0].sourceStartLine, parsed.chunks[0].sourceEndLine], [5, 7]);
  assert.match(parsed.chunks[0].content, /物流信息/);
  assert.equal(parsed.chunks[1].headingPath, '配送 > 运费');
});

test('splits an oversized paragraph without exceeding the limit', () => {
  const parsed = parseMarkdownDocument('# 售后\n\n' + '这是一段较长的保修政策。'.repeat(100), 300);
  assert.ok(parsed.chunks.length > 1);
  assert.ok(parsed.chunks.every((chunk) => Array.from(chunk.content).length <= 300));
  assert.deepEqual(parsed.chunks.map((chunk) => chunk.ordinal), parsed.chunks.map((_, i) => i + 1));
});

test('does not turn an empty section into a chunk', () => {
  const parsed = parseMarkdownDocument('# 标题\n\n## 空小节\n\n## 有内容\n\n答案。\n');
  assert.equal(parsed.chunks.length, 1);
  assert.equal(parsed.chunks[0].headingPath, '标题 > 有内容');
});
