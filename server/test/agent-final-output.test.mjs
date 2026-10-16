import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { nativeChat } from "./helpers/native-chat.mjs";
import { z } from "zod";
import { IncrementalFinalAnswer } from "../dist/ai/agent/incremental-final-answer.js";
import { PromptRuntimeService } from "../dist/prompts/prompt-runtime.service.js";
import { ManagedRuntimeProvider } from "../dist/model-management/model-route.js";

const final = (answer, extra = {}) =>
  JSON.stringify({
    type: "final",
    status: "answered",
    answer,
    citationIds: [],
    productIds: [],
    ...extra,
  });
function fixture(replies) {
  let executions = 0;
  const tool = {
    name: "search_knowledge",
    description: "Read",
    inputSchema: z.object({ query: z.string() }),
    execute: async () => {
      executions++;
      return { success: true, content: "资料", data: { hits: [] } };
    },
  };
  const host = nativeChat({ tools: [tool], respond: () => replies.shift() });
  const { runner, orchestrator } = host;
  return {
    runner,
    orchestrator,
    get calls() {
      return host.requests.length;
    },
    get executions() {
      return executions;
    },
    get finished() {
      return host.finished;
    },
  };
}

test("JSON and SSE use one decision; delivered answer, transcript and trace agree", async () => {
  const raw = "你好😀\n欢迎咨询";
  const plain = fixture([{ content: raw }]);
  const json = await plain.orchestrator.askDetailed("你好", [], "");
  const streamed = fixture([{ content: raw }]),
    events = [];
  const sse = await streamed.orchestrator.askDetailed(
    "你好",
    [],
    "",
    undefined,
    undefined,
    undefined,
    undefined,
    {
      onAnswerStarted: (m) => events.push(["started", m]),
      onAnswerDelta: (text) => {
        assert.equal(
          streamed.finished,
          false,
          "Answer must arrive before the provider completes",
        );
        events.push(["delta", text]);
      },
    },
  );
  assert.equal(plain.calls, 1);
  assert.equal(streamed.calls, 1);
  const answer = events
    .filter((e) => e[0] === "delta")
    .map((e) => e[1])
    .join("");
  assert.equal(answer, json.result.answer);
  assert.equal(answer, sse.result.answer);
  assert.equal(sse.contextSnapshot.agentTranscript.at(-1).content, answer);
  assert.equal(sse.contextSnapshot.modelCalls.length, 1);
  assert.equal(sse.contextSnapshot.executionEngine, "deepagents");
  assert.equal(sse.contextSnapshot.answerDelivery.source, "agent_loop");
  assert.equal(sse.contextSnapshot.answerDelivery.mode, "live");
  assert.equal(events[0][0], "started");
});

test("one native tool round plus final answer needs two calls, never a third", async () => {
  const f = fixture([
    {
      content: '{"commentary":"正在查询资料"}',
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call-1",
          name: "search_knowledge",
          arguments: { query: "资料" },
        },
      ],
    },
    { content: final("资料查询完成。") },
  ]);
  const deltas = [];
  const result = await f.orchestrator.askDetailed(
    "查资料",
    [],
    "",
    undefined,
    undefined,
    undefined,
    undefined,
    { onAnswerDelta: (t) => deltas.push(t) },
  );
  assert.equal(f.calls, 2);
  assert.equal(f.executions, 1);
  assert.equal(deltas.join(""), result.result.answer);
  assert.ok(
    result.contextSnapshot.modelCalls.every((c) => c.purpose === "planner"),
  );
});

test("business refusals are successful results, not rewritten or hidden from SSE", async () => {
  const f = fixture([
      { content: final("需要你提供订单信息。", { status: "refused" }) },
    ]),
    deltas = [];
  const result = await f.orchestrator.askDetailed(
    "查询订单",
    [],
    "",
    undefined,
    undefined,
    undefined,
    undefined,
    { onAnswerDelta: (t) => deltas.push(t) },
  );
  assert.equal(result.result.refused, true);
  assert.equal(f.calls, 1);
  assert.equal(deltas.join(""), result.result.answer);
});

