import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// Factories use the project's actual CommonJS graph entry, just like compiled
// TypeScript. Dual ESM/CJS class copies are not interchangeable for instanceof.
const { Annotation, StateGraph, START, END, MemorySaver } = createRequire(
  import.meta.url,
)("@langchain/langgraph");
import { SpecializedWorkflowRegistry } from "../dist/ai/workflows/specialized-workflow.js";
import { textStatistics } from "../dist/ai/workflows/text-statistics.js";
import { currentWorkflowHost } from "../dist/ai/workflows/workflow-host.js";
import { nativeChat } from "./helpers/native-chat.mjs";
import { DEFAULT_AGENT_CONFIGURATION } from "../dist/config/agent-config.js";
import {
  ProviderAuthenticationError,
  ProviderUnavailableError,
} from "../dist/ai/providers/provider-errors.js";
import { withModelCallAccounting } from "../dist/chat/model-call-accounting.js";
import { PhoenixExecutionTracer } from "../dist/observability/execution-tracer.js";
import { executionContextView } from "../dist/observability/execution-view.js";
import { collectPhoenixSpans } from "./helpers/phoenix-collector.mjs";
import { makeManagedTool } from "../dist/agent-management/managed-tool.js";
import { toolSchema } from "../dist/agent-management/resource.types.js";

const input = { question: "PRIVATE_TASK", summary: "", recentHistory: [] };
const calls = (name) => ({
  content: "",
  toolCalls: [
    { id: "flow-call", name, arguments: { text: "PRIVATE_FLOW_INPUT" } },
  ],
});
function register(definition = textStatistics) {
  const registry = new SpecializedWorkflowRegistry();
  registry.register(definition);
  return { registry, tool: registry.tools()[0] };
}
function flow(
  operation,
  {
    key = "flow_fixture_v1",
    allowedTools = [],
    limits = {},
    outputSchema = z.object({ result: z.json() }).strict(),
    build,
  } = {},
) {
  return {
    key,
    version: "1",
    description: "Code-owned specialized acceptance flow",
    inputSchema: z.object({ text: z.string().max(24000) }).strict(),
    outputSchema,
    allowedTools,
    limits: {
      maxSteps: 2,
      maxModelCalls: 1,
      maxToolCalls: 1,
      maxDurationMs: 1000,
      ...limits,
    },
    build:
      build ??
      ((effects) => {
        const State = Annotation.Root({
          text: Annotation(),
          result: Annotation(),
        });
        const Output = Annotation.Root({ result: Annotation() });
        return new StateGraph({ stateSchema: State, output: Output })
          .addNode("work", (state) =>
            effects.node("work", async () => ({
              result: await operation(state.text, effects),
            })),
          )
          .addEdge(START, "work")
          .addEdge("work", END)
          .compile();
      }),
  };
}
async function native(tool, options = {}) {
  const fixture = nativeChat({
    tools: [tool, ...(options.tools ?? [])],
    ...options,
    respond:
      options.respond ??
      ((_request, n) => (n === 1 ? calls(tool.name) : { content: "Done" })),
  });
  const result = await fixture.runner.run(input);
  return { fixture, result };
}
function flowOutcome(result) {
  return result.toolResults.find((item) => item.callId === "flow-call");
}

test("registered pure StateGraph runs as an explicit native Tool, returns only final statistics and adds no hidden model", async () => {
  const { tool } = register();
  const { fixture, result } = await native(tool, {
    respond: (_r, n) =>
      n === 1
        ? {
            content: "",
            toolCalls: [
              {
                id: "flow-call",
                name: tool.name,
                arguments: { text: "Hello\n世界 🌍" },
              },
            ],
          }
        : { content: "Done" },
  });
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(JSON.parse(flowOutcome(result).content), {
    characters: 10,
    nonWhitespace: 8,
    nonEmptyLines: 2,
  });
  assert.deepEqual(
    result.contextSnapshot.specializedFlows.map((f) => [
      f.key,
      f.version,
      f.nodes,
      f.modelCalls,
      f.toolCalls,
      f.ok,
    ]),
    [[tool.name, "1", 2, 0, 0, true]],
  );
  assert.equal(result.output.usage.totalTokens, 30);
  assert.equal(result.contextSnapshot.executionBudget.toolCalls, 1);
  assert.equal(result.contextSnapshot.executionEngine, "deepagents");
});

