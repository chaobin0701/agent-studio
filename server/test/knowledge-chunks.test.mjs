import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChunks, searchTokens } from '../dist/documents/build-chunks.js';
import { knowledgeConfigSchema } from '../dist/documents/knowledge-config.js';
import { parseDocument } from '../dist/documents/extract-document.js';

test('structured Markdown retains unsplit content and source locations', async () => {
  const text = '😀'.repeat(1000);
  const parsed = await parseDocument(Buffer.from(`# 产品\n\n${text}`), 'sample.md');
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].content, text);
  assert.deepEqual(parsed.blocks[0].sourceLocator, { type: 'markdown_lines', start: 3, end: 3 });
  const chunks = buildChunks(parsed.blocks, knowledgeConfigSchema.parse({ chunkChars: 200, overlapChars: 20 }));
  assert.ok(chunks.every((c) => Array.from(c.content).length <= 200));
  assert.ok(chunks.every((c) => !c.content.includes('\uFFFD')));
  assert.equal(parsed.blocks[0].content, text);
});

test('document parsing applies the knowledge-base chunk size and overlap settings', async () => {
  const parsed = await parseDocument(Buffer.from(`# A\n\n${'甲'.repeat(450)}`), 'configured.md', 200, 20);
  assert.ok(parsed.chunks.every((chunk) => Array.from(chunk.content).length <= 200));
  assert.equal(Array.from(parsed.chunks[0].content).length, 200);
  assert.equal(parsed.chunks[1].content.slice(0, 20), parsed.chunks[0].content.slice(-20));
  await assert.rejects(() => parseDocument(Buffer.from('# A\n\ntext'), 'configured.md', 200, 200));
});

test('parent child chunks keep bounded parent evidence and explicit relationships', async () => {
  const parsed = await parseDocument(Buffer.from(`# A\n\n${'甲'.repeat(2000)}\n\n# B\n\n独立章节`), 'sample.md');
  const chunks = buildChunks(parsed.blocks, knowledgeConfigSchema.parse({ chunkMode: 'parent_child', parentChars: 600, childChars: 200 }));
  const parents = chunks.filter((c) => c.kind === 'parent');
  assert.ok(parents.every((c) => Array.from(c.content).length <= 600));
  for (const child of chunks.filter((c) => c.kind === 'child')) {
    const parent = parents.find((p) => p.ordinal === child.parentOrdinal);
    assert.ok(parent.content.includes(child.content));
    assert.equal(parent.headingPath, child.headingPath);
  }
});

test('configuration rejects invalid overlaps and economy vector requests', () => {
  for (const input of [{ chunkChars: 200, overlapChars: 200 }, { indexMode: 'economy', retrievalMode: 'vector' },
    { indexMode: 'high_quality' }, { childChars: 100, childOverlapChars: 100 }, { unknown: true }]) {
    assert.equal(knowledgeConfigSchema.safeParse(input).success, false);
  }
  assert.equal(searchTokens('如何申请退货').replaceAll(' ', ''), '如何申请退货');
  assert.ok(searchTokens('如何申请退货').includes(' '));
});

test('general overlap crosses paragraph boundaries but never crosses sections',async()=>{
  const parsed=await parseDocument(Buffer.from(`# A\n\n${'甲'.repeat(180)}\n\n${'乙'.repeat(180)}\n\n# B\n\n丙`),'sample.md');
  const chunks=buildChunks(parsed.blocks,knowledgeConfigSchema.parse({chunkChars:200,overlapChars:20}));
  assert.ok(chunks[1].content.startsWith('甲'));
  assert.ok(chunks[1].content.includes('乙'));
  assert.equal(chunks.at(-1).content,'丙');
  assert.ok(chunks.every(chunk=>Array.from(chunk.content).length<=200));
});
