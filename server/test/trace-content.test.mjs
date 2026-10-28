import assert from "node:assert/strict";
import test from "node:test";
import { TestExecutionTracer, collectOtlpSpans } from "./helpers/trace-collector.mjs";
import { annotateTraceContent } from "../dist/observability/execution-tracer.js";
import { traceContentValue, traceModelRequest } from "../dist/observability/trace-content.js";
import { LlmService } from "../dist/chat/llm.service.js";

test("content fields are absent by default and separately enabled for LangSmith", async () => {
  const disabledSpans = [];
  const disabled = new TestExecutionTracer({ enabled: true }, collectOtlpSpans(disabledSpans));
  await disabled.span("default", "chain", {}, async () => {
    annotateTraceContent({ input: { question: "PRIVATE_USER" }, output: "PRIVATE_ANSWER" });
  });
  await disabled.flush();
  assert.equal(disabledSpans[0].attributes["input.value"], undefined);
  assert.equal(disabledSpans[0].attributes["output.value"], undefined);
  await disabled.close();

  const spans = [];
  const enabled = new TestExecutionTracer({ enabled: true, contentEnabled: true }, collectOtlpSpans(spans));
  const longPrompt = "SYSTEM_PROMPT_" + "x".repeat(20_000) + "_PROMPT_END";
  await enabled.span("content", "llm", {}, async () => {
    annotateTraceContent({
      input: traceModelRequest({
        model: "fixture",
        messages: [
          { role: "system", content: longPrompt },
          { role: "user", content: "question with sk-123456789012345678901234" },
        ],
      }),
      output: {
        answer: "answer",
        apiKey: "must-not-escape",
        credentials: { authorization: "Bearer PRIVATE_ACCESS_TOKEN" },
      },
    });
  });
  await enabled.flush();
  const input = spans[0].attributes["input.value"];
  const output = spans[0].attributes["output.value"];
  assert.match(input, /SYSTEM_PROMPT/);
  assert.match(input, /_PROMPT_END/);
  assert.doesNotMatch(input, /sk-123456789012345678901234/);
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotMatch(output, /must-not-escape|PRIVATE_ACCESS_TOKEN/);
  await enabled.close();
});

test("long content remains intact within the configured OTEL field capacity", () => {
  const text = "a".repeat(30_000) + "LONG_CONTENT_END";
  const value = traceContentValue(text);
  assert.match(value, /LONG_CONTENT_END/);
  assert.equal(JSON.parse(value).length, text.length);
});

test("real model attempts export their request and response only in content mode", async () => {
  const spans = [];
  const tracer = new TestExecutionTracer(
    { enabled: true, contentEnabled: true },
    collectOtlpSpans(spans),
  );
  const llm = new LlmService({
    model: "fixture",
    chat: async () => ({
      content: "MODEL_REPLY",
      toolCalls: [],
      model: "fixture",
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      finishReason: "stop",
    }),
  });
  try {
    await tracer.span("agent_request", "chain", {}, async () =>
      llm.completeDetailed(
        "SYSTEM_PROMPT_BODY",
        "USER_MESSAGE_BODY",
        "fixture",
        "answer",
      ),
    );
    await tracer.flush();
    const modelSpan = spans.find((span) => span.name === "model_attempt");
    assert.ok(modelSpan);
    assert.match(modelSpan.attributes["input.value"], /SYSTEM_PROMPT_BODY/);
    assert.match(modelSpan.attributes["input.value"], /USER_MESSAGE_BODY/);
    assert.match(modelSpan.attributes["output.value"], /MODEL_REPLY/);
  } finally {
    await tracer.close();
  }
});