test("invalid/truncated native output fails without another model call or exposing structured wire content", async () => {
  for (const reply of [
    { content: '{"type":"final","answer":"partial' },
    { content: "partial", finishReason: "length" },
    { content: "filtered", finishReason: "content_filter" },
  ]) {
    const f = fixture([reply]),
      events = [];
    let context;
    const expected =
      reply.finishReason === "length"
        ? "model_output_truncated"
        : reply.finishReason === "content_filter"
          ? "model_content_filtered"
          : "model_protocol_error";
    await assert.rejects(
      f.orchestrator.askDetailed(
        "问题",
        [],
        "",
        (value) => {
          context = value;
        },
        undefined,
        undefined,
        undefined,
        {
          onAnswerStarted: () => events.push("start"),
          onAnswerDelta: (t) => events.push(t),
        },
      ),
      (e) => e.getResponse().code === expected,
    );
    if (reply.content.startsWith("{")) assert.deepEqual(events, []);
    else {
      assert.equal(events[0], "start");
      assert.equal(events.slice(1).join(""), reply.content);
      assert.equal(context.answerStreamStatus, "interrupted");
    }
    assert.doesNotMatch(JSON.stringify(events), /"type"|citationIds/);
    assert.equal(f.calls, 1);
  }
});

test("generic native answers do not assume product semantics or trust arbitrary restored product bodies", async () => {
  const f = fixture([{ content: final("结果 PRIVATE_ID  已确认。") }]);
  const input = {
    question: "问题",
    summary: "",
    recentHistory: [],
    restoredContext: {
      products: [{ id: "PRIVATE_ID", name: "产品" }],
      evidence: [],
    },
  };
  const result = await f.runner.run(input);
  assert.ok(result.result.answer.includes("PRIVATE_ID"));
  assert.equal(result.contextSnapshot.products, undefined);
  assert.equal(result.answerSegments.join(""), result.result.answer);
});

test("internal templates are never queried and snapshots contain no fake planner/answer versions", async () => {
  const runtime = new PromptRuntimeService({
    active: () => {
      throw new Error("Internal key was queried");
    },
  });
  const snapshot = await runtime.snapshot("dev", {
    query: () => {
      throw new Error("Unexpected database query");
    },
  });
  assert.deepEqual(snapshot.prompts, {});
  assert.ok(Object.isFrozen(snapshot));
  assert.deepEqual(runtime.metadata(snapshot), {});
});

test("primary and backups share at most four attempts and retain an opportunity for fallback", async () => {
  const provider = new ManagedRuntimeProvider({}, () => ({
    model: "fallback",
  }));
  const version = {
    id: 1,
    config: {
      deployments: [1, 2].map((id) => ({
        id,
        config: { model: "fixture", maxRetries: 3 },
      })),
    },
  };
  await provider.withPlanVersion(version, async () => {
    const schedule = provider.attemptPlan();
    assert.equal(schedule.length, 4);
    assert.deepEqual(
      schedule.map((s) => s.deploymentId),
      [1, 1, 1, 2],
    );
    assert.deepEqual(
      provider.attemptPlan(0).map((s) => s.deploymentId),
      [1, 2],
    );
  });
});

test("cancelled delivery never regenerates or records a completed answer stream", async () => {
  const f = fixture([{ content: final("取消测试") }]),
    controller = new AbortController();
  let context;
  await assert.rejects(
    f.orchestrator.askDetailed(
      "问题",
      [],
      "",
      (value) => {
        context = value;
      },
      undefined,
      undefined,
      undefined,
      {
        onAnswerDelta: () =>
          controller.abort(new Error("visitor disconnected")),
      },
      { signal: controller.signal },
    ),
    (error) => error.getResponse().code === "run_cancelled",
  );
  assert.equal(f.calls, 1);
  assert.equal(context.answerStreamStatus, "interrupted");
});

