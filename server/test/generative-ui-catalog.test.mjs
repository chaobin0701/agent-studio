import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileUiCatalog, makeUiTool } from "../dist/tool-management/ui-tool.js";

// Exported from showcase definitions using assistant-ui's official schema builder.
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/generative-ui/${name}.json`, import.meta.url), "utf8"));
test("official 21-component present schema compiles with Ajv and accepts every showcase example", async () => {
  const catalog = fixture("catalog");
  const examples = fixture("examples");
  const { validate, diagnose } = compileUiCatalog(catalog);
  assert.equal(Object.keys(catalog.components).length, 21);
  for (const example of examples) assert.equal(validate(example), true, `${example._type}: ${JSON.stringify(diagnose(example))}`);
  const tool = makeUiTool(catalog);
  assert.deepEqual(tool.parameters, catalog.parameters);
  assert.match(tool.description, /不是工具审批/);
  assert.doesNotMatch(tool.description, /不包含操作或表单/);
  for (const example of examples.slice(17)) {
    const result = await tool.execute(example);
    assert.equal(result.success, true);
    assert.deepEqual(result.artifacts[0].data.tree, example);
  }
});

test("generic catalog validators reject unsafe URLs, invalid actions and component-specific extra props", () => {
  const { validate } = compileUiCatalog(fixture("catalog"));
  for (const url of ["javascript:alert(1)", "data:text/html,test", "//evil.test", "/\\evil.test", "https://name:password@evil.test"]) {
    assert.equal(validate({ _type: "Image", src: url, alt: "test" }), false);
    assert.equal(validate({ _type: "ActionButton", id: "a", label: "go", action: { type: "open_url", url } }), false);
  }
  assert.equal(validate({ _type: "ActionButton", id: "a", label: "go", action: { type: "execute_tool", tool: "delete" } }), false);
  assert.equal(validate({ _type: "Choice", id: "a", title: "choose", options: [] }), false);
  assert.equal(validate({ _type: "Form", id: "a", title: "form", fields: [{ name: "x", label: "test", type: "password" }] }), false);
  assert.equal(validate({ _type: "Form", id: "a", title: "form", fields: [{ name: "x", label: "test", type: "select" }] }), false);
  assert.equal(validate({ _type: "Form", id: "a", title: "form", fields: [{ name: "x", label: "test", type: "text", options: [{ value: "x", label: "test" }] }] }), false);
  assert.equal(validate({ _type: "Badge", label: "ok", action: { type: "send_message", message: "test" } }), false);
});
