import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { LlmService } from "../dist/chat/llm.service.js";
import { ToolRegistry } from "../dist/ai/tools/tool-registry.js";
import { ToolPolicy } from "../dist/ai/tools/tool-policy.js";
import { ToolExecutionService } from "../dist/ai/tools/tool-execution.js";
import { ManagedDeepAgentHarness } from "../dist/ai/deep-agents/managed-harness.js";
import { AskUserTool } from "../dist/ai/tools/ask-user.tool.js";
import { InteractionSuspension } from "../dist/interactions/contracts.js";
import { makeManagedTool } from "../dist/agent-management/managed-tool.js";
import { createHash } from "node:crypto";
import { nativeChat } from "./helpers/native-chat.mjs";
import { toolArgumentsHash } from "../dist/ai/tools/tool-context.js";
import { knowledgeResources } from "../dist/ai/context/context-contribution.js";

const final = (content = "完成") => ({ content, toolCalls: [], model: "fixture", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, durationMs: 1 });
const calls = (...items) => ({ ...final(""), finishReason: "tool_calls", toolCalls: items.map(([id, name, args]) => ({ id, name, arguments: args })) });
const question = { question: "预算是多少？", options: [{ id: "low", label: "2000 元以内" }, { id: "mid", label: "2000–3000 元" }], allowCustom: true };
const task = { messages: [{ role: "user", content: "帮我完成任务" }], versions: { agentVersionId: 1 }, limits: { maxDecisions: 8, maxToolCalls: 10, maxModelCalls: 8, maxDurationMs: 180000 } };
function fixture(handler, tools) {
  const requests = [];
  const provider = { model: "fixture", maxOutputTokens: 1200, contextWindowTokens: 32000,
    chat: async (request) => { requests.push(request); return handler(request, requests.length); },
    async *stream(request) { const response = await this.chat(request); if (response.content) yield { type: "text_delta", delta: response.content }; for (const [index, call] of response.toolCalls.entries()) yield { type: "tool_call_delta", index, id: call.id, name: call.name, argumentsDelta: JSON.stringify(call.arguments) }; yield { type: "completed", usage: response.usage, finishReason: response.finishReason }; },
  };
  const llm = new LlmService(provider);
  const options = () => {
    const registry = new ToolRegistry(); tools.forEach((tool) => registry.register(tool));
    return { systemPrompt: "完成任务", tools, skills: [], gateway: new ToolExecutionService(registry, new ToolPolicy()), toolContext: { permissions: tools.map((tool) => tool.name), state: new Map() } };
  };
  return { requests, run: (host, extra = {}, taskInput = task) => new ManagedDeepAgentHarness(llm).run(taskInput, { ...options(), interactionHost: host, ...extra }) };
}
async function suspend(operation) { try { await operation; assert.fail("must suspend"); } catch (error) { assert.ok(error instanceof InteractionSuspension, String(error?.stack)); return error; } }
const resume = (host, waiting, value) => ({ ...host, continuation: waiting.continuation, resume: { interruptId: waiting.interruptId, value } });
const restart = (host, waiting, value) => {
  const saver = new MemorySaver();
  saver.storage = structuredClone(host.checkpointer.storage);
  saver.writes = structuredClone(host.checkpointer.writes);
  return resume({ ...host, checkpointer: saver }, waiting, value);
};
function managedWrite(name, version, execute, requiresApproval = true) {
  const base = { name, inputSchema: z.object({ value: z.number() }).strict(), description: name,
    planning: { canBatch: true, isIdempotent: false }, execute };
  return makeManagedTool({ id: version, key: name, config: { type: "builtin", target: name, description: name, parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, readOnly: false, requiresApproval, timeoutMs: 1000, maxRetries: 0 } }, () => base);
}

