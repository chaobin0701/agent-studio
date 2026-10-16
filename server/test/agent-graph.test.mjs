import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { nativeChat } from "./helpers/native-chat.mjs";
import { assertSerializable } from "../dist/ai/agent/execution-contract.js";
import { DEFAULT_AGENT_CONFIGURATION } from "../dist/config/agent-config.js";
import { ProviderAuthenticationError } from "../dist/ai/providers/provider-errors.js";

const input = { question: "General task", summary: "", recentHistory: [] };
const call = (id, name, args = {}) => ({ id, name, arguments: args });
const calls = (actions) => ({ content: "", toolCalls: actions });

test("resource-free execution uses real Deep Agents/LangGraph and a generic final contract, not a custom graph adapter", async () => {
  const f = nativeChat({ respond: () => ({ content: "Hello" }) });
  const result = await f.runner.run(input);
  assert.equal(f.requests.length, 1);
  assert.equal(result.output.answer, "Hello");
  assert.equal(result.contextSnapshot.executionEngine, "deepagents");
  assert.deepEqual(result.contextSnapshot.graphNodes, ["model", "finalize"]);
  assert.doesNotMatch(
    JSON.stringify(result.output),
    /product|customer|knowledge|citations/iu,
  );
  assertSerializable(result.output);
});

test("native batch routing retains exact call pairs and serializable output with no second answer model", async () => {
  const executed = [];
  const tool = {
    name: "read",
    description: "Read",
    inputSchema: z.object({ item: z.number() }),
    execute: async (args) => {
      executed.push(args.item);
      return { success: true, content: `Item ${args.item}` };
    },
  };
  const f = nativeChat({
    tools: [tool],
    respond: (request, round) =>
      round === 1
        ? calls([
            call("one", "read", { item: 1 }),
            call("two", "read", { item: 2 }),
          ])
        : (() => {
            assert.deepEqual(
              request.messages
                .filter((message) => message.role === "tool")
                .map((message) => message.toolCallId),
              ["one", "two"],
            );
            return { content: "Done" };
          })(),
  });
  const result = await f.runner.run(input);
  assert.deepEqual(executed, [1, 2]);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(result.contextSnapshot.graphNodes, [
    "model",
    "tools",
    "tools",
    "model",
    "finalize",
  ]);
  assertSerializable(result.output);
  assert.deepEqual(JSON.parse(JSON.stringify(result.output)), result.output);
});

test("native decision cap stops before a third model and does not add retries to failed write capabilities", async () => {
  const configuration = structuredClone(DEFAULT_AGENT_CONFIGURATION);
  configuration.runtime.maxPlannerRounds = 2;
  let writes = 0;
  const tool = {
    name: "write",
    description: "Write",
    planning: { isIdempotent: false, canBatch: true },
    runtimeLimits: { maxRetries: 0 },
    inputSchema: z.object({ n: z.number() }),
    execute: async () => {
      writes++;
      return {
        success: false,
        content: "Unavailable",
        errorCode: "tool_timeout",
      };
    },
  };
  const f = nativeChat({
    configuration,
    tools: [tool],
    respond: (_request, round) =>
      calls([call(`write-${round}`, "write", { n: round })]),
  });
  await assert.rejects(
    f.runner.run(input),
    (error) => error.code === "agent_budget_exceeded",
  );
  assert.equal(f.requests.length, 2);
  assert.equal(writes, 2);
});

test("native execution errors do not invoke a legacy engine or SDK repair; provider retry authority stays in LlmService", async () => {
  const f = nativeChat({
    respond: () => {
      throw new ProviderAuthenticationError(401);
    },
  });
  await assert.rejects(
    f.runner.run(input),
    (error) => error.errorCode === "provider_authentication",
  );
  assert.equal(f.requests.length, 1);
});