test("pure administrative Tool tests execute the same real graph with zero-effect authority; missing permissions fail closed", async () => {
  const { tool } = register();
  const managed = makeManagedTool(
    {
      id: 88,
      key: tool.name,
      config: toolSchema.parse({
        type: "builtin",
        target: tool.name,
        description: "Measure",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        maxRetries: 3,
        timeoutMs: 1000,
      }),
    },
    () => tool,
  );
  const result = await managed.execute(
    { text: "Hello" },
    { permissions: [tool.name], state: new Map() },
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.data, {
    characters: 5,
    nonWhitespace: 5,
    nonEmptyLines: 1,
  });
  assert.equal(
    (
      await managed.execute(
        { text: "Hello" },
        { permissions: [], state: new Map() },
      )
    ).errorCode,
    "workflow_not_allowed",
  );
  assert.equal(
    managed.planning.isIdempotent,
    false,
    "a managed retry setting cannot replay the graph",
  );
  assert.equal(managed.execution.workflow.version, "1");
  assert.equal(currentWorkflowHost(), undefined);
});

test("fixed graph model and tool effects share native usage, original IDs, accounting and private Phoenix parents without input/state export", async () => {
  const spans = [],
    tracer = new PhoenixExecutionTracer(
      { enabled: true, project: "workflow-acceptance" },
      collectPhoenixSpans(spans),
    );
  let lookups = 0,
    leases = 0,
    settles = 0;
  const lookup = {
    name: "lookup",
    description: "Lookup",
    inputSchema: z.object({ text: z.string() }),
    execute: async () => {
      lookups++;
      return {
        success: true,
        content: "PRIVATE_LOOKUP_RESULT",
        references: [{ kind: "record", id: "verified-1" }],
      };
    },
  };
  const { tool } = register(
    flow(
      async (text, effects) => {
        const data = await effects.tool("lookup", { text });
        return {
          answer: await effects.model(
            "PRIVATE_FIXED_INSTRUCTION",
            data.content,
          ),
        };
      },
      { allowedTools: [lookup.name] },
    ),
  );
  const fixture = nativeChat({
    tools: [tool, lookup],
    tracing: tracer,
    businessPrompt: "PRIVATE_PUBLISHED_PROMPT",
    respond: (request, n) =>
      n === 1
        ? calls(tool.name)
        : n === 2
          ? (() => {
              assert.equal(request.tools, undefined);
              assert.equal(
                request.messages.at(-1).content,
                "PRIVATE_LOOKUP_RESULT",
              );
              assert.match(
                request.messages[0].content,
                /PRIVATE_PUBLISHED_PROMPT/,
              );
              return { content: "PRIVATE_FLOW_OUTPUT" };
            })()
          : (() => {
              assert.equal(
                request.messages.filter((m) => m.role === "tool").at(-1)
                  .toolCallId,
                "flow-call",
              );
              return { content: "Done" };
            })(),
  });
  try {
    const result = await withModelCallAccounting(
      {
        reserve: async () => {
          leases++;
          return {
            settle: async () => {
              settles++;
            },
          };
        },
      },
      () =>
        fixture.runner.run({
          ...input,
          traceId: "workflow-trace",
          conversationId: "workflow-conversation",
        }),
    );
    assert.equal(fixture.requests.length, 3);
    assert.equal(lookups, 1);
    assert.equal(leases, 3);
    assert.equal(settles, 3);
    assert.equal(result.output.usage.totalTokens, 45);
    assert.equal(result.contextSnapshot.executionBudget.modelCalls, 3);
    assert.equal(result.contextSnapshot.executionBudget.toolCalls, 2);
    assert.equal(result.contextSnapshot.modelCalls.length, 3);
    assert.equal(
      result.contextSnapshot.executionSteps.find(
        (step) => step.type === "tool_call" && step.name === "lookup",
      ).origin,
      "workflow",
    );
    assert.equal(result.output.references[0].id, "verified-1");
    assert.equal(result.contextSnapshot.specializedFlows[0].modelCalls, 1);
    const view = executionContextView(result.contextSnapshot);
    assert.equal(view.specializedFlows[0].version, "1");
    assert.doesNotMatch(JSON.stringify(view), /PRIVATE_/);
    assert.equal(await tracer.flush(), true);
    const root = spans.find((s) => s.name === "agent_execution"),
      workflow = spans.find((s) => s.name === "specialized_workflow"),
      node = spans.find((s) => s.name === "workflow_node");
    assert.equal(workflow.metadata.workflowKey, tool.name);
    assert.equal(workflow.metadata.workflowVersion, "1");
    assert.equal(workflow.metadata.agentVersionId, 1);
    assert.equal(workflow.metadata.promptVersionId, 1);
    assert.equal(workflow.metadata.workflowModelCalls, 1);
    assert.equal(workflow.metadata.workflowToolCalls, 1);
    assert.equal(workflow.traceId, root.traceId);
    const frameworkNode = spans.find(s => s.spanId === node.parentSpanId);
    assert.equal(frameworkNode.attributes["app.layer"], "framework");
    assert.equal(frameworkNode.traceId, workflow.traceId);
    let ancestor = frameworkNode;
    const seenParents = new Set();
    while (ancestor && ancestor.spanId !== workflow.spanId && !seenParents.has(ancestor.spanId)) {
      seenParents.add(ancestor.spanId);
      ancestor = spans.find(s => s.spanId === ancestor.parentSpanId);
    }
    assert.equal(ancestor?.spanId, workflow.spanId, "framework node remains under the authorized workflow");
    assert.equal(
      spans.filter((s) => s.name === "model_attempt").length,
      3,
      "no duplicate billed model spans",
    );
    assert.doesNotMatch(
      JSON.stringify(spans),
      /PRIVATE_|PRIVATE_FIXED_INSTRUCTION|PRIVATE_LOOKUP_RESULT/,
    );
  } finally {
    await tracer.close();
  }
});