test("native question resumes a recreated harness without repeating the model request", async () => {
  const f = fixture((request, index) => { if (index === 1) return calls(["q-1", "ask_user", question]); assert.match(JSON.stringify(request.messages), /2000–3000/); return final("已采用你的预算"); }, [new AskUserTool()]);
  const host = { threadId: "question", checkpointer: new MemorySaver() };
  const waiting = await suspend(f.run(host));
  assert.equal(waiting.request.kind, "question");
  assert.equal(f.requests.length, 1);
  const result = await f.run(resume(host, waiting, { optionId: "mid", text: "2000–3000 元" }));
  assert.equal(result.result.answer, "已采用你的预算");
  assert.equal(result.decisions, 2);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.result.usage.totalTokens, 10);
});

test("successful write before a later question is never replayed by native resume", async () => {
  let writes = 0;
  const write = managedWrite("save_record", 9, async () => { writes++; return { success: true, content: "saved" }; }, false);
  const f = fixture((_request, index) => index === 1 ? calls(["write-1", "save_record", { value: 2 }]) : index === 2 ? calls(["q-2", "ask_user", question]) : final(), [write, new AskUserTool()]);
  const host = { threadId: "write-then-question", checkpointer: new MemorySaver() };
  const waiting = await suspend(f.run(host));
  assert.equal(writes, 1);
  const result = await f.run(restart(host, waiting, { text: "2600 元" }));
  assert.equal(writes, 1);
  assert.equal(result.decisions, 3);
  assert.equal(result.toolCalls, 2);
});

test("approval pauses before any external effect and resumes only that exact call", async () => {
  let writes = 0;
  const tool = managedWrite("submit_record", 10, async () => { writes++; return { success: true, content: "submitted" }; });
  const f = fixture((_request, index) => index === 1 ? calls(["approve-1", "submit_record", { value: 7 }]) : final(), [tool]);
  const host = { threadId: "approval", checkpointer: new MemorySaver() };
  const waiting = await suspend(f.run(host));
  assert.equal(writes, 0);
  assert.equal(waiting.request.toolCallId, "approve-1");
  assert.deepEqual(waiting.request.arguments, { value: 7 });
  const result = await f.run(resume(host, waiting, { decision: "approve" }));
  assert.equal(writes, 1);
  assert.equal(result.toolCalls, 1);
  const grant = { toolCallId: "approve-1", toolVersionId: 10,
    argumentsHash: createHash("sha256").update(JSON.stringify({ value: 7 })).digest("hex") };
  const wrong = await tool.execute({ value: 8 }, { permissions: [tool.name], state: new Map(), toolApproval: grant });
  assert.equal(wrong.success, false);
  assert.equal(writes, 1);
});

test("top-level private continuation retains diagnostic history and shared budgets after restart", async () => {
  let writes = 0;
  const write = managedWrite("persist_record", 17, async () => { writes++; return { success: true, content: "saved" }; }, false);
  const f = nativeChat({ tools: [write, new AskUserTool()], respond: (_request, index) => index === 1
    ? { content: "", toolCalls: [{ id: "outer-write", name: "persist_record", arguments: { value: 1 } }] }
    : index === 2 ? { content: "", toolCalls: [{ id: "outer-question", name: "ask_user", arguments: question }] }
      : { content: "Done" } });
  const host = { threadId: "outer-runtime", checkpointer: new MemorySaver() };
  const context = { runId: "outer-run", traceId: "outer-trace", interactionHost: host };
  const waiting = await suspend(f.execution.runTask(f.snapshot, task, context));
  assert.equal(waiting.continuation.execution.budget.modelCalls, 2);
  const result = await f.execution.runTask(f.snapshot, task, { ...context,
    interactionHost: restart(host, waiting, { optionId: "low", text: "2000 元以内" }) });
  assert.equal(writes, 1);
  assert.equal(result.contextSnapshot.executionBudget.modelCalls, 3);
  assert.equal(result.contextSnapshot.executionBudget.toolCalls, 2);
  assert.equal(result.contextSnapshot.modelCalls.length, 3);
  assert.equal(result.toolResults.length, 2);
  assert.equal(result.toolResults[0].callId, "outer-write");
});

