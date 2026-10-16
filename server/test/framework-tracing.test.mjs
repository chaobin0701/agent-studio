import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import {
  PhoenixExecutionTracer,
  frameworkTracing,
} from "../dist/observability/execution-tracer.js";
import { privateFrameworkCallbackHandlers } from "../dist/ai/agent/private-framework-callbacks.js";
import { collectPhoenixSpans } from "./helpers/phoenix-collector.mjs";

test("enabled private framework tracing installs no global instrumentation and exports nothing to ambient LangSmith", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require=createRequire(import.meta.url);
    let external=0;
    globalThis.fetch=async()=>{external++;throw Error('Forbidden external trace export');};
    await import('reflect-metadata');
    const {Annotation,StateGraph,START,END}=await import('@langchain/langgraph');
    const {PhoenixExecutionTracer,frameworkTracing}=await import('./dist/observability/execution-tracer.js');
    const {privateFrameworkCallbackHandlers}=await import('./dist/ai/agent/private-framework-callbacks.js');
    const {collectPhoenixSpans}=await import('./test/helpers/phoenix-collector.mjs');
    const spans=[],tracer=new PhoenixExecutionTracer({enabled:true},collectPhoenixSpans(spans));
    const state=Annotation.Root({text:Annotation()});
    const graph=new StateGraph(state).addNode('normalize',s=>({text:s.text})).addEdge(START,'normalize').addEdge('normalize',END).compile();
    try {
      await tracer.span('test_root','chain',{},async()=>{
        const capture=frameworkTracing(['normalize']);
        try {await graph.invoke({text:'PRIVATE_CLOUD_TEST'},{callbacks:[...privateFrameworkCallbackHandlers,...capture.callbacks]});}
        finally {capture.close();}
      });
      await tracer.flush();
      await new Promise(r=>setTimeout(r,100));
      assert.equal(external,0);
      assert.ok(spans.some(s=>s.attributes['app.layer']==='framework'));
      assert.doesNotMatch(JSON.stringify(spans),/PRIVATE_CLOUD_TEST/);
      assert.equal(require.cache[require.resolve('@arizeai/openinference-instrumentation-langchain')],undefined);
    } finally {await tracer.close();}
    console.log('private-framework-ok');
  `], {cwd:fileURLToPath(new URL('..',import.meta.url)), encoding:'utf8',timeout:5000,env:{...process.env,
    LANGSMITH_TRACING:'true',LANGCHAIN_TRACING_V2:'true',LANGCHAIN_VERBOSE:'true',
    LANGSMITH_API_KEY:'fixture-secret',LANGSMITH_ENDPOINT:'http://127.0.0.1:19998'}});
  assert.match(output,/private-framework-ok/);
  assert.doesNotMatch(output,/PRIVATE_CLOUD_TEST|Entering Chain run/);
});

test("raw callback data is discarded before OpenInference SDK storage and before OTEL export", async () => {
  const spans = [],
    tracer = new PhoenixExecutionTracer(
      { enabled: true, project: "private-framework-test" },
      collectPhoenixSpans(spans),
    );
  try {
    await tracer.span(
      "test_root",
      "chain",
      { workspaceId: 1, agentVersionId: 8, localRunId: randomUUID() },
      async () => {
        const capture = frameworkTracing(),
          handler = capture.callbacks[0],
          id = randomUUID();
        assert.ok(handler);
        await handler.handleChainStart(
          { id: ["PRIVATE_SERIALIZED_KEY"], kwargs: { apiKey: "PRIVATE_KEY" } },
          {
            messages: [{ content: "PRIVATE_PROMPT" }],
            state: "PRIVATE_DOCUMENT",
          },
          id,
          undefined,
          ["PRIVATE_TAG"],
          { password: "PRIVATE_PASSWORD" },
          "chain",
          "PRIVATE_NAME",
        );
        // This is the actual official SDK's storage, not only the final exporter.
        assert.doesNotMatch(
          JSON.stringify([...handler.sdk.runMap.values()]),
          /PRIVATE_/,
        );
        await handler.handleChainError(new Error("PRIVATE_ERROR_BODY"), id);
        capture.close();
        assert.equal(handler.sdk.runMap.size, 0);
        assert.equal(Object.keys(handler.sdk.runs).length, 0);
      },
    );
    await tracer.flush();
    const automatic = spans.filter(
      (s) => s.attributes["app.layer"] === "framework",
    );
    assert.equal(automatic.length, 1);
    assert.equal(automatic[0].status.code, 2);
    assert.equal(automatic[0].status.message, "framework_failed");
    assert.equal(
      automatic[0].parentSpanId,
      spans.find((s) => s.name === "test_root").spanId,
    );
    assert.doesNotMatch(
      JSON.stringify(spans),
      /PRIVATE_|input.value|output.value|llm.token_count/,
    );
  } finally {
    await tracer.close();
  }
});

test("actual LangGraph callback trees propagate metadata and remain isolated during parallel requests", async () => {
  const spans = [],
    tracer = new PhoenixExecutionTracer(
      { enabled: true, project: "parallel-framework-test" },
      collectPhoenixSpans(spans),
    );
  const state = Annotation.Root({ value: Annotation() });
  const graph = new StateGraph(state)
    .addNode("normalize", async (s) => {
      await new Promise((r) => setTimeout(r, 5));
      return { value: s.value };
    })
    .addEdge(START, "normalize")
    .addEdge("normalize", END)
    .compile();
  try {
    await Promise.all(
      [11, 22].map((agentVersionId) =>
        tracer.span(
          "test_root",
          "chain",
          { workspaceId: 1, agentVersionId },
          async () => {
            const capture = frameworkTracing(["normalize"]);
            try {
              const result = await graph.invoke(
                { value: `PRIVATE_INPUT_${agentVersionId}` },
                {
                  callbacks: [
                    ...privateFrameworkCallbackHandlers,
                    ...capture.callbacks,
                  ],
                },
              );
              assert.equal(result.value, `PRIVATE_INPUT_${agentVersionId}`);
            } finally {
              capture.close();
            }
          },
        ),
      ),
    );
    await tracer.flush();
    const roots = spans.filter((s) => s.name === "test_root");
    assert.equal(new Set(roots.map((s) => s.traceId)).size, 2);
    for (const root of roots) {
      const tree = spans.filter((s) => s.traceId === root.traceId);
      assert.ok(tree.some((s) => s.name === "framework/normalize"));
      for (const span of tree.filter((s) => s !== root)) {
        assert.equal(
          span.metadata.agentVersionId,
          root.metadata.agentVersionId,
        );
        assert.ok(
          tree.some((s) => s.spanId === span.parentSpanId),
          "every framework parent belongs to this request",
        );
      }
    }
    assert.doesNotMatch(JSON.stringify(spans), /PRIVATE_/);
  } finally {
    await tracer.close();
  }
});

test("unsampled execution installs no callback exporter; callback limits and cancellation cleanup are bounded", async () => {
  const disabled = new PhoenixExecutionTracer({ enabled: true, sampleRate: 0 });
  try {
    await disabled.span("test_root", "chain", {}, async () =>
      assert.equal(frameworkTracing().callbacks.length, 0),
    );
  } finally {
    await disabled.close();
  }
  const spans = [],
    tracer = new PhoenixExecutionTracer(
      { enabled: true, project: "bounded-framework-test", queueLimit: 2000 },
      collectPhoenixSpans(spans),
    );
  try {
    await tracer.span("test_root", "chain", {}, async () => {
      const capture = frameworkTracing(),
        handler = capture.callbacks[0];
      for (let i = 0; i < 520; i++)
        await handler.handleChainStart(
          {},
          { secret: "PRIVATE_STATE" },
          randomUUID(),
        );
      assert.equal(handler.sdk.runMap.size, 512);
      capture.close();
      capture.close();
      assert.equal(handler.sdk.runMap.size, 0);
      const count = handler.total;
      await handler.handleChainStart({}, {}, randomUUID());
      assert.equal(
        handler.total,
        count,
        "closed callbacks cannot create late spans",
      );
    });
    await tracer.flush();
    assert.equal(
      spans.filter((s) => s.attributes["app.layer"] === "framework").length,
      512,
    );
    assert.doesNotMatch(JSON.stringify(spans), /PRIVATE_/);
  } finally {
    await tracer.close();
  }
});
