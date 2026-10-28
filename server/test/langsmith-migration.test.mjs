import "reflect-metadata";
import { ConversationService } from "../dist/chat/conversation.service.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  TestExecutionTracer,
  collectOtlpSpans,
} from "./helpers/trace-collector.mjs";
import {
  LangSmithExecutionTracer,
  frameworkTracing,
  safeTraceSnapshot,
} from "../dist/observability/execution-tracer.js";
import { normalizeTracingOptions } from "../dist/config/tracing-config.js";
import {
  recordedLangSmithLink,
  LangSmithLinkService,
} from "../dist/observability/langsmith-link.js";
import {
  destinationId,
  langSmithRunId,
} from "../dist/observability/trace-mapping.js";
import {
  executionContextView,
  omitExternalTraceLinks,
} from "../dist/observability/execution-view.js";
import { emptyOtlpResponse } from "./helpers/otlp-wire.mjs";
const options = normalizeTracingOptions({
  enabled: true,
  apiKey: "fixture",
  project: "fixture",
});
const runId = "33333333-3333-4333-8333-333333333333";
const mapping = {
  schemaVersion: 1,
  provider: "langsmith",
  enabled: true,
  traceId: "33333333333343338333333333333333",
  runId,
  destination: destinationId(options),
};
const path =
  "/o/11111111-1111-4111-8111-111111111111/projects/p/22222222-2222-4222-8222-222222222222/r/" +
  runId;

test("explicit project and agent routing use exclusive headers, no ambient headers or SDK destination", async () => {
  for (const target of [
    { project: "fixture" },
    { agentIdentifier: "studio", environment: "production" },
  ]) {
    const requests = [];
    const tracer = new LangSmithExecutionTracer(
      {
        enabled: true,
        apiKey: "fixture",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        ...target,
      },
      async (url, request) => {
        requests.push({ url, headers: request.headers });
        return emptyOtlpResponse();
      },
    );
    try {
      await tracer.span("test", "chain", {}, async () => {});
      await tracer.flush();
      const { headers, url } = requests[0];
      assert.equal(url, "https://api.smith.langchain.com/otel/v1/traces");
      assert.equal(headers["x-api-key"], "fixture");
      assert.equal(
        headers["x-tenant-id"],
        "11111111-1111-4111-8111-111111111111",
      );
      assert.equal(headers["Langsmith-Project"], target.project);
      assert.equal(headers["Langsmith-Agent-Id"], target.agentIdentifier);
      assert.equal(headers["Langsmith-Agent-Environment"], target.environment);
      assert.equal(headers.Authorization, undefined);
    } finally {
      await tracer.close();
    }
  }
  for (const target of [
    { agentIdentifier: "studio" },
    { environment: "production" },
    {
      project: "fixture",
      agentIdentifier: "studio",
      environment: "production",
    },
  ])
    assert.throws(() =>
      normalizeTracingOptions({ enabled: true, apiKey: "fixture", ...target }),
    );
  assert.throws(
    () =>
      normalizeTracingOptions({
        enabled: true,
        apiKey: "PRIVATE_KEY",
        project: "fixture",
        endpoint: "not a URL",
      }),
    (error) => !error.message.includes("PRIVATE_KEY"),
  );
});

