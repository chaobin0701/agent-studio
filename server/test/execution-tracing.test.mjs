import { TestExecutionTracer } from "./helpers/trace-collector.mjs";
import {
  decodeOtlpRequest,
  emptyOtlpResponse,
} from "./helpers/otlp-wire.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import {
  safeTraceMetadata,
  executionSpan,
} from "../dist/observability/execution-tracer.js";
import { readTracingEnvironment } from "../dist/config/tracing-config.js";
import { nativeChat } from "./helpers/native-chat.mjs";
import { LlmService } from "../dist/chat/llm.service.js";
import { ProviderUnavailableError } from "../dist/ai/providers/provider-errors.js";
import { ToolExecutionService } from "../dist/ai/tools/tool-execution.js";
import { ToolPolicy } from "../dist/ai/tools/tool-policy.js";
import { InteractionSuspension, InteractionWaiting } from "../dist/interactions/contracts.js";
import { MemorySaver } from "@langchain/langgraph";
import { AskUserTool } from "../dist/ai/tools/ask-user.tool.js";

function collector() {
  const requests = [],
    spans = [];
  const fetcher = async (url, options) => {
    const body = decodeOtlpRequest(options.body);
    requests.push({ url, body });
    for (const resource of body.resourceSpans)
      for (const scope of resource.scopeSpans)
        for (const raw of scope.spans) {
          const attributes = Object.fromEntries(
            raw.attributes.map((a) => [a.key, Object.values(a.value)[0]]),
          );
          spans.push({
            ...raw,
            attributes,
            metadata: JSON.parse(attributes.metadata),
          });
        }
    return emptyOtlpResponse();
  };
  return { requests, spans, fetcher };
}

test("LangSmith config defaults disabled and rejects missing credentials, bad routes and limits", () => {
  assert.equal(readTracingEnvironment({}).enabled, false);
  assert.equal(readTracingEnvironment({}).contentEnabled, false);
  assert.equal(readTracingEnvironment({}).endpoint,"https://api.smith.langchain.com");
  assert.equal(readTracingEnvironment({LANGSMITH_TRACING:"true",PHOENIX_TRACING:"true"}).enabled,false);
  assert.throws(()=>readTracingEnvironment({AGENT_STUDIO_LANGSMITH_ENABLED:"true"}),/apiKey|project/);
  const env={AGENT_STUDIO_LANGSMITH_ENABLED:"true",AGENT_STUDIO_LANGSMITH_API_KEY:"fixture",AGENT_STUDIO_LANGSMITH_PROJECT:"acceptance"};
  assert.equal(readTracingEnvironment(env).enabled,true);
  assert.equal(readTracingEnvironment({...env,AGENT_STUDIO_LANGSMITH_CONTENT_ENABLED:"true"}).contentEnabled,true);
  for (const endpoint of ["http://public.example","https://user:secret@example.com","https://example.com?key=secret","file:///tmp/traces"])
    assert.throws(()=>readTracingEnvironment({...env,AGENT_STUDIO_LANGSMITH_ENDPOINT:endpoint}),/endpoint/);
  for (const [key,value] of [["SAMPLE_RATE","2"],["TIMEOUT_MS","0"],["QUEUE_LIMIT","0"]])
    assert.throws(()=>readTracingEnvironment({...env,["AGENT_STUDIO_LANGSMITH_"+key]:value}));
  const safe = safeTraceMetadata({
    agentVersionId: 12,
    inputTokens: 34,
    modelName: "model-v1",
    question: "PRIVATE_USER",
    prompt: "PRIVATE_PROMPT",
    authorization: "Bearer SECRET",
    apiKey: "SECRET",
    outputs: { private: "CONTENT" },
    errorCode: "SECRET WITH SPACES",
    provider: "sk-secret",
  });
  assert.deepEqual(safe, {
    agentVersionId: 12,
    inputTokens: 34,
    modelName: "model-v1",
  });
});

