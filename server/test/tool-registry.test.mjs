import assert from 'node:assert/strict';
import test from 'node:test';
import { DuplicateToolError, UnknownToolError } from '../dist/ai/tools/tool-errors.js';
import { ToolRegistry } from '../dist/ai/tools/tool-registry.js';

const tool = (name) => ({
  name,
  description: name,
  inputSchema: { safeParse: (value) => ({ success: true, data: value }) },
  execute: async () => ({ success: true, content: 'ok' }),
});

test('registry registers, lists and resolves tools', () => {
  const registry = new ToolRegistry();
  const first = tool('first');
  registry.register(first);
  assert.equal(registry.has('first'), true);
  assert.deepEqual(registry.list(), [first]);
  assert.equal(registry.get('first'), first);
  assert.throws(() => registry.register(first), DuplicateToolError);
  assert.throws(() => registry.get('missing'), UnknownToolError);
});
