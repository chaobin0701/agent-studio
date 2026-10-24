import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { nativeChat } from "./helpers/native-chat.mjs";
import { toolArgumentsHash } from "../dist/ai/tools/tool-context.js";
import { capabilityOutputs, selectCapabilityOutputs } from "../dist/ai/runtime/capability-output.js";
import { compileUiCatalog, makeUiTool, uiBlocks } from "../dist/tool-management/ui-tool.js";
import { makeManagedTool } from "../dist/agent-management/managed-tool.js";
import { ToolExecutionService } from "../dist/ai/tools/tool-execution.js";
import { ToolPolicy } from "../dist/ai/tools/tool-policy.js";
import { executionContextView } from "../dist/observability/execution-view.js";

function catalog() {
  const props = {
    type: "object",
    properties: { label: { type: "string", maxLength: 500 }, value: { type: "number" } },
    required: ["label", "value"], additionalProperties: false,
  };
  const components = { Fact: { description: "Read-only fact", props, children: false } };
  const parameters = {
    type: "object", properties: {
      _type: { const: "Fact" }, _key: { anyOf: [{ type: "string" }, { type: "number" }] },
      label: { type: "string" }, value: { type: "number" },
    }, required: ["_type"], additionalProperties: false,
  };
  return { adapter: "assistant-ui", version: toolArgumentsHash({ parameters, components }), parameters, components };
}

const fact = { _type: "Fact", label: "Revenue", value: 42 };
const final = answer => JSON.stringify({ type: "final", status: "answered", answer, citationIds: [], artifactIds: [] });

function nestedCatalog() {
  const source = catalog();
  source.components.Row = { description: "Layout", children: true, props: { type: "object", properties: {}, additionalProperties: false } };
  source.components.Table = { description: "Table", children: false, props: {
    type: "object", properties: { caption: { type: "string" }, columns: { type: "array", items: { type: "string" } } },
    required: ["caption", "columns"], additionalProperties: false,
  } };
  const node = {
    type: "object", properties: {
      ...source.parameters.properties, _type: { enum: Object.keys(source.components) },
      caption: { type: "string" }, columns: { type: "array", items: { type: "string" } },
      children: { anyOf: [{ type: "string" }, { $ref: "#/$defs/node" }, { type: "array", items: { $ref: "#/$defs/node" } }] },
    }, required: ["_type"],
  };
  source.parameters = { ...node, $defs: { node } };
  source.version = toolArgumentsHash({ parameters: source.parameters, components: source.components });
  return source;
}

test("Ajv errors retain component and JSON Pointer while withholding argument values and unknown property names", () => {
  const { diagnose, validate } = compileUiCatalog(nestedCatalog());
  const tree = { _type: "Row", children: [{ _type: "Table", columns: ["PRIVATE_VALUE"], label: "PRIVATE_VALUE", PRIVATE_FIELD: "PRIVATE_VALUE" }] };
  assert.equal(validate(tree), false);
  const diagnostics = diagnose(tree);
  assert.ok(diagnostics.issues.some(issue => issue.path === "/children/0" && issue.component === "Table" && issue.field === "caption" && issue.keyword === "required"));
  assert.ok(diagnostics.issues.some(issue => issue.field === "label" && issue.keyword === "additionalProperties"));
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_/);
  assert.deepEqual(diagnose({ ...fact, value: "PRIVATE_VALUE" }).issues, [{ path: "/value", component: "Fact", keyword: "type" }]);
  assert.equal(validate({ _type: "Row", children: [fact, { _type: "Table", caption: "Facts", columns: ["Name"] }] }), true);
});

test("platform limits remain bounded and do not relax component validation", () => {
  const { diagnose, validate } = compileUiCatalog(nestedCatalog());
  const wrap = children => ({ _type: "Row", children });
  assert.equal(diagnose(wrap(Array.from({ length: 41 }, () => fact))).issues[0].keyword, "maxItems");
  assert.equal(diagnose(Array.from({ length: 9 }).reduce(wrap, fact)).issues[0].keyword, "depth_limit");
  const short = { _type: "Fact", label: "x", value: 1 };
  assert.equal(diagnose(wrap([wrap(Array(40).fill(short)), wrap(Array(40).fill(short))])).issues[0].keyword, "node_limit");
  assert.equal(diagnose({ ...fact, label: "x".repeat(6000) }).issues[0].keyword, "size_limit");
  assert.equal(diagnose({ ...fact, label: "x".repeat(501) }).issues[0].keyword, "maxLength");
  assert.equal(validate({ ...fact, _key: "x".repeat(101) }), false);
});