test("same-response answer extraction handles every split, escapes, nesting, key order and surrogates", () => {
  const text = '中文😀\n"引用"\\路径';
  for (const raw of [
    final(text),
    JSON.stringify({
      citationIds: [],
      productIds: [],
      answer: text,
      status: "answered",
      type: "final",
    }),
  ]) {
    for (let split = 0; split <= raw.length; split++) {
      const decoder = new IncrementalFinalAnswer();
      const chunks = [
        decoder.push(raw.slice(0, split)),
        decoder.push(raw.slice(split)),
      ];
      assert.equal(chunks.join(""), text);
      assert.equal(decoder.validEnd, true);
      for (const chunk of chunks) assert.ok(!/[\ud800-\udbff]$/u.test(chunk));
    }
  }
  const decoder = new IncrementalFinalAnswer();
  assert.equal(
    decoder.push('{"nested":{"answer":"PRIVATE"},"answer":"public"}'),
    "public",
  );
  const escaped = new IncrementalFinalAnswer();
  assert.equal(
    escaped.push('{"answer":"\\u4e2d\\u6587\\ud83d\\ude00"}'),
    "中文😀",
  );
  const duplicate = new IncrementalFinalAnswer();
  duplicate.push('{"answer":"a","answer":"b"}');
  assert.equal(duplicate.validEnd, false);
});

test("live answer arrives while the provider promise is still pending, then completes without replay", async () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture([{ content: "实时😀回复", wait }]);
  const deltas = [];
  const run = f.orchestrator.askDetailed(
    "你好",
    [],
    "",
    undefined,
    undefined,
    undefined,
    undefined,
    {
      onAnswerDelta: (text) => deltas.push(text),
    },
  );
  // Let the async runtime reach the stream callback, without resolving the model.
  for (let n = 0; n < 100 && deltas.join("") !== "实时😀回复"; n++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.finished, false);
  assert.equal(deltas.join(""), "实时😀回复");
  const count = deltas.length;
  release();
  const result = await run;
  assert.equal(
    deltas.length,
    count,
    "The completed answer must not be replayed",
  );
  assert.equal(result.result.answer, deltas.join(""));
  assert.equal(f.calls, 1);
});

test("live normalized answer replaces the provisional body and keeps transcript canonical", async () => {
  const f = fixture([{ content: final("  原始  内容  ") }]);
  let body = "";
  const resets = [];
  const result = await f.orchestrator.askDetailed(
    "你好",
    [],
    "",
    undefined,
    undefined,
    undefined,
    undefined,
    {
      onAnswerDelta: (text) => {
        body += text;
      },
      onAnswerReset: (text) => {
        body = text;
        resets.push(text);
      },
    },
  );
  assert.deepEqual(resets, []);
  assert.equal(body, "原始  内容");
  assert.equal(body, result.result.answer);
  assert.equal(result.contextSnapshot.agentTranscript.at(-1).content, body);
  assert.equal(f.calls, 1);
});

test("a provisional answer in a native tool round is reset before the final model round", async () => {
  const f = fixture([
    {
      content: "不是最终正文",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call-reset",
          name: "search_knowledge",
          arguments: { query: "资料" },
        },
      ],
    },
    { content: "最终正文" },
  ]);
  let body = "";
  const resets = [];
  let starts = 0;
  const result = await f.orchestrator.askDetailed(
    "查询",
    [],
    "",
    undefined,
    undefined,
    undefined,
    undefined,
    {
      onAnswerStarted: () => {
        starts++;
      },
      onAnswerDelta: (text) => {
        body += text;
      },
      onAnswerReset: (text) => {
        body = text;
        resets.push(text);
      },
    },
  );
  assert.deepEqual(resets, [""]);
  assert.equal(body, "最终正文");
  assert.equal(body, result.result.answer);
  assert.equal(starts, 1);
  assert.equal(f.calls, 2);
  assert.equal(f.executions, 1);
});