test("private OTEL provider / OTLP serializer preserves concurrent parents, OpenInference semantics and local IDs without bodies", async () => {
  const c = collector(),
    tracer = new TestExecutionTracer(
      { enabled: true, project: "acceptance" },
      c.fetcher,
    );
  const root = (id) =>
    tracer.span(
      "agent_graph",
      "chain",
      { agentVersionId: id, localRunId: `local-${id}`, prompt: "PRIVATE" },
      async (span) => {
        await tracer.span(
          "model_attempt",
          "llm",
          { attempt: 1, modelName: "fixture" },
          async () => {
            await new Promise((resolve) => setImmediate(resolve));
            tracer.annotate({
              inputTokens: id,
              outputTokens: 1,
              totalTokens: id + 1,
              response: "PRIVATE",
            });
          },
        );
        return span;
      },
    );
  const roots = await Promise.all([root(1), root(2)]);
  await tracer.flush();
  assert.equal(c.spans.length, 4);
  for (const child of c.spans.filter((s) => s.parentSpanId)) {
    const parent = c.spans.find((s) => s.spanId === child.parentSpanId);
    assert.ok(roots.some((s) => s.id === parent.spanId));
    assert.equal(child.traceId, parent.traceId);
    assert.equal(child.metadata.agentVersionId, parent.metadata.agentVersionId);
    assert.equal(child.attributes["openinference.span.kind"], "LLM");
    assert.equal(
      Number(child.attributes["llm.token_count.total"]),
      child.metadata.agentVersionId + 1,
    );
    assert.equal(child.attributes["llm.model_name"], "fixture");
  }
  for (const r of roots) {
    assert.match(r.id, /^[a-f0-9]{16}$/);
    assert.match(r.traceId, /^[a-f0-9]{32}$/);
    assert.equal(tracer.link(r).provider, "langsmith");
    assert.match(tracer.link(r).runId, /^[a-f0-9-]{36}$/);
  }
  assert.equal(c.requests[0].url, "https://api.smith.langchain.com/otel/v1/traces");
  assert.equal(
    c.requests[0].body.resourceSpans[0].resource.attributes.find(
      (a) => a.key === "openinference.project.name",
    ).value.stringValue,
    "acceptance",
  );
  assert.doesNotMatch(
    JSON.stringify(c.requests),
    /PRIVATE|apiKey|input.value|output.value/,
  );
  await tracer.close();
});