test("managed present preserves published parameters and returns Ajv guidance without extra tool execution", async () => {
  const source = nestedCatalog();
  const tool = makeManagedTool({ id: 9, key: "present", config: {
    type: "ui", description: "Custom description", uiCatalog: source, parameters: source.parameters,
    readOnly: true, requiresApproval: false, maxRetries: 0, timeoutMs: 10000,
  } }, () => { throw Error("Unexpected registry lookup"); });
  assert.deepEqual(tool.parameters, source.parameters);
  assert.match(tool.description, /Custom description/);
  assert.match(tool.description, /Table: 必填 caption, columns/);
  const service = new ToolExecutionService({ get: () => tool }, new ToolPolicy());
  const logs = [];
  service.logger.warn = message => logs.push(JSON.parse(message));
  const outcome = await service.execute("present", { _type: "Table", columns: ["PRIVATE_VALUE"] }, {
    permissions: [], state: new Map(), traceId: "trace-1", sessionId: "session-1",
  }, service.createStateForAgent(["present"], 3));
  assert.equal(outcome.result.errorCode, "invalid_arguments");
  assert.equal(outcome.result.artifacts, undefined);
  assert.match(outcome.result.content, /caption/);
  assert.equal(logs[0].event, "tool_input_validation_failed");
  assert.equal(logs[0].toolVersionId, 9);
  assert.equal(logs[0].traceId, "trace-1");
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_VALUE/);
  const view = executionContextView({ toolCalls: [{ ...outcome.trace, validation: {
    ...outcome.trace.validation, arguments: "PRIVATE_ARGUMENTS", issues: [
      ...outcome.trace.validation.issues.map(issue => ({ ...issue, message: "PRIVATE_MESSAGE", value: "PRIVATE_VALUE" })),
      { path: "PRIVATE_PATH", keyword: "type" },
    ],
  } }] });
  assert.deepEqual(view.tools[0].validation, outcome.trace.validation);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_/);
});

test("native model loop can correct invalid props using tool feedback then emit one UI block", async () => {
  const tool = makeUiTool(catalog());
  const blocks = [];
  const host = nativeChat({ tools: [tool], respond: (request, index) => {
    if (index === 1) return { content: "", toolCalls: [{ id: "bad", name: "present", arguments: { _type: "Fact", label: "Revenue" } }] };
    if (index === 2) {
      assert.match(JSON.stringify(request.messages), /required/);
      assert.match(JSON.stringify(request.messages), /value/);
      return { content: "", toolCalls: [{ id: "good", name: "present", arguments: fact }] };
    }
    return { content: final("Here is the result.") };
  } });
  const result = await host.runner.run({ question: "Show a fact", summary: "", recentHistory: [], runId: "run-repair" }, { onArtifact: artifact => blocks.push(artifact) });
  assert.equal(host.requests.length, 3);
  assert.equal(blocks.length, 1);
  assert.deepEqual(result.result.uiBlocks[0].tree, fact);
});

test("catalog hash, component props and framework limits validate the complete tree", () => {
  const source = catalog();
  const { validate } = compileUiCatalog(source);
  assert.equal(validate(fact), true);
  assert.equal(validate({ ...fact, _key: 3 }), true);
  for (const tree of ["text", { ...fact, _type: "Unknown" }, { ...fact, value: "42" }, { ...fact, children: [] }, { ...fact, extra: "no" }])
    assert.equal(validate(tree), false);
  assert.throws(() => compileUiCatalog({ ...source, version: "0".repeat(64) }), /摘要不匹配/);
  const remote = structuredClone(source);
  remote.components.Fact.props.$ref = "https://example.invalid/schema";
  remote.version = toolArgumentsHash({ parameters: remote.parameters, components: remote.components });
  assert.throws(() => compileUiCatalog(remote), /本地引用/);
});

test("present uses managed Tool binding, emits one stable immediate block and retains it in the final output", async () => {
  const source = catalog();
  const spec = {
    type: "ui", target: "present", description: "Present read-only facts",
    uiCatalog: source, parameters: source.parameters, readOnly: true,
    requiresApproval: false, maxRetries: 0, timeoutMs: 10000,
  };
  const tool = makeManagedTool({ id: 9, key: "present", config: spec }, () => { throw Error("UI Tool must not require a registry implementation"); });
  const forbidden = new ToolExecutionService({ get: () => tool }, new ToolPolicy());
  assert.equal((await forbidden.execute("present", fact, { permissions: [], state: new Map() }, forbidden.createStateForAgent([], 1))).result.errorCode, "tool_not_allowed");

  const events = [];
  const host = nativeChat({ tools: [tool], respond: (_request, index) => index === 1
    ? { content: "", toolCalls: [{ id: "ui-call", name: "present", arguments: fact }] }
    : { content: final("Here is the result.") } });
  const result = await host.runner.run({ question: "Show a fact", summary: "", recentHistory: [], runId: "run-1" }, {
    onArtifact: artifact => events.push(artifact),
  });
  assert.equal(host.requests.length, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].delivery, "immediate");
  assert.equal(events[0].id, "ui-call:0");
  assert.deepEqual(result.result.artifacts, events);
  assert.deepEqual(uiBlocks(events, "run-1"), result.result.uiBlocks);
  assert.equal(result.result.uiBlocks[0].blockId, "run-1:ui-call:0");
  assert.deepEqual(result.result.uiBlocks[0].tree, fact);
  assert.equal(result.result.answer, "Here is the result.");
});

test("immediate presentation survives final artifact omission or refusal, while ordinary artifacts remain selected", () => {
  const tool = makeUiTool(catalog());
  assert.equal(tool.name, "present");
  const projected = capabilityOutputs({ success: true, content: "done", artifacts: [
    { kind: "generative_ui", delivery: "immediate", data: { adapter: "assistant-ui", catalogVersion: catalog().version, tree: fact, fallbackText: "Revenue 42" } },
    { kind: "other", data: { secret: "private" } },
  ] }, "call", 12000);
  assert.equal(projected.artifacts.length, 2);
  assert.deepEqual(selectCapabilityOutputs({ status: "answered", artifactIds: [] }, projected).artifacts.map(a => a.kind), ["generative_ui"]);
  assert.deepEqual(selectCapabilityOutputs({ status: "refused" }, projected).artifacts.map(a => a.kind), ["generative_ui"]);
});
