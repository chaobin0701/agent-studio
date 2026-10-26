import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const require = createRequire(new URL('../apps/web-ele/package.json', import.meta.url));
const ts = require('typescript');
const { computed, ref } = require('vue');
const source = readFileSync(new URL('../apps/web-ele/src/views/resources/fields.vue', import.meta.url), 'utf8');
const handlers = ts.transpileModule(source.slice(source.indexOf('const choices ='), source.indexOf('</script>')), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const tool = (id, key, toolType, extra = {}) => ({
    kind: 'tool', key, name: key, toolType, enabled: true,
    versions: [{ id, version: 1, status: 'published' }], ...extra,
  });
  const config = ref({ toolVersionIds: [1, 3, 5, 999], skillVersionIds: [] });
  const resources = [
    tool(1, 'weather', 'rest'), tool(2, 'ask_user', 'builtin'),
    tool(3, 'present', 'ui', { versions: [
      { id: 3, version: 1, status: 'published' },
      { id: 4, version: 2, status: 'published' },
      { id: 7, version: 3, status: 'draft' },
    ] }),
    tool(5, 'mcp_user', 'mcp'), tool(6, 'disabled', 'ui', { enabled: false }),
    tool(8, 'archived', 'rest', { archivedAt: '2026-10-26' }),
    tool(9, 'search_knowledge', 'builtin'),
  ];
  const context = { config, props: { resources }, computed };
  runInNewContext(`${handlers}\nglobalThis.page = {choices, selectedResources, updateResources, selectedTools, isUiTool, resourceDisabled};`, context);
  return { ...context, page: context.page };
}

test('existing UI bindings appear alongside ordinary Tools and count once, while MCP remains separate', () => {
  const { page } = fixture();
  assert.deepEqual(Array.from(page.choices('tool'), item => item.id), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(page.selectedResources('tool', 'toolVersionIds')), [1, 3]);
  assert.deepEqual(Array.from(page.selectedTools.value, item => item.id), [1, 3, 5]);
  assert.equal(page.isUiTool(3), true);
  assert.equal(page.isUiTool(1), false);
});

test('removing or adding a UI Tool preserves MCP and unavailable historical bindings', () => {
  const { config, page } = fixture();
  page.updateResources('tool', 'toolVersionIds', [1, 2]);
  assert.deepEqual(Array.from(config.value.toolVersionIds), [5, 999, 1, 2]);
  page.updateResources('tool', 'toolVersionIds', [1, 2, 3]);
  assert.deepEqual(Array.from(config.value.toolVersionIds), [5, 999, 1, 2, 3]);
  page.updateResources('mcp', 'toolVersionIds', []);
  assert.deepEqual(Array.from(config.value.toolVersionIds), [999, 1, 2, 3]);
});

test('only one published version of present can be selected, and removal permits switching versions', () => {
  const { page } = fixture();
  const options = page.choices('tool');
  assert.equal(page.resourceDisabled('tool', options.find(item => item.id === 3)), false);
  assert.equal(page.resourceDisabled('tool', options.find(item => item.id === 4)), true);
  page.updateResources('tool', 'toolVersionIds', [1]);
  assert.equal(page.resourceDisabled('tool', options.find(item => item.id === 4)), false);
  page.updateResources('tool', 'toolVersionIds', [1, 4]);
  assert.equal(page.resourceDisabled('tool', options.find(item => item.id === 3)), true);
});