test("transport failure and a blocked bounded queue never fail or wait on Agent execution", async () => {
  const failing = new TestExecutionTracer({ enabled: true }, async () => {
    throw new Error("PRIVATE_VENDOR");
  });
  assert.equal(await failing.span("root", "chain", {}, async () => 42), 42);
  await failing.flush();
  assert.equal(failing.metrics.failed, 1);
  await failing.close();
  let release;
  const blocked = new TestExecutionTracer(
    { enabled: true, queueLimit: 2 },
    () =>
      new Promise((resolve) => {
        release = () => resolve(emptyOtlpResponse());
      }),
  );
  for (let i = 0; i < 5; i++)
    assert.equal(await blocked.span("task", "chain", {}, async () => i), i);
  assert.equal(blocked.metrics.dropped, 3);
  assert.equal(await blocked.flush(5), false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  if (release) release();
  assert.equal(await blocked.flush(), true);
  await blocked.close();
});

test("safe error classifications and annotated tool failures preserve the original exception", async () => {
  const c = collector(),
    tracer = new TestExecutionTracer({ enabled: true }, c.fetcher);
  const error = Object.assign(new Error("PRIVATE_KEY=secret"), {
    code: "provider_timeout",
  });
  await assert.rejects(
    tracer.span("model_attempt", "llm", {}, async () => {
      throw error;
    }),
    (e) => e === error,
  );
  await tracer.span("tool_attempt", "tool", {}, async () => {
    tracer.annotate({ status: "failed", errorCode: "tool_timeout" });
    return { success: false };
  });
  await assert.rejects(
    tracer.span("unknown_failure", "tool", {}, async () => {
      throw Object.assign(new Error("PRIVATE_ERROR_MESSAGE"), {
        code: "OpaqueCredential0123456789abcdef0123456789",
      });
    }),
  );
  await tracer.flush();
  assert.equal(c.spans[0].status.code, 2);
  assert.equal(c.spans[0].status.message, "provider_timeout");
  assert.equal(c.spans[1].status.code, 2);
  assert.equal(c.spans[1].metadata.errorCode, "tool_timeout");
  assert.equal(c.spans[2].status.message, "execution_failed");
  assert.doesNotMatch(JSON.stringify(c.requests), /OpaqueCredential/);
  assert.ok(c.spans.every((s) => s.endTimeUnixNano));
  assert.doesNotMatch(JSON.stringify(c.requests), /PRIVATE|secret/);
  await tracer.close();
});

test("native human waits export only a waiting status without failed spans or private interaction state", async () => {
  const c = collector();
  const tracer = new TestExecutionTracer({ enabled: true }, c.fetcher);
  const suspended = new InteractionSuspension({ kind: "question", question: "PRIVATE_QUESTION",
    options: [{ id: "a", label: "PRIVATE_OPTION" }], allowCustom: true },
    "PRIVATE_INTERRUPT", { harness: { secret: "PRIVATE_CHECKPOINT" } });
  const waiting = new InteractionWaiting({ id: "PRIVATE_CARD", runId: "run", kind: "question",
    status: "pending", revision: 1, expiresAt: new Date().toISOString(), question: "PRIVATE_QUESTION" });
  for (const error of [suspended, waiting])
    await assert.rejects(tracer.span("human_wait", "chain", { localRunId: "run" }, async () => { throw error; }),
      (caught) => caught === error);
  await assert.rejects(tracer.span("spoofed_wait", "tool", {}, async () => {
    throw Object.assign(new Error("PRIVATE_TOOL_ERROR"), { code: "interaction_required" });
  }));
  await tracer.flush();
  for (const span of c.spans.slice(0, 2)) {
    assert.equal(span.metadata.status, "waiting");
    assert.equal(span.metadata.errorCode, undefined);
    assert.notEqual(span.status.code, 2);
  }
  assert.equal(c.spans[2].metadata.status, "failed");
  assert.equal(c.spans[2].status.code, 2);
  assert.doesNotMatch(JSON.stringify(c.requests), /PRIVATE|continuation|options|harness/);
  await tracer.close();
});

test("actual Deep Agents interruption keeps automatic framework spans out of the failure path", async () => {
  const c = collector();
  const tracer = new TestExecutionTracer({ enabled: true }, c.fetcher);
  const f = nativeChat({ tracing: tracer, tools: [new AskUserTool()], respond: () => ({
    content: "", toolCalls: [{ id: "question", name: "ask_user", arguments: {
      question: "PRIVATE_QUESTION_BODY", options: [{ id: "one", label: "PRIVATE_OPTION_BODY" }], allowCustom: true,
    } }],
  }) });
  try {
    await assert.rejects(f.execution.runTask(f.snapshot,
      { messages: [{ role: "user", content: "PRIVATE_TASK_BODY" }], versions: {}, limits: { maxDecisions: 4, maxToolCalls: 4 } },
      { runId: "trace-wait", traceId: "trace-wait", interactionHost: { threadId: "trace-wait", checkpointer: new MemorySaver() } }),
      (error) => error instanceof InteractionSuspension);
    await tracer.flush();
    assert.ok(c.spans.some((span) => span.attributes["app.layer"] === "framework" && span.attributes["app.status"] === "waiting"));
    assert.ok(c.spans.some((span) => span.metadata.status === "waiting"));
    assert.equal(c.spans.filter((span) => span.status.code === 2).length, 0);
    assert.doesNotMatch(JSON.stringify(c.requests), /PRIVATE_|continuation|options|harness/);
  } finally { await tracer.close(); }
});

test("explicit test tracing works; disabled and zero sampling export nothing", async () => {
  const c = collector();
  for (const options of [
    { enabled: false },
    { enabled: true, sampleRate: 0 },
  ]) {
    const tracer = new TestExecutionTracer(options, c.fetcher);
    await tracer.span("root", "chain", {}, async (span) => {
      assert.equal(tracer.link(span).enabled, false);
      await tracer.span("child", "tool", {}, async () => {});
    });
    await tracer.close();
  }
  assert.equal(c.requests.length, 0);
  const tracer = new TestExecutionTracer({ enabled: true }, c.fetcher);
  await tracer.span("root", "chain", {}, async (span) =>
    assert.equal(tracer.link(span).enabled, true),
  );
  await tracer.flush();
  assert.equal(c.spans.length, 1);
  await tracer.close();
});

test("ambient LangChain automatic tracing cannot upload private graph state", async () => {
  const previous = process.env.LANGCHAIN_TRACING_V2,
    oldFetch = globalThis.fetch;
  process.env.LANGCHAIN_TRACING_V2 = "true";
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return emptyOtlpResponse();
  };
  try {
    const host = nativeChat({
      businessPrompt: "PRIVATE_PROMPT",
      respond: () => ({ content: "Public native answer" }),
    });
    const result = await host.runner.run({
      question: "PRIVATE",
      summary: "",
      recentHistory: [],
    });
    assert.equal(result.contextSnapshot.executionEngine, "deepagents");
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(requests, 0);
  } finally {
    if (previous === undefined) delete process.env.LANGCHAIN_TRACING_V2;
    else process.env.LANGCHAIN_TRACING_V2 = previous;
    globalThis.fetch = oldFetch;
  }
});