test("flow registration never grants dependencies, global tools or an independent effectful execution context", async () => {
  let ran = 0;
  const { tool } = register(
    flow(
      async (_text, effects) => {
        ran++;
        await effects.tool("secret_lookup", {});
        return {};
      },
      { allowedTools: ["secret_lookup"] },
    ),
  );
  const denied = await tool.execute(
    { text: "task" },
    { permissions: [tool.name], state: new Map() },
  );
  assert.equal(denied.errorCode, "workflow_context_required");
  const { fixture, result } = await native(tool);
  assert.equal(flowOutcome(result).success, false);
  assert.match(flowOutcome(result).content, /专项流程未完成/);
  assert.equal(result.toolCalls[0].errorCode, "workflow_dependency_missing");
  assert.equal(ran, 0);
  assert.equal(fixture.requests.length, 2);
});

test("declared dependency subsets and nesting are enforced even when the Agent separately has a wider grant", async () => {
  let writes = 0;
  const write = {
    name: "write",
    description: "Write",
    inputSchema: z.object({}),
    planning: { isIdempotent: false },
    execute: async () => {
      writes++;
      return { success: true, content: "Written" };
    },
  };
  const { tool } = register(
    flow(async (_text, effects) => {
      await effects.tool(write.name, {});
      return {};
    }),
  );
  const { result } = await native(tool, { tools: [tool, write] });
  assert.equal(result.toolCalls[0].errorCode, "workflow_not_allowed");
  assert.equal(writes, 0);
  const nested = register(
    flow(
      async () => ({
        nested: await tool.execute(
          { text: "x" },
          { permissions: [tool.name], state: new Map() },
        ),
      }),
      { key: "flow_nested_v1" },
    ),
  ).tool;
  const next = await native(nested, { tools: [nested, tool] });
  assert.equal(
    JSON.parse(flowOutcome(next.result).content).result.nested.errorCode,
    "workflow_nesting_denied",
  );
});

