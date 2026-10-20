import test from "node:test";
import assert from "node:assert/strict";
import {
  builtinToolConfig,
  httpToolConfig,
  toolTestExample,
} from "../src/views/tools/create-config.ts";

const native = {
  key: "ask_user",
  description: "向用户提问，收集继续执行所需的信息。",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string" },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, label: { type: "string" } },
        },
      },
      allowCustom: { type: "boolean" },
    },
    required: ["question", "options", "allowCustom"],
    additionalProperties: false,
  },
};

test("creating a built-in tool copies its registered contract without HTTP credentials or execution permissions", () => {
  const config = builtinToolConfig([native], "ask_user");
  assert.equal(config.type, "builtin");
  assert.equal(config.target, "ask_user");
  assert.equal(config.description, native.description);
  assert.deepEqual(config.parameters, native.parameters);
  assert.equal(config.maxRetries, 0);
  assert.equal(config.requiresApproval, false);
  assert.equal(config.readOnly, false);
  assert.equal(config.endpoint, undefined);
  assert.equal(config.idempotencyHeader, undefined);
  config.parameters.required.push("changed");
  assert.deepEqual(native.parameters.required, [
    "question",
    "options",
    "allowCustom",
  ]);
});

test("only registered built-in implementations with an object contract can be selected", () => {
  assert.throws(() => builtinToolConfig([native], "unknown"), /已注册/);
  assert.throws(
    () =>
      builtinToolConfig(
        [{ ...native, parameters: { type: "string" } }],
        "ask_user",
      ),
    /参数契约/,
  );
});

test("returning to HTTP creation removes the native target and restores a fresh safe GET configuration", () => {
  const config = httpToolConfig();
  assert.equal(config.type, "rest");
  assert.equal(config.target, undefined);
  assert.equal(config.endpoint.method, "GET");
  assert.equal(config.endpoint.url, "");
  assert.equal(config.endpoint.mappingMode, "explicit");
  assert.deepEqual(config.endpoint.bindings, []);
  assert.equal(config.readOnly, true);
  assert.equal(config.requiresApproval, false);
  config.endpoint.headers.Authorization = "must not carry to another form";
  assert.deepEqual(httpToolConfig().endpoint.headers, {});
});

test("the question tool test starts with a complete editable interaction example", () => {
  const input = toolTestExample({ type: "builtin", target: "ask_user" });
  assert.ok(input.question.trim());
  assert.ok(input.options.length > 0);
  assert.equal(
    new Set(input.options.map((option) => option.id)).size,
    input.options.length,
  );
  assert.ok(input.options.every((option) => option.label.trim()));
  assert.equal(input.allowCustom, true);
  input.options[0].label = "custom test value";
  assert.notEqual(
    toolTestExample({ type: "builtin", target: "ask_user" }).options[0].label,
    "custom test value",
  );
  assert.deepEqual(toolTestExample({ type: "rest", target: "ask_user" }), {});
});