test("caller cancellation reaches the active native provider and prevents finalization", async () => {
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = nativeChat({
    respond: async (request) => {
      entered();
      await new Promise((_, reject) =>
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
      assert.fail("Must not complete");
    },
  });
  const pending = f.runner.run({ ...input, signal: controller.signal });
  await started;
  controller.abort(Error("caller cancelled"));
  await assert.rejects(pending, /cancelled|abort/iu);
  assert.equal(f.requests.length, 1);
});

test("native task deadline bounds a pending provider without custom graph timers or retries", async () => {
  const f = nativeChat({
    respond: async (request) => {
      await new Promise((_, reject) =>
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
      assert.fail("Deadline must terminate");
    },
  });
  const pending = f.execution.runTask(
    f.snapshot,
    {
      messages: [],
      task: "Task",
      versions: {},
      limits: { maxDecisions: 2, maxToolCalls: 0, maxDurationMs: 30 },
    },
    { runId: "deadline-native", traceId: "deadline-native" },
  );
  const hold = setTimeout(() => {}, 200);
  try {
    await assert.rejects(pending, (error) => error.code === "agent_timeout");
    assert.equal(f.requests.length, 1);
  } finally {
    clearTimeout(hold);
  }
});

test("concurrent calls on one native service retain separate user contexts, budgets and pinned published versions", async () => {
  const f = nativeChat({
    respond: async (request) => {
      await new Promise(setImmediate);
      return {
        content: request.messages
          .filter((message) => message.role === "user")
          .at(-1).content,
      };
    },
  });
  const [a, b] = await Promise.all([
    f.runner.run({ ...input, question: "OWN_A" }),
    f.runner.run({ ...input, question: "OWN_B" }),
  ]);
  assert.equal(a.output.answer, "OWN_A");
  assert.equal(b.output.answer, "OWN_B");
  assert.equal(a.contextSnapshot.executionInput.versions.agentVersionId, 1);
  assert.equal(b.contextSnapshot.executionInput.versions.agentVersionId, 1);
  assert.equal(a.contextSnapshot.executionBudget.modelCalls, 1);
  assert.equal(b.contextSnapshot.executionBudget.modelCalls, 1);
  assert.notEqual(a.contextSnapshot, b.contextSnapshot);
});

test("native JSON contracts reject services, Maps, signals, functions and cycles before model admission", async () => {
  for (const value of [
    new Map(),
    new Set(),
    new AbortController().signal,
    () => {},
    new Date(),
  ])
    assert.throws(() => assertSerializable(value), TypeError);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => assertSerializable(cycle), TypeError);
  const f = nativeChat({
    respond: () => assert.fail("Non-JSON input must not reach the model"),
  });
  await assert.rejects(
    f.execution.runTask(
      f.snapshot,
      {
        messages: [],
        task: "Task",
        versions: { service: new Map() },
        limits: { maxDecisions: 2, maxToolCalls: 0 },
      },
      { runId: "invalid", traceId: "invalid" },
    ),
    TypeError,
  );
  assert.equal(f.requests.length, 0);
});

test("untrusted collection-shaped arguments remain literal JSON, not revived runtime Sets or maps", async () => {
  const marker = { __platformCollection: "set", entries: ["untrusted"] };
  let executed = 0;
  const tool = {
    name: "read",
    description: "Read",
    inputSchema: z.object({ marker: z.record(z.string(), z.unknown()) }),
    execute: async (args) => {
      executed++;
      assert.deepEqual(args.marker, marker);
      assert.equal(args.marker instanceof Set, false);
      return { success: true, content: "Read" };
    },
  };
  const f = nativeChat({
    tools: [tool],
    respond: (request, round) =>
      round === 1
        ? calls([call("read-1", "read", { marker })])
        : (() => {
            assert.deepEqual(
              request.messages.find((message) => message.toolCalls)
                ?.toolCalls[0].arguments.marker,
              marker,
            );
            return { content: "Done" };
          })(),
  });
  const result = await f.runner.run(input);
  assert.equal(executed, 1);
  assert.equal(result.output.answer, "Done");
});