test("successful writes are not replayed when a later node/output fails, including managed maxRetries=3", async () => {
  let writes = 0;
  const write = {
    name: "write",
    description: "Write",
    inputSchema: z.object({}),
    planning: { isIdempotent: false },
    execute: async () => {
      writes++;
      return { success: true, content: "Written" };
    },
  };
  const base = register(
    flow(
      async (_text, effects) => {
        await effects.tool("write", {});
        return new Map([["PRIVATE_KEY", "PRIVATE_VALUE"]]);
      },
      { allowedTools: [write.name] },
    ),
  ).tool;
  const managed = makeManagedTool(
    {
      id: 93,
      key: base.name,
      config: toolSchema.parse({
        type: "builtin",
        target: base.name,
        description: "Explicit flow",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        maxRetries: 3,
        timeoutMs: 1000,
      }),
    },
    () => base,
  );
  const { result, fixture } = await native(managed, {
    tools: [managed, write],
  });
  assert.equal(writes, 1);
  assert.equal(fixture.requests.length, 2);
  assert.equal(result.toolCalls.at(-1).attempts, 1);
  assert.equal(result.toolCalls.at(-1).errorCode, "workflow_invalid_output");
  assert.equal(result.contextSnapshot.specializedFlows[0].ok, false);
  assert.doesNotMatch(flowOutcome(result).content, /PRIVATE_/);
});

test("flow has no graph/SDK model retry layer; LlmService retries once-authoritatively and failed model diagnostics stay accounted", async () => {
  const { tool } = register(
    flow(async (text, effects) => ({
      text: await effects.model("Answer the task", text),
    })),
  );
  let transient = 0;
  const recovered = await native(tool, {
    respond: (request, n) => {
      if (n === 1) return calls(tool.name);
      if (request.messages[0].content.includes("专项流程指导")) {
        if (!transient++) throw new ProviderUnavailableError("PRIVATE_VENDOR");
        return { content: "Flow result" };
      }
      return { content: "Done" };
    },
  });
  assert.equal(recovered.fixture.requests.length, 4);
  assert.equal(recovered.result.contextSnapshot.executionBudget.modelCalls, 4);
  assert.equal(recovered.result.contextSnapshot.specializedFlows.length, 1);
  assert.equal(
    recovered.result.contextSnapshot.specializedFlows[0].modelCalls,
    1,
  );
  const failed = await native(tool, {
    respond: (request, n) =>
      n === 1
        ? calls(tool.name)
        : request.messages[0].content.includes("专项流程指导")
          ? (() => {
              throw new ProviderAuthenticationError(401);
            })()
          : { content: "Safely handled failure" },
  });
  assert.equal(failed.fixture.requests.length, 3);
  assert.equal(failed.result.contextSnapshot.modelCalls.length, 3);
  assert.equal(
    failed.result.contextSnapshot.modelCalls[1].errorCode,
    "provider_authentication",
  );
  assert.equal(
    failed.result.output.usage.totalTokens,
    null,
    "failed/unknown attempts are not reported as free",
  );
});

test("flow tool effects use the same Agent/global call cap, not a reset local budget", async () => {
  const configuration = structuredClone(DEFAULT_AGENT_CONFIGURATION);
  configuration.runtime.maxToolCalls = 1;
  let lookups = 0;
  const lookup = {
    name: "lookup",
    description: "Lookup",
    inputSchema: z.object({}),
    execute: async () => {
      lookups++;
      return { success: true, content: "Ok" };
    },
  };
  const { tool } = register(
    flow(
      async (_text, effects) => {
        await effects.tool("lookup", {});
        return {};
      },
      { allowedTools: [lookup.name] },
    ),
  );
  const { result } = await native(tool, {
    configuration,
    tools: [tool, lookup],
  });
  assert.equal(lookups, 0);
  assert.equal(result.contextSnapshot.executionBudget.toolCalls, 1);
  assert.equal(result.contextSnapshot.specializedFlows[0].ok, false);
  assert.equal(
    result.toolCalls.some((c) => c.errorCode === "tool_call_limit_exceeded"),
    true,
  );
});