test("real local HTTP export ignores ambient cloud endpoint/headers, times out and refuses redirects", async () => {
  const bodies = [],
    headers = [];
  const server = createServer((req, res) => {
    if (req.url === "/hang/otel/v1/traces") return;
    if (req.url === "/redirect/otel/v1/traces") {
      res.writeHead(302, { location: "https://example.invalid/v1/traces" });
      res.end();
      return;
    }
    const data = [];
    req.on("data", (x) => data.push(x));
    req.on("end", () => {
      bodies.push(decodeOtlpRequest(Buffer.concat(data)));
      headers.push(req.headers);
      res.setHeader("Content-Type", "application/x-protobuf");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const oldEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    oldHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://example.invalid";
  process.env.OTEL_EXPORTER_OTLP_HEADERS =
    "Authorization=Bearer AMBIENT_SECRET";
  try {
    const tracer = new TestExecutionTracer({
      enabled: true,
      endpoint: base,
      apiKey: "LOCAL_AUTH",
    });
    await tracer.span(
      "root",
      "chain",
      { apiKey: "PRIVATE_PROVIDER_KEY" },
      async () => 42,
    );
    await tracer.flush();
    assert.equal(tracer.metrics.exported, 1);
    assert.equal(headers[0]["x-api-key"], "LOCAL_AUTH");
    assert.doesNotMatch(
      JSON.stringify(bodies),
      /PRIVATE|LOCAL_AUTH|AMBIENT_SECRET/,
    );
    await tracer.close();
    for (const path of ["hang", "redirect"]) {
      const failing = new TestExecutionTracer({
        enabled: true,
        endpoint: `${base}/${path}`,
        timeoutMs: 100,
      });
      assert.equal(await failing.span("root", "chain", {}, async () => 42), 42);
      assert.equal(await failing.flush(1000), true);
      assert.equal(failing.metrics.failed, 1);
      await failing.close();
    }
  } finally {
    if (oldEndpoint === undefined)
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = oldEndpoint;
    if (oldHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = oldHeaders;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("actual model retries, tool attempts and retriever/embedding spans belong to their graph, no double invocation", async () => {
  const c = collector(),
    tracer = new TestExecutionTracer({ enabled: true }, c.fetcher);
  let calls = 0;
  const llm = new LlmService({
    model: "fixture",
    chat: async () => {
      calls++;
      if (calls === 1) throw new ProviderUnavailableError("PRIVATE_VENDOR");
      return {
        content: "PRIVATE_OUTPUT",
        model: "fixture",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        toolCalls: [],
        finishReason: "stop",
      };
    },
  });
  const tool = {
    name: "read",
    description: "read",
    inputSchema: { safeParse: (args) => ({ success: true, data: args }) },
    execute: async () => ({ success: true, content: "PRIVATE_TOOL" }),
  };
  const execution = new ToolExecutionService(
    { get: () => tool },
    new ToolPolicy(),
  );
  const root = await tracer.span(
    "agent_graph",
    "chain",
    { agentVersionId: 2 },
    async (span) => {
      await llm.completeDetailed(
        "PRIVATE_PROMPT",
        "PRIVATE_USER",
        "fixture",
        "planner",
        { retryDelaysMs: [0] },
      );
      await execution.execute(
        "read",
        {},
        { permissions: ["read"], state: new Map() },
        execution.createState(),
      );
      await executionSpan(
        "knowledge_retrieval",
        "retriever",
        { knowledgeBaseId: 3, indexVersionId: 5 },
        () =>
          executionSpan(
            "query_embedding",
            "embedding",
            { modelName: "embedding-v1" },
            async () => {},
          ),
      );
      return span;
    },
  );
  await tracer.flush();
  assert.equal(calls, 2);
  const attempts = c.spans.filter((s) => s.name === "model_attempt");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status.message, "provider_unavailable");
  assert.equal(attempts[1].metadata.totalTokens, 12);
  assert.ok(attempts.every((s) => s.parentSpanId === root.id));
  assert.equal(
    c.spans.find((s) => s.name === "tool_attempt").parentSpanId,
    c.spans.find((s) => s.name === "tool_read").spanId,
  );
  assert.equal(
    c.spans.find((s) => s.name === "query_embedding").parentSpanId,
    c.spans.find((s) => s.name === "knowledge_retrieval").spanId,
  );
  assert.doesNotMatch(JSON.stringify(c.requests), /PRIVATE/);
  await tracer.close();
});