test("multi-Agent interaction fails closed while plain multi-Agent tasks still run", async () => {
  const questionTool = new AskUserTool();
  const f = nativeChat({ tools: [questionTool], respond: () => ({ content: "", toolCalls: [{ id: "multi-question", name: "ask_user", arguments: question }] }) });
  const multi = { ...f.snapshot, agents: new Map([...f.snapshot.agents, [2, { ...f.snapshot.agents.get(1), version: { ...f.snapshot.agents.get(1).version, id: 2 } }]]) };
  await assert.rejects(f.execution.runTask(multi, task,
    { runId: "multi", traceId: "multi", interactionHost: { threadId: "multi", checkpointer: new MemorySaver() } }), /interaction_mode_unsupported/);
  const plain = nativeChat({ respond: () => ({ content: "Direct answer" }) });
  const plainMulti = { ...plain.snapshot, agents: new Map([...plain.snapshot.agents, [2, { ...plain.snapshot.agents.get(1), version: { ...plain.snapshot.agents.get(1).version, id: 2 } }]]) };
  const result = await plain.execution.runTask(plainMulti, task, { runId: "plain-multi", traceId: "plain-multi" });
  assert.equal(result.output.answer, "Direct answer");
});

test("mixed approval batch preserves original ordering and rejection never calls a tool", async () => {
  const effects = [];
  const one = managedWrite("first_write", 20, async () => { effects.push("first"); return { success: true, content: "first" }; });
  const two = managedWrite("second_write", 21, async () => { effects.push("second"); return { success: true, content: "second" }; });
  const f = fixture((_request, index) => index === 1 ? calls(["first", "first_write", { value: 1 }], ["second", "second_write", { value: 2 }]) : final(), [one, two]);
  const host = { threadId: "mixed", checkpointer: new MemorySaver() };
  const first = await suspend(f.run(host));
  const second = await suspend(f.run(resume(host, first, { decision: "approve" })));
  assert.equal(second.request.toolCallId, "second");
  assert.deepEqual(effects, []);
  await f.run(resume(host, second, { decision: "reject" }));
  assert.deepEqual(effects, ["first"]);
});

test("streaming uses the same durable native question interruption", async () => {
  const f = fixture((_request, index) => index === 1 ? calls(["stream-q", "ask_user", question]) : final("继续完成"), [new AskUserTool()]);
  const host = { threadId: "stream-question", checkpointer: new MemorySaver() };
  const waiting = await suspend(f.run(host, { onAnswerDelta() {} }));
  const result = await f.run(resume(host, waiting, { text: "自定义预算" }), { onAnswerDelta() {} });
  assert.equal(result.result.answer, "继续完成");
});

test("question capability is absent without an explicit binding and cannot bypass unavailable host", async () => {
  const plain = fixture(() => final(), []);
  await plain.run(undefined);
  assert.ok(!JSON.stringify(plain.requests[0].tools).includes("ask_user"));
  const f = fixture(() => calls(["no-host", "ask_user", question]), [new AskUserTool()]);
  await assert.rejects(f.run(undefined), /interaction_transport_unavailable/);
});

test("private fingerprints and approval grants survive JSONB property reordering", async () => {
  assert.equal(toolArgumentsHash({ b: { z: 1, a: 2 }, a: [3, 4] }),
    toolArgumentsHash({ a: [3, 4], b: { a: 2, z: 1 } }));
  assert.notEqual(toolArgumentsHash([3, 4]), toolArgumentsHash([4, 3]));
  const f = fixture((_request, index) => index === 1 ? calls(["jsonb-q", "ask_user", question]) : final(), [new AskUserTool()]);
  const host = { threadId: "jsonb", checkpointer: new MemorySaver() };
  const waiting = await suspend(f.run(host));
  const reorder = (value) => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)])) : value;
  const restored = { ...waiting, continuation: reorder(waiting.continuation) };
  const result = await f.run(restart(host, restored, { text: "回答" }), {}, reorder(task));
  assert.equal(result.result.answer, "完成");
});