test("parent cancellation reaches an active flow model without extra finalization or leaked background effects", async () => {
  let entered;
  const began = new Promise((resolve) => {
    entered = resolve;
  });
  const controller = new AbortController();
  const { tool } = register(
    flow(async (text, effects) => ({
      text: await effects.model("Answer", text),
    })),
  );
  const fixture = nativeChat({
    tools: [tool],
    respond: async (request, n) => {
      if (n === 1) return calls(tool.name);
      entered();
      await new Promise((_, reject) =>
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
      assert.fail("No completion after cancellation");
    },
  });
  const operation = fixture.runner.run({ ...input, signal: controller.signal });
  await began;
  controller.abort(
    Object.assign(new Error("Cancelled"), { code: "run_cancelled" }),
  );
  await assert.rejects(operation);
  assert.equal(fixture.requests.length, 2);
});

test("deadline closes the effect port, rejects late calls and does not block on an uncooperative pure node", async () => {
  let late, release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const { tool } = register(
    flow(
      async (_text, effects) => {
        late = effects;
        await wait;
        return {};
      },
      { limits: { maxDurationMs: 25 } },
    ),
  );
  const { result, fixture } = await native(tool);
  assert.equal(
    result.contextSnapshot.specializedFlows[0].errorCode,
    "workflow_timeout",
  );
  assert.equal(result.contextSnapshot.specializedFlows[0].ok, false);
  await assert.rejects(late.model("Never run", "task"));
  release();
  await new Promise(setImmediate);
  assert.equal(fixture.requests.length, 2);
});

test("registration and execution reject mutable versions, fake graphs, state dumps, graph retries and persistence outside this scope", async () => {
  const registry = new SpecializedWorkflowRegistry();
  registry.register(textStatistics);
  assert.throws(() => registry.register(textStatistics), /duplicate/);
  assert.throws(
    () => registry.register({ ...textStatistics, version: "2" }),
    /Invalid/,
  );
  assert.throws(
    () =>
      registry.register({
        ...textStatistics,
        key: "flow_invalid_v1",
        limits: { ...textStatistics.limits, maxSteps: Infinity },
      }),
    /Invalid/,
  );
  const fake = register(
    flow(async () => ({}), {
      build: () => ({ invoke: async () => ({ result: {} }) }),
    }),
  ).tool;
  assert.equal(
    (await native(fake)).result.toolCalls[0].errorCode,
    "workflow_invalid_output",
  );
  for (const policy of ["retry", "checkpoint", "debug", "cache"]) {
    let ran = 0;
    const bad = register(
      flow(async () => ({}), {
        build: (effects) => {
          const State = Annotation.Root({
            text: Annotation(),
            result: Annotation(),
          });
          const builder = new StateGraph(State)
            .addNode(
              "work",
              () =>
                effects.node("work", async () => {
                  ran++;
                  return { result: {} };
                }),
              policy === "retry"
                ? { retryPolicy: { maxAttempts: 3 } }
                : policy === "cache"
                  ? { cachePolicy: { ttl: 60 } }
                  : {},
            )
            .addEdge(START, "work")
            .addEdge("work", END);
          const graph = builder.compile(
            policy === "checkpoint" ? { checkpointer: new MemorySaver() } : {},
          );
          if (policy === "debug") graph.debug = true;
          return graph;
        },
      }),
    ).tool;
    assert.equal(
      (await native(bad)).result.toolCalls[0].errorCode,
      "workflow_invalid_output",
      policy,
    );
    assert.equal(ran, 0);
  }
  const oversized = register(
    flow(async () => ({ text: "x".repeat(150000) })),
  ).tool;
  assert.equal(
    (await native(oversized)).result.toolCalls[0].errorCode,
    "workflow_invalid_output",
  );
});

test("concurrent native hosts keep their own published Prompt, outputs and usage; closed context cannot be reused", async () => {
  const hosts = [];
  const { tool } = register(
    flow(async (text, effects) => {
      hosts.push(currentWorkflowHost());
      return { text: await effects.model("Analyze", text) };
    }),
  );
  const make = (name) =>
    native(tool, {
      businessPrompt: `PRIVATE_PROMPT_${name}`,
      respond: (request, n) => {
        assert.match(
          request.messages[0].content,
          new RegExp(`PRIVATE_PROMPT_${name}`),
        );
        return n === 1
          ? calls(tool.name)
          : request.messages[0].content.includes("专项流程指导")
            ? { content: name }
            : { content: `Done ${name}` };
      },
    });
  const results = await Promise.all([make("one"), make("two")]);
  assert.notEqual(hosts[0], hosts[1]);
  for (const { fixture, result } of results) {
    assert.equal(fixture.requests.length, 3);
    assert.equal(result.output.usage.totalTokens, 45);
  }
  assert.equal(currentWorkflowHost(), undefined);
});

test("fixed-flow steps and total model reservations stop before excess paid calls, with no repair/replay", async () => {
  const { tool } = register(
    flow(async (text, effects) => {
      await effects.model("First", text);
      await effects.model("Second", text);
      return {};
    }),
  );
  const { fixture, result } = await native(tool, {
    respond: (_request, n) =>
      n === 1 ? calls(tool.name) : { content: "Done" },
  });
  assert.equal(fixture.requests.length, 3);
  assert.equal(result.toolCalls[0].errorCode, "workflow_limit_exceeded");
  assert.equal(result.contextSnapshot.specializedFlows[0].modelCalls, 1);
  const valid = register(
    flow(async (text, effects) => ({
      answer: await effects.model("One", text),
    })),
  ).tool;
  const f = nativeChat({
    tools: [valid],
    respond: (_r, n) =>
      n === 1 ? calls(valid.name) : { content: "Flow completed" },
  });
  await assert.rejects(
    f.execution.runTask(
      f.snapshot,
      {
        messages: [],
        task: "Run flow",
        versions: {},
        limits: { maxDecisions: 2, maxToolCalls: 2, maxModelCalls: 2 },
      },
      { runId: "bounded-flow", traceId: "bounded-flow-trace" },
    ),
    (e) => e.code === "agent_budget_exceeded",
  );
  assert.equal(
    f.requests.length,
    2,
    "the host cannot invoice an unreserved final/repair call",
  );
});

test("native flow/model graphs suppress ambient LangSmith before imports, without enabling any cloud/global exporter", () => {
  const code = `
    import {createRequire} from 'node:module';
    const require=createRequire(import.meta.url);const {StateGraph,Annotation,START,END}=require('@langchain/langgraph');
    const {SpecializedWorkflowRegistry}=require('./dist/ai/workflows/specialized-workflow.js');
    const {z}=require('zod');const {nativeChat}=await import('./test/helpers/native-chat.mjs');
    let exports=0;globalThis.fetch=async()=>{exports++;throw new Error('Cloud must not be called');};
    const registry=new SpecializedWorkflowRegistry();registry.register({key:'flow_private_v1',version:'1',description:'Private graph',inputSchema:z.object({text:z.string()}),outputSchema:z.object({result:z.string()}),allowedTools:[],limits:{maxSteps:1,maxModelCalls:1,maxToolCalls:0,maxDurationMs:1000},build:effects=>{
      const State=Annotation.Root({text:Annotation(),result:Annotation()});
      return new StateGraph({stateSchema:State,output:Annotation.Root({result:Annotation()})}).addNode('work',state=>effects.node('work',async()=>({result:await effects.model('Private policy',state.text)}))).addEdge(START,'work').addEdge('work',END).compile();
    }});
    const tool=registry.tools()[0];const f=nativeChat({tools:[tool],respond:(_r,n)=>n===1?{content:'',toolCalls:[{id:'flow-call',name:tool.name,arguments:{text:'Private input'}}]}:{content:'Private output'}});
    const result=await f.runner.run({question:'Private task',summary:'',recentHistory:[]});
    if(!result.contextSnapshot.specializedFlows[0].ok||f.requests.length!==3)throw new Error('Native graph did not run');
    await new Promise(r=>setTimeout(r,150));if(exports)throw new Error('Implicit cloud export');console.log('private-workflow-ok');
  `;
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        LANGSMITH_TRACING: "true",
        LANGCHAIN_TRACING_V2: "true",
        LANGSMITH_API_KEY: "fake-unused-key",
        LANGSMITH_ENDPOINT: "https://api.smith.langchain.com",
      },
    },
  );
  assert.match(output, /private-workflow-ok/);
});
