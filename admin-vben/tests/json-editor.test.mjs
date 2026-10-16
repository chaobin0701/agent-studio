import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const require = createRequire(
  new URL("../apps/web-ele/package.json", import.meta.url),
);
const ts = require("typescript");
const vue = require("vue");
const root = new URL("../apps/web-ele/src/", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");
const compiled = (script) =>
  ts.transpileModule(script, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
const helperContext = { exports: {}, require };
runInNewContext(
  compiled(source("components/json-validation.ts")),
  helperContext,
);
const { validateJson, sameJson, validateHeaders } = helperContext.exports;
function fixture(path, value, props = {}, expose = []) {
  const model = vue.ref(value),
    events = [];
  const script = source(path)
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import[\s\S]*?;\n/gm, "");
  const context = {
    ...vue,
    validateJson,
    sameJson,
    validateHeaders,
    defineModel: () => model,
    defineProps: () => props,
    withDefaults: (_, defaults) => ({ ...defaults, ...props }),
    defineEmits: () => (name, value) => events.push([name, value]),
    defineAsyncComponent: () => undefined,
  };
  runInNewContext(
    `${compiled(script)}\nglobalThis.state = {${expose.join(",")}};`,
    context,
  );
  return { model, events, ...context.state };
}

test("strict JSON rejects comments, trailing commas, unquoted keys and incomplete input", () => {
  for (const text of [
    '{"a":1,}',
    "{a:1}",
    '{"a":',
    "// comment\n{}",
    "",
    "undefined",
    '{"a":NaN}',
  ]) {
    const result = validateJson(text);
    assert.equal(result.ok, false, text);
    assert.match(result.message, /第 \d+ 行，第 \d+ 列/);
  }
  assert.match(validateJson('{\n "a": 1,\n}').message, /第 3 行/);
  for (const text of ["{}", "[]", '{"中文":"值"}', "null", "false", "12"])
    assert.equal(validateJson(text).ok, true);
});
test("field shape and optional values are checked separately from syntax", () => {
  for (const text of ["null", "[]", "false", '"text"'])
    assert.equal(validateJson(text, "object").ok, false);
  assert.equal(validateJson("{}", "object").ok, true);
  assert.equal(validateJson("{}", "array").ok, false);
  assert.equal(validateJson("[]", "array").ok, true);
  assert.equal(validateJson("", "array", true).ok, true);
  assert.equal(validateJson("", "array").ok, false);
  assert.equal(validateHeaders({ Accept: "application/json" }), undefined);
  assert.match(validateHeaders({ Accept: 123 }), /字符串/);
});
test("official JSON language supplies parsing, folding and syntax lint diagnostics", () => {
  const { EditorState } = require("@codemirror/state");
  const { json, jsonParseLinter } = require("@codemirror/lang-json");
  const { syntaxTree } = require("@codemirror/language");
  const state = EditorState.create({
    doc: '{"nested": {"ok": true}}',
    extensions: [json()],
  });
  assert.equal(syntaxTree(state).topNode.name, "JsonText");
  assert.deepEqual(jsonParseLinter()({ state }), []);
  const bad = EditorState.create({ doc: '{"x":}', extensions: [json()] });
  const [diagnostic] = jsonParseLinter()({ state: bad });
  assert.equal(diagnostic.severity, "error");
  assert.ok(diagnostic.from <= bad.doc.length);
});
test("JSON editor validates every keystroke, emits only valid parsed data, and formats explicitly", () => {
  const f = fixture("components/JsonEditor.vue", "{}", { kind: "object" }, [
    "validation",
    "format",
  ]);
  f.model.value = '{"x":';
  assert.equal(f.validation.value.ok, false);
  assert.deepEqual(f.events.filter(([name]) => name === "valid").at(-1), [
    "valid",
    false,
  ]);
  const parsedCount = f.events.filter(([name]) => name === "parsed").length;
  f.format();
  assert.equal(f.model.value, '{"x":');
  assert.equal(
    f.events.filter(([name]) => name === "parsed").length,
    parsedCount,
  );
  f.model.value = '{ "x":1 }';
  assert.equal(f.validation.value.ok, true);
  assert.equal(f.model.value, '{ "x":1 }');
  f.format();
  assert.equal(f.model.value, '{\n  "x": 1\n}');
  const ro = fixture(
    "components/JsonEditor.vue",
    '{ "x":1 }',
    { readonly: true },
    ["format"],
  );
  ro.format();
  assert.equal(ro.model.value, '{ "x":1 }');
});
test("header semantic validation prevents malformed values from being emitted", () => {
  const f = fixture(
    "components/JsonEditor.vue",
    "{}",
    { kind: "object", validateValue: validateHeaders },
    ["validation"],
  );
  f.model.value = '{"X-Account":123}';
  assert.equal(f.validation.value.ok, false);
  assert.match(f.validation.value.message, /字符串/);
});
test("value editor does not reformat valid keystrokes and retains invalid local edits", async () => {
  const f = fixture("components/JsonValueEditor.vue", { x: 1 }, {}, [
    "text",
    "parsed",
  ]);
  f.text.value = '{ "x": 2 }';
  f.parsed({ x: 2 });
  await vue.nextTick();
  assert.equal(f.text.value, '{ "x": 2 }');
  f.text.value = '{"x":';
  await vue.nextTick();
  assert.equal(f.model.value.x, 2);
  assert.equal(f.text.value, '{"x":');
  f.model.value = { y: 3 };
  await vue.nextTick();
  assert.equal(f.text.value, '{\n  "y": 3\n}');
});
test("Schema editor preserves constraints and advanced JSON formatting", async () => {
  const f = fixture(
    "views/tools/SchemaEditor.vue",
    { type: "object", properties: { name: { type: "string", minLength: 2 } } },
    {},
    ["text", "jsonChange", "rows", "apply"],
  );
  f.text.value = '{ "type": "object", "properties": {} }';
  f.jsonChange(JSON.parse(f.text.value));
  await vue.nextTick();
  assert.equal(f.text.value, '{ "type": "object", "properties": {} }');
  f.model.value = {
    type: "object",
    properties: { name: { type: "string", minLength: 2 } },
  };
  await vue.nextTick();
  f.rows.value[0].description = "名称";
  f.apply();
  assert.equal(f.model.value.properties.name.minLength, 2);
});
test("Tool errors combine independently and disabling output validation clears only its own error", () => {
  const f = fixture(
    "views/tools/ToolFields.vue",
    { type: "rest", outputSchema: {} },
    {},
    ["validity", "outputEnabled"],
  );
  f.validity("headers", false);
  f.validity("output", false);
  f.outputEnabled.value = false;
  assert.deepEqual(f.events.at(-1), ["valid", false]);
  f.validity("headers", true);
  assert.deepEqual(f.events.at(-1), ["valid", true]);
});