test("multi-Agent approval fails before invoking any write tool", async () => {
  let writes = 0;
  const write = managedWrite("multi_write", 43, async () => { writes++; return { success: true, content: "saved" }; });
  const f = nativeChat({ tools: [write], respond: () => ({ content: "", toolCalls: [{ id: "m-write", name: "multi_write", arguments: { value: 1 } }] }) });
  const multi = { ...f.snapshot, agents: new Map([...f.snapshot.agents, [2, { ...f.snapshot.agents.get(1), version: { ...f.snapshot.agents.get(1).version, id: 2 } }]]) };
  await assert.rejects(f.execution.runTask(multi, task,
    { runId: "multi-write", traceId: "multi-write", interactionHost: { threadId: "multi-write", checkpointer: new MemorySaver() } }), /interaction_mode_unsupported/);
  assert.equal(writes, 0);
});

test("a question tool configured for approval reviews before asking and resumes both native interrupts", async () => {
  const base = new AskUserTool();
  const managed = makeManagedTool({ id: 51, key: "guided_question", config: {
    type: "builtin", target: "ask_user", description: "询问信息", parameters: base.parameters,
    readOnly: false, requiresApproval: true, timeoutMs: 1000, maxRetries: 0,
  } }, () => base);
  const f = fixture((_request, index) => index === 1 ? calls(["approved-question", "guided_question", question]) : final(), [managed]);
  const host = { threadId: "approval-question", checkpointer: new MemorySaver() };
  const approval = await suspend(f.run(host));
  assert.equal(approval.request.kind, "approval");
  const askingHost = resume(host, approval, { decision: "approve" });
  const asking = await suspend(f.run(askingHost));
  assert.equal(asking.request.kind, "question");
  const result = await f.run(resume(askingHost, asking, { text: "回答" }));
  assert.equal(result.result.answer, "完成");
  assert.equal(f.requests.length, 2);
});

test("restored knowledge is reauthorized before the model and deleted documents never reach resume", async () => {
  let reads = 0;
  const read = { name: "read_evidence", description: "Read evidence", inputSchema: z.object({}).strict(),
    contributeContext: knowledgeResources,
    execute: async () => { reads++; return { success: true, content: "Evidence", data: { hits: [{
      chunkId: 5, documentId: 4, documentTitle: "Reference", originalFilename: "ref.txt",
      headingPath: "", content: "Private document", sourceStartLine: 1, sourceEndLine: 2,
      score: 1, knowledgeBaseId: 2, indexKind: "published", indexVersionId: 3,
    }] } }; } };
  const f = nativeChat({ tools: [read, new AskUserTool()], knowledge: [{ id: 2, indexVersionId: 3 }],
    respond: (_request, index) => index === 1 ? { content: "", toolCalls: [{ id: "read", name: "read_evidence", arguments: {} }] }
      : index === 2 ? { content: "", toolCalls: [{ id: "ask", name: "ask_user", arguments: question }] }
        : assert.fail("Revoked evidence must not enter a resumed model") });
  const host = { threadId: "revoke-document", checkpointer: new MemorySaver() };
  const context = { runId: "revoke-run", traceId: "revoke-trace", interactionHost: host };
  const waiting = await suspend(f.execution.runTask(f.snapshot, task, context));
  const resumed = { ...context, interactionHost: restart(host, waiting, { text: "继续" }) };
  await assert.rejects(f.execution.runTask(f.snapshot, task, resumed), /current authorization validator/);
  let validations = 0;
  await assert.rejects(f.execution.runTask(f.snapshot, task, { ...resumed,
    validateDocument: async (reference) => { validations++; assert.equal(reference.id, "4"); throw new Error("Document was revoked"); } }), /revoked/);
  assert.equal(validations, 1);
  assert.equal(reads, 1);
  assert.equal(f.requests.length, 2);
});
