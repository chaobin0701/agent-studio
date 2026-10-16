import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const require = createRequire(
  new URL("../apps/web-ele/package.json", import.meta.url),
);
const ts = require("typescript"),
  vue = require("vue");
const source = readFileSync(
  new URL(
    "../apps/web-ele/src/views/executions/FileArtifacts.vue",
    import.meta.url,
  ),
  "utf8",
);
const script = source
  .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  .replace(/^import[\s\S]*?;\n/gm, "");
const compiled = ts.transpileModule(script, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
function fixture({ permission = true } = {}) {
  const calls = [],
    downloads = [],
    props = { traceId: "trace-a" },
    workspace = { generation: 1 };
  let answer = [];
  const context = {
    ...vue,
    watch() {},
    defineProps: () => props,
    useWorkspaceStore: () => workspace,
    useAccessStore: () => ({
      accessCodes: permission ? ["executions.artifacts.manage"] : [],
    }),
    api: {
      get: async (url) => {
        calls.push(["GET", url]);
        return answer;
      },
      delete: async (url) => {
        calls.push(["DELETE", url]);
      },
    },
    requestClient: {
      get: async (url) => {
        calls.push(["BLOB", url]);
        return {};
      },
    },
    ElMessageBox: { confirm: async () => true },
    document: {
      createElement: () => ({
        click() {
          downloads.push(this.download);
        },
      }),
    },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    setTimeout: () => 0,
    encodeURIComponent,
  };
  runInNewContext(
    `${compiled}\nglobalThis.page={load,download,purge,files,error,loading};`,
    context,
  );
  return {
    page: context.page,
    calls,
    downloads,
    props,
    context,
    setAnswer(value) {
      answer = value;
    },
  };
}
const file = {
  id: "file-a",
  filename: "report.md",
  available: true,
  purgedAt: null,
  byteSize: 20,
};
test("artifact panel loads only metadata and downloads through authenticated Blob request, never a raw external URL", async () => {
  const f = fixture();
  f.setAnswer([file]);
  await f.page.load();
  await f.page.download(file.id);
  assert.deepEqual(f.calls, [
    ["GET", "/executions/trace-a/artifacts"],
    ["BLOB", "/executions/trace-a/artifacts/file-a"],
  ]);
  assert.deepEqual(f.downloads, ["report.md"]);
  await f.page.download("unlisted-id");
  assert.equal(f.calls.length, 2);
});
test("purge requires its independent permission and confirmation; unavailable files do not start downloads", async () => {
  const f = fixture({ permission: false });
  f.page.files.value = [file];
  await f.page.purge(file.id);
  assert.equal(f.calls.length, 0);
  f.page.files.value = [{ ...file, available: false }];
  await f.page.download(file.id);
  assert.equal(f.calls.length, 0);
  const allowed = fixture();
  allowed.page.files.value = [file];
  allowed.context.ElMessageBox.confirm = async () => {
    throw new Error("cancel");
  };
  await allowed.page.purge(file.id);
  assert.equal(allowed.calls.length, 0);
  allowed.context.ElMessageBox.confirm = async () => true;
  await allowed.page.purge(file.id);
  assert.equal(allowed.calls[0][0], "DELETE");
});
test("switching trace during confirmation does not purge the old or newly selected execution", async () => {
  const f = fixture();
  f.page.files.value = [file];
  f.context.ElMessageBox.confirm = async () => {
    f.props.traceId = "trace-b";
    await f.page.load();
  };
  await f.page.purge(file.id);
  assert.equal(
    f.calls.some((call) => call[0] === "DELETE"),
    false,
  );
});
test("late metadata/download results are discarded after navigation, not attached to another execution", async () => {
  const f = fixture();
  let resolve;
  f.context.api.get = () =>
    new Promise((done) => {
      resolve = done;
    });
  const loading = f.page.load();
  f.props.traceId = "trace-b";
  f.context.api.get = async () => [];
  await f.page.load();
  resolve([file]);
  await loading;
  assert.equal(f.page.files.value.length, 0);
  f.page.files.value = [file];
  f.context.requestClient.get = () =>
    new Promise((done) => {
      resolve = done;
    });
  const downloading = f.page.download(file.id);
  f.props.traceId = "trace-c";
  await f.page.load();
  resolve({});
  await downloading;
  assert.equal(f.downloads.length, 0);
});
test("Agent output permission defaults off for legacy config and uses the existing versioned form/switch", () => {
  const fields = readFileSync(
    new URL("../apps/web-ele/src/views/resources/fields.vue", import.meta.url),
    "utf8",
  );
  assert.match(fields, /fileOutputsEnabled = computed/);
  assert.match(fields, /Boolean\(config\.value\.fileOutputs\?\.enabled\)/);
  assert.match(fields, /config\.value\.fileOutputs = \{ enabled \}/);
  assert.match(fields, /ElSwitch\s+v-model="fileOutputsEnabled"/);
  assert.match(source, /responseType: "blob"/);
  assert.doesNotMatch(source, /:href=.*download/);
});