test("two turns retain one thread on every span, UUID parent/root/dotted order and body-off safe snapshots", async () => {
  const spans = [],
    tracer = new TestExecutionTracer(
      { enabled: true },
      collectOtlpSpans(spans),
    );
  const conversationId = randomUUID(),
    roots = [];
  try {
    for (let turn = 0; turn < 2; turn++)
      await tracer.span(
        "agent_request",
        "chain",
        {
          conversationId,
          localTraceId: randomUUID(),
          prompt: "PRIVATE_PROMPT",
        },
        async (root) => {
          roots.push(tracer.link(root));
          const capture = frameworkTracing(["graph"]),
            handler = capture.callbacks[0],
            id = randomUUID();
          try {
            await handler.handleChainStart(
              {},
              { message: "PRIVATE_MESSAGE" },
              id,
              undefined,
              [],
              {},
              "chain",
              "graph",
            );
            await tracer.span(
              "model_attempt",
              "llm",
              { totalTokens: 12, arguments: "PRIVATE_ARGUMENT" },
              async (child) => {
                const safe = safeTraceSnapshot({
                  externalTrace: tracer.link(child),
                  messages: ["PRIVATE_MESSAGE"],
                  modelCalls: [{ response: "PRIVATE_RESULT" }],
                });
                assert.equal(safe.externalTrace.rootRunId, roots.at(-1).runId);
                assert.equal(safe.messages, undefined);
                assert.equal(safe.modelCalls, undefined);
              },
            );
            await handler.handleChainEnd({}, id);
          } finally {
            capture.close();
          }
        },
      );
    await tracer.flush();
    assert.equal(new Set(spans.map((s) => s.traceId)).size, 2);
    for (const span of spans) {
      const attrs = span.attributes,
        root = roots.find((r) => r.traceId === span.traceId);
      assert.equal(span.metadata.thread_id, conversationId);
      assert.equal(attrs["langsmith.trace.id"], root.runId);
      assert.equal(
        attrs["langsmith.span.id"],
        langSmithRunId(span.traceId, span.spanId),
      );
      if (span.parentSpanId) {
        const parent = spans.find((s) => s.spanId === span.parentSpanId);
        assert.equal(
          attrs["langsmith.span.parent_id"],
          parent.attributes["langsmith.span.id"],
        );
        assert.ok(
          attrs["langsmith.span.dotted_order"].startsWith(
            parent.attributes["langsmith.span.dotted_order"] + ".",
          ),
        );
      }
    }
    assert.doesNotMatch(
      JSON.stringify(spans),
      /PRIVATE_|input.value|output.value/,
    );
    assert.deepEqual(
      executionContextView({ externalTrace: roots[0] }).externalTrace,
      { sampled: true, provider: "langsmith" },
    );
    assert.deepEqual(
      omitExternalTraceLinks({
        externalTrace: roots[0],
        phoenix: { url: "old" },
        langSmith: { url: "old" },
        status: "ok",
      }),
      { status: "ok" },
    );
  } finally {
    await tracer.close();
  }
});

test("OTLP accepts empty/JSON/protobuf replies and counts partial rejects without changing business results", async () => {
  for (const [response, failed] of [
    [emptyOtlpResponse(), 0],
    [Response.json({}), 0],
    [Response.json({ partialSuccess: { rejectedSpans: 1 } }), 1],
    [
      new Response(Uint8Array.from([10, 2, 8, 1]), {
        headers: { "content-type": "application/x-protobuf" },
      }),
      1,
    ],
  ]) {
    const tracer = new TestExecutionTracer(
      { enabled: true },
      async () => response,
    );
    try {
      assert.equal(await tracer.span("test", "chain", {}, async () => 42), 42);
      await tracer.flush();
      assert.equal(tracer.metrics.failed, failed);
      assert.equal(tracer.metrics.exported, 1 - failed);
    } finally {
      await tracer.close();
    }
  }
});

test("link lookup distinguishes permissions/ingestion, pins IDs and destination, never trusts stored URLs", async () => {
  let calls = 0;
  const fetcher = async (url, request) => {
    calls++;
    assert.equal(url, options.endpoint + "/runs/" + runId);
    assert.equal(request.headers["x-api-key"], "fixture");
    return Response.json({
      id: runId,
      app_path: path,
      inputs: { secret: "PRIVATE" },
    });
  };
  assert.equal(
    (
      await recordedLangSmithLink(
        { ...mapping, url: "https://evil.invalid" },
        options,
        fetcher,
      )
    ).url,
    "https://smith.langchain.com" + path,
  );
  assert.equal(calls, 1);
  const cloudPath = await recordedLangSmithLink(mapping, options, async () =>
    Response.json({
      id: runId,
      app_path:
        path + "?trace_id=" + runId + "&start_time=2026-10-28T04:37:17.401000",
    }),
  );
  assert.equal(cloudPath.url, "https://smith.langchain.com" + path);
  assert.equal(cloudPath.ingestion, "confirmed");
  for (const [status, reason] of [
    [401, "invalid_credentials"],
    [429, "rate_limited"],
    [403, "read_permission_required"],
    [404, "not_ingested"],
    [500, "lookup_failed"],
  ])
    assert.equal(
      (
        await recordedLangSmithLink(
          mapping,
          options,
          async () => new Response(null, { status }),
        )
      ).reason,
      reason,
    );
  assert.equal(
    (
      await recordedLangSmithLink(mapping, options, async () => {
        throw new DOMException("PRIVATE_RESPONSE", "TimeoutError");
      })
    ).reason,
    "lookup_timeout",
  );
  for (const body of [
    { id: runId, app_path: "https://evil.invalid" },
    { id: randomUUID(), app_path: path },
    { id: runId, app_path: path + "?secret=PRIVATE" },
    { id: runId, app_path: path + "?trace_id=invalid" },
    { id: runId, app_path: path + "?start_time=invalid" },
  ])
    assert.equal(
      (
        await recordedLangSmithLink(mapping, options, async () =>
          Response.json(body),
        )
      ).available,
      false,
    );
  assert.equal(
    (
      await recordedLangSmithLink(
        mapping,
        { ...options, project: "other" },
        () => assert.fail("must not fetch"),
      )
    ).reason,
    "destination_changed",
  );
  assert.equal(
    (
      await recordedLangSmithLink(
        { enabled: true, project: "old", url: "old" },
        options,
        fetcher,
      )
    ).reason,
    "historical_or_missing",
  );
  assert.equal(
    (await recordedLangSmithLink(mapping, { enabled: false }, fetcher)).reason,
    "disabled",
  );
});

