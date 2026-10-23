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
