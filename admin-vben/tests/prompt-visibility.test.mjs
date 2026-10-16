import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createDraftQueue } from "../apps/web-ele/src/composables/draft-queue.ts";

const require = createRequire(
  new URL("../apps/web-ele/package.json", import.meta.url),
);
const ts = require("typescript");
const { ref, computed } = require("vue");
const directory = new URL(
  "../apps/web-ele/src/views/prompts/",
  import.meta.url,
);
const source = readFileSync(new URL("prompt-visibility.ts", directory), "utf8");
const context = { exports: {} };
runInNewContext(
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText,
  context,
);
const { isBusinessPrompt } = context.exports;
const pageSource = readFileSync(new URL("index.vue", directory), "utf8");
const script = pageSource
  .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  .replace(/^import[\s\S]*?;\n/gm, "");
const compiled = ts.transpileModule(script, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(resource) {
  const calls = [],
    route = { params: { id: resource?.id } };
  const context = {
    ref,
    computed,
    createDraftQueue,
    onBeforeUnmount() {},
    isBusinessPrompt,
    defineAsyncComponent: () => undefined,
    useRoute: () => route,
    useRouter: () => ({}),
    useAccessStore: () => ({ accessCodes: ["prompts.manage"] }),
    useUnsavedChanges: () => async () => true,
    watch() {},
    api: {
      get: async (url) => {
        calls.push(url);
        return url.endsWith("/usage") ? [] : resource;
      },
    },
  };
  runInNewContext(
    `${compiled}\nglobalThis.page = { load, visible, detail, selected, internalTemplate, list, search, template, definitions, variablesJson, flushDraft, saveState, draftQueue };`,
    context,
  );
  return { page: context.page, calls, api: context.api };
}

test("Prompt editor flushes a fixed payload and revision without publishing or overwriting later edits", async () => {
  const resource={id:4,promptKey:'business.support',versions:[{versionId:10,version:1,status:'draft',revision:1,template:'原正文',variables:{}}]};
  const f=fixture(resource);
  await f.page.load();
  const writes=[];
  f.api.patch=async(url,body)=>{writes.push({url,body});return {revision:body.expectedRevision+1};};
  f.page.template.value='修改后的正文';
  assert.equal(await f.page.flushDraft(),true);
  assert.equal(writes.length,1);
  assert.equal(writes[0].url,'/prompts/versions/10');
  assert.equal(writes[0].body.template,'修改后的正文');
  assert.equal(writes[0].body.expectedRevision,1);
  assert.equal(f.page.detail.value.versions[0].status,'draft');
  assert.equal(f.page.detail.value.versions[0].revision,2);
  f.page.draftQueue.dispose();
});

test("only business prompts are visible, including historical ordinary answer types", () => {
  const { page } = fixture();
  page.list.value = [
    { id: 1, promptKey: "agent.planner", name: "Planner" },
    { id: 2, promptKey: "agent.answer", name: "Answer", isPlatform: true },
    { id: 3, promptKey: "conversation.summary", name: "Summary" },
    {
      id: 4,
      promptKey: "business.support",
      name: "客服",
      promptType: "answer",
    },
    { id: 5, promptKey: "business.sales", name: "销售" },
  ];
  assert.deepEqual(
    page.visible.value.map((row) => row.id),
    [4, 5],
  );
  page.search.value = "客服";
  assert.deepEqual(
    page.visible.value.map((row) => row.id),
    [4],
  );
});

test("internal template deep links never expose editor or fetch usage", async () => {
  for (const resource of [
    { id: 1, promptKey: "agent.planner" },
    { id: 2, promptKey: "agent.answer", isPlatform: true },
    { id: 3, promptKey: "conversation.summary" },
  ]) {
    const { page, calls } = fixture(resource);
    await page.load();
    assert.equal(page.detail.value, undefined);
    assert.equal(page.selected.value, undefined);
    assert.equal(page.internalTemplate.value, true);
    assert.deepEqual(calls, [`/prompts/${resource.id}`]);
  }
});

test("business details retain version editing and reference loading", async () => {
  const resource = {
    id: 4,
    promptKey: "business.support",
    versions: [
      {
        versionId: 10,
        version: 1,
        status: "draft",
        template: "客服指导",
        variables: {},
      },
    ],
  };
  const { page, calls } = fixture(resource);
  await page.load();
  assert.equal(page.detail.value.id, 4);
  assert.equal(page.selected.value, 10);
  assert.equal(page.internalTemplate.value, false);
  assert.deepEqual(calls, ["/prompts/4", "/prompts/4/usage"]);
  assert.ok(!pageSource.includes("平台模板（高级）"));
  assert.ok(!pageSource.includes('@click="rollout"'));
  assert.ok(!pageSource.includes('row.environments'));
});