test("successful admin links survive short cloud outages and failed lookups can recover on refresh", async (t) => {
  let now = Date.now(),
    calls = 0,
    rateLimited = false;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return rateLimited
      ? new Response(null, { status: 429 })
      : Response.json({ id: runId, app_path: path });
  });
  const service = new LangSmithLinkService({ tracing: options });
  const first = service.resolve(mapping);
  assert.equal(service.resolve(mapping), first);
  assert.equal((await first).available, true);
  now += 11000;
  rateLimited = true;
  assert.equal((await service.resolve(mapping)).available, true);
  assert.equal(calls, 1);
  now += 300000;
  assert.equal((await service.resolve(mapping)).reason, "rate_limited");
  rateLimited = false;
  assert.equal((await service.resolve(mapping)).reason, "rate_limited");
  assert.equal(calls, 2);
  now += 2001;
  assert.equal((await service.resolve(mapping)).available, true);
  assert.equal(calls, 3);
});

test("adding UI/project navigation hints preserves the original exporter destination", async () => {
  const hints = {
    ...options,
    webUrl: "https://eu.smith.langchain.com",
    projectId: "22222222-2222-4222-8222-222222222222",
  };
  assert.equal(destinationId(hints), destinationId(options));
  assert.equal(
    destinationId({ ...options, apiKey: "rotated" }),
    destinationId(options),
  );
  assert.notEqual(
    destinationId({ ...options, project: "other" }),
    destinationId(options),
  );
});

test("body-disabled local Trace persistence retains only the safe external identity", async () => {
  const writes = [],
    service = Object.create(ConversationService.prototype);
  service.database = {
    query: async (sql, values) => writes.push({ sql, values }),
  };
  service.recordingPolicy = {
    current: async () => ({
      traceEnabled: true,
      conversationContentEnabled: false,
      usageEnabled: false,
    }),
  };
  await service.recordTrace({
    id: randomUUID(),
    conversationId: randomUUID(),
    userMessageId: null,
    question: "PRIVATE_QUESTION",
    contextSnapshot: {
      externalTrace: {
        ...mapping,
        apiKey: "PRIVATE_KEY",
        url: "https://evil.invalid",
      },
      messages: ["PRIVATE_MESSAGE"],
    },
    model: null,
    rawModelOutput: "PRIVATE_OUTPUT",
    finalAnswer: "PRIVATE_ANSWER",
    refused: null,
    status: "failed",
    errorCode: "answer_failed",
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    durationMs: 4,
  });
  assert.equal(writes.length, 1);
  const saved = JSON.parse(writes[0].values[4]);
  assert.deepEqual(saved.externalTrace, mapping);
  assert.doesNotMatch(JSON.stringify(writes), /PRIVATE_|evil.invalid/);
  assert.deepEqual(writes[0].values.slice(11, 14), [null, null, null]);
});

test("ambient OTEL sampler and attribute limits cannot silently disable or corrupt private trace IDs", async () => {
  const keys = [
      "OTEL_TRACES_SAMPLER",
      "OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT",
      "OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT",
    ],
    old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.OTEL_TRACES_SAMPLER = "always_off";
  process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT = "1";
  process.env.OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT = "1";
  const spans = [],
    tracer = new TestExecutionTracer(
      { enabled: true },
      collectOtlpSpans(spans),
    );
  try {
    await tracer.span(
      "root",
      "chain",
      { conversationId: "thread-fixture" },
      async () => {},
    );
    await tracer.flush();
    assert.equal(spans.length, 1);
    assert.match(spans[0].attributes["langsmith.span.id"], /^[a-f0-9-]{36}$/);
    assert.equal(spans[0].metadata.thread_id, "thread-fixture");
  } finally {
    await tracer.close();
    for (const key of keys)
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
  }
});
