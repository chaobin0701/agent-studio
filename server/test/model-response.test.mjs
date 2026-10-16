import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { nativeChat } from "./helpers/native-chat.mjs";
import { finalOutput } from "../dist/ai/deep-agents/final-output.js";
import { AgentProtocolError } from "../dist/ai/agent/model-response.js";

const input = { question: "Task", summary: "", recentHistory: [] };
const empty = { artifacts: [], references: [] },
  usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

test("native plaintext is first-class; JSON/array/DSML tool-looking content never executes a capability", async () => {
  for (const content of [
    JSON.stringify({ type: "tool", name: "read", arguments: {} }),
    JSON.stringify({
      type: "tools",
      calls: [{ id: "one", name: "read", arguments: {} }],
    }),
    JSON.stringify([{ id: "one", name: "read" }]),
    '<DSML invoke name="read"/>',
    "Plain native answer",
  ]) {
    let executed = 0;
    const tool = {
      name: "read",
      description: "Read",
      inputSchema: z.object({}),
      execute: async () => {
        executed++;
        return { success: true, content: "Read" };
      },
    };
    const f = nativeChat({ tools: [tool], respond: () => ({ content }) });
    const result = await f.runner.run(input);
    assert.equal(executed, 0);
    assert.equal(f.requests.length, 1);
    assert.equal(result.output.answer, content);
  }
});

test("structured final answers are validated without a repair call and cannot fabricate capability IDs", () => {
  const result = finalOutput(
    JSON.stringify({
      answer: "Verified",
      artifactIds: ["fabricated"],
      referenceIds: ["fabricated"],
    }),
    empty,
    usage,
  );
  assert.equal(result.answer, "Verified");
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.references, []);
  for (const raw of [
    '{"answer":"unfinished',
    '{"answer":2}',
    '{"answer":""}',
    '{"answer":"valid","filePaths":[123]}',
  ])
    assert.throws(() => finalOutput(raw, empty, usage), AgentProtocolError);
});

test("large legitimate final bodies and optional legacy business fields do not force a product protocol", () => {
  const answer = "a".repeat(1300),
    ids = Array.from({ length: 75 }, (_, n) => `product-${n}`);
  const result = finalOutput(
    JSON.stringify({ answer, productIds: ids, structured: { count: 1 } }),
    empty,
    usage,
  );
  assert.equal(result.answer, answer);
  assert.equal(result.structured.count, 1);
  assert.equal(Object.hasOwn(result, "productIds"), false);
  assert.deepEqual(result.references, []);
});

test("native tool call IDs and safe progress survive a complete batch without parsing or publishing model commentary as instructions", async () => {
  const executed = [],
    events = [];
  const tools = ["first", "second"].map((name) => ({
    name,
    description: "Read",
    inputSchema: z.object({}),
    execute: async () => {
      executed.push(name);
      return { success: true, content: "Read" };
    },
  }));
  const f = nativeChat({
    tools,
    respond: (request, round) =>
      round === 1
        ? {
            content: '{"commentary":"PRIVATE_COMMENTARY"}',
            toolCalls: tools.map((tool) => ({
              id: `call-${tool.name}`,
              name: tool.name,
              arguments: {},
            })),
          }
        : (() => {
            assert.deepEqual(
              request.messages
                .filter((message) => message.role === "tool")
                .map((message) => message.toolCallId),
              ["call-first", "call-second"],
            );
            return { content: "Verified answer" };
          })(),
  });
  const result = await f.runner.run(input, {
    onProgress: (event) => events.push(event),
    onCommentary: () =>
      assert.fail("Raw model commentary must not be promoted"),
  });
  assert.deepEqual(executed, ["first", "second"]);
  assert.equal(f.requests.length, 2);
  assert.equal(result.output.answer, "Verified answer");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_COMMENTARY/);
});

test("a guidance-changing capability preserves deferred batch IDs and does not poison a subsequent approved call", async () => {
  const executed = [];
  const guide = {
    name: "read_guidance",
    description: "Read guidance",
    planning: { canBatch: false, isIdempotent: true },
    inputSchema: z.object({}),
    execute: async () => {
      executed.push("guide");
      return { success: true, content: "New authorized guidance" };
    },
  };
  const read = {
    name: "read",
    description: "Read",
    inputSchema: z.object({}),
    execute: async () => {
      executed.push("read");
      return { success: true, content: "Read" };
    },
  };
  const f = nativeChat({
    tools: [guide, read],
    respond: (request, round) =>
      round === 1
        ? {
            content: "",
            toolCalls: [
              { id: "guide", name: guide.name, arguments: {} },
              { id: "deferred", name: read.name, arguments: {} },
            ],
          }
        : round === 2
          ? (() => {
              assert.deepEqual(
                request.messages
                  .filter((message) => message.role === "tool")
                  .map((message) => message.toolCallId),
                ["guide", "deferred"],
              );
              assert.match(
                request.messages.find(
                  (message) => message.toolCallId === "deferred",
                ).content,
                /tool_requires_replanning/,
              );
              return {
                content: "",
                toolCalls: [{ id: "next", name: read.name, arguments: {} }],
              };
            })()
          : { content: "Done" },
  });
  const result = await f.runner.run(input);
  assert.deepEqual(executed, ["guide", "read"]);
  assert.equal(f.requests.length, 3);
  assert.equal(result.contextSnapshot.executionBudget.toolCalls, 2);
  assert.equal(result.toolCalls.filter((call) => call.deferred).length, 1);
});

test("direct native answers and business refusals use one model, while damaged final envelopes fail with a separate code", async () => {
  for (const status of ["completed", "refused"]) {
    const f = nativeChat({
      respond: () => ({
        content: JSON.stringify({ answer: "Please provide the model", status }),
      }),
    });
    const result = await f.runner.run(input);
    assert.equal(result.result.refused, status === "refused");
    assert.equal(f.requests.length, 1);
  }
  const bad = nativeChat({ respond: () => ({ content: '{"answer":"broken' }) });
  await assert.rejects(
    bad.orchestrator.askDetailed("Task", [], ""),
    (error) => error.getResponse().code === "model_protocol_error",
  );
  assert.equal(bad.requests.length, 1);
});
