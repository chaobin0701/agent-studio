import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(
  new URL("../apps/web-ele/package.json", import.meta.url),
);
const { parse } = require("vue/compiler-sfc");
const { ref } = require("vue");
const ts = require("typescript");
const source = readFileSync(
  new URL("../apps/web-ele/src/views/models/index.vue", import.meta.url),
  "utf8",
);

test("the standard Base URL input stays editable on preset platforms when creating a supplier", () => {
  const { descriptor } = parse(source);
  let input;
  function walk(node) {
    if (
      node.type === 1 &&
      node.tag === "ElInput" &&
      node.props.some(
        (p) => p.name === "model" && p.exp?.content === "form.baseUrl",
      )
    )
      input = node;
    for (const child of node.children ?? []) walk(child);
  }
  walk(descriptor.template.ast);
  assert(input);
  assert.equal(
    input.props.find((p) => p.arg?.content === "disabled")?.exp.content,
    "!!editId",
  );
  assert.equal(
    input.props.find((p) => p.name === "type")?.value.content,
    "url",
  );
  assert(!source.includes("已批准的 HTTPS"));
});

for (const kind of ["llm", "embedding"]) {
  test(`${kind}: platform selection prefills a default, but saving uses the administrator's custom API URL`, async () => {
    const requests = [];
    const context = {
      form: ref({
        name: "Proxy supplier",
        platformKey: "openai",
        apiKey: "own-key",
        baseUrl: "",
      }),
      platforms: ref([{ key: "openai", baseUrl: "https://api.openai.com/v1" }]),
      dialog: ref("account"),
      editId: ref(undefined),
      base: ref(`/model-management/${kind}`),
      api: {
        post: async (url, body) => {
          requests.push({ url, body });
        },
      },
      clearCredential() {},
      credentialGrant: ref(undefined),
      remember() {},
    };
    const script =
      source.slice(
        source.indexOf("function platformChanged"),
        source.indexOf("const available"),
      ) +
      source.slice(
        source.indexOf("async function persist"),
        source.indexOf("async function save"),
      );
    runInNewContext(
      ts.transpileModule(script, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText + "\nglobalThis.page = { platformChanged, persist };",
      context,
    );
    context.page.platformChanged("openai");
    assert.equal(context.form.value.baseUrl, "https://api.openai.com/v1");
    context.form.value.baseUrl = "http://localhost:11434/v1";
    await context.page.persist();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `/model-management/${kind}/accounts`);
    assert.equal(requests[0].body.baseUrl, "http://localhost:11434/v1");
    assert.equal(requests[0].body.platformKey, "openai");
  });
}
