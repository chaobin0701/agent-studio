import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const require = createRequire(
  new URL("../apps/web-ele/package.json", import.meta.url),
);
const ts = require("typescript"),
  vue = require("vue");
const source = (path) =>
  readFileSync(
    new URL(
      "../apps/web-ele/src/views/resources/skill/" + path,
      import.meta.url,
    ),
    "utf8",
  );
const compiled = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
const helpers = { exports: {}, TextEncoder, TextDecoder, Error };
runInNewContext(compiled(source("resources.ts")), helpers);
const { resourceError, readResourceFile, comparableResources } =
  helpers.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("Skill resource client validation agrees with canonical paths, UTF-8 byte caps, duplicates and binary restrictions", async () => {
  for (const path of [
    "../file",
    "/references/file",
    "references/../file",
    "references/.env",
    "references/a.",
    "references/%2e",
    "references/a\\b",
    "references/{a,b}",
    "references/__proto__/a",
    "references/a/",
  ])
    assert.ok(resourceError([{ path, content: "x" }]), path);
  assert.equal(
    resourceError([
      { path: "scripts/example.py", content: 'print("NEVER_EXECUTED")' },
    ]),
    undefined,
  );
  assert.ok(resourceError([{ path: "references/a.md", content: "\0" }]));
  assert.ok(resourceError([{ path: "references/a.md", content: "\ud800" }]));
  assert.ok(
    resourceError([{ path: "references/a.md", content: "字".repeat(22000) }]),
  );
  assert.ok(
    resourceError([
      { path: "references/A.md", content: "" },
      { path: "references/a.md", content: "" },
    ]),
  );
  assert.ok(
    resourceError([
      { path: "references/file", content: "" },
      { path: "references/file/child", content: "" },
    ]),
  );
  assert.ok(
    resourceError(
      Array.from({ length: 17 }, (_, i) => ({
        path: `references/${i}.md`,
        content: "",
      })),
    ),
  );
  assert.equal(
    resourceError([{ path: "references/a.md", content: "\ufeff中文" }]),
    undefined,
  );
  assert.equal(
    await readResourceFile({
      size: 9,
      arrayBuffer: async () => new TextEncoder().encode("\ufeff中文").buffer,
    }),
    "\ufeff中文",
  );
  await assert.rejects(
    readResourceFile({
      size: 2,
      arrayBuffer: async () => new Uint8Array([0xff, 0xff]).buffer,
    }),
    /UTF-8/,
  );
  await assert.rejects(
    readResourceFile({
      size: 65537,
      arrayBuffer: async () => {
        throw new Error("must not read");
      },
    }),
    /64 KiB/,
  );
});

function editor(initial = []) {
  const files = vue.ref(initial),
    props = { disabled: false };
  const script = source("resources.vue")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import[\s\S]*?;\n/gm, "");
  const state = {
    ...vue,
    resourceError,
    readResourceFile,
    TextEncoder,
    TextDecoder,
    Error,
    utf8Bytes: helpers.exports.utf8Bytes,
    defineProps: () => props,
    defineModel: () => files,
    useUnsavedChanges: () => async () => true,
    ElMessageBox: { confirm: async () => true },
  };
  runInNewContext(
    `${compiled(script)}\nglobalThis.editor = {edit,apply,remove,importFile,close,path,content,error,open};`,
    state,
  );
  return { ...state.editor, files, props };
}

test("resource editing uses an explicit confirm, invalid paths never modify config and readonly/history cannot mutate", async () => {
  const e = editor([{ path: "references/original.md", content: "Published" }]);
  e.edit();
  e.path.value = "references/new.md";
  e.content.value = "Draft";
  assert.equal(
    e.files.value.length,
    1,
    "editing does not submit automatically",
  );
  e.path.value = "references/../secret";
  e.apply();
  assert.ok(e.error.value);
  assert.equal(e.files.value.length, 1);
  e.path.value = "references/new.md";
  e.apply();
  assert.deepEqual(plain(e.files.value), [
    { path: "references/original.md", content: "Published" },
    { path: "references/new.md", content: "Draft" },
  ]);
  e.props.disabled = true;
  e.edit(0);
  e.content.value = "forged";
  e.apply();
  await e.remove(0);
  assert.equal(e.files.value[0].content, "Published");
  assert.equal(e.files.value.length, 2);
});

test("file import is local text only until confirmation and invalid UTF-8 preserves the previous editor buffer", async () => {
  const e = editor();
  e.edit();
  e.content.value = "Keep buffer";
  await e.importFile({
    name: "bad.md",
    raw: { size: 1, arrayBuffer: async () => new Uint8Array([0xff]).buffer },
  });
  assert.match(e.error.value, /UTF-8/);
  assert.equal(e.content.value, "Keep buffer");
  assert.equal(e.files.value.length, 0);
  await e.importFile({
    name: "example.md",
    raw: {
      size: 4,
      arrayBuffer: async () => new TextEncoder().encode("text").buffer,
    },
  });
  assert.equal(e.path.value, "references/example.md");
  assert.equal(e.content.value, "text");
  assert.equal(e.files.value.length, 0);
  e.apply();
  assert.equal(e.files.value.length, 1);
});

test("publication diff includes supporting content; source application preserves existing resources and complete export uses the server bundle", () => {
  const before = [{ path: "references/a.md", content: "before" }],
    after = [{ path: "references/a.md", content: "after" }];
  assert.notEqual(comparableResources(before), comparableResources(after));
  assert.match(comparableResources(after), /references\/a.md[\s\S]*after/);
  const detail = source("detail.vue");
  assert.match(detail, /resources: config\.value\.resources \?\? \[\]/);
  assert.match(
    detail,
    /value\.document \+ comparableResources\(value\.resources\)/,
  );
  assert.match(detail, /JSON\.stringify\(r\.bundle\)/);
  const index = readFileSync(
    new URL("../apps/web-ele/src/views/resources/index.vue", import.meta.url),
    "utf8",
  );
  assert.match(index, /resources: importedSkillResources\.value/);
  assert.match(index, /\/agent-resources\/skill-bundle/);
});

test("applying SKILL.md source runs the real handler, retaining auxiliary files in the persisted draft", async () => {
  const handler = source("detail.vue").match(
    /async function applySource\(\) \{[\s\S]*?\n\}/,
  )[0];
  const resources = [
    { path: "references/guide.md", content: "Keep reference" },
  ];
  let saved;
  const state = {
    ...vue,
    editable: vue.ref(true),
    sourceError: vue.ref(""),
    busy: vue.ref(false),
    source: vue.ref("Changed SKILL.md"),
    detail: vue.ref({ key: "stable_skill" }),
    config: vue.ref({ resources }),
    diagnostics: vue.ref([]),
    sourceOriginal: vue.ref(""),
    tab: vue.ref("source"),
    contentValid: vue.ref(true),
    api: {
      post: async () => ({
        config: {
          document: "Changed SKILL.md",
          instructions: "changed",
          resources: [],
        },
        diagnostics: [],
      }),
    },
    persist: async () => {
      saved = plain(state.config.value);
    },
  };
  runInNewContext(
    `${compiled(handler)}\nglobalThis.apply = applySource;`,
    state,
  );
  await state.apply();
  assert.equal(saved.document, "Changed SKILL.md");
  assert.deepEqual(saved.resources, resources);
  assert.equal(state.tab.value, "form");
});
