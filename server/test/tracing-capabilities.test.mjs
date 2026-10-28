import { TestExecutionTracer } from "./helpers/trace-collector.mjs";
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpClientAdapter } from "../dist/ai/mcp/mcp-client.adapter.js";
import { adaptMcpTool } from "../dist/ai/mcp/mcp-tool.adapter.js";
import { ToolExecutionService } from "../dist/ai/tools/tool-execution.js";
import { ToolPolicy } from "../dist/ai/tools/tool-policy.js";
import { ToolRegistry } from "../dist/ai/tools/tool-registry.js";
import { nativeChat } from "./helpers/native-chat.mjs";
import { AgentExecutionService } from "../dist/ai/runtime/agent-execution.service.js";
import { DeepAgentExecutionService } from "../dist/ai/deep-agents/deep-agent-execution.service.js";
import { ManagedDeepAgentHarness } from "../dist/ai/deep-agents/managed-harness.js";
import { collectOtlpSpans } from "./helpers/trace-collector.mjs";
import { LlmService } from "../dist/chat/llm.service.js";
import { ProviderUnavailableError } from "../dist/ai/providers/provider-errors.js";

test("native MCP and actual model retry/error paths reach LangSmith with version/Run metadata, never arguments or results", async () => {
  const spans = [],
    tracer = new TestExecutionTracer(
      { enabled: true, project: "fixture" },
      collectOtlpSpans(spans),
    );
  const server = new McpServer({
    name: "local-trace-acceptance",
    version: "1.0.0",
  });
  server.registerTool(
    "lookup",
    { inputSchema: { text: z.string() } },
    async () => ({ content: [{ type: "text", text: "PRIVATE_MCP_RESULT" }] }),
  );
  const client = await McpClientAdapter.connect(server);
  try {
    const descriptor = (await client.listTools()).tools[0];
    const tool = {
      ...adaptMcpTool("acceptance", client, descriptor),
      execution: {
        channel: "tools",
        source: "mcp",
        toolVersionId: 87,
        mcpServerId: 12,
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const runtime = new ToolExecutionService(registry, new ToolPolicy());
    const state = runtime.createState();
    let requests = 0;
    const llm = new LlmService({
      model: "fixture",
      chat: async (request) => {
        requests++;
        if (requests === 1)
          throw new ProviderUnavailableError("PRIVATE_VENDOR");
        return {
          content: requests === 2 ? "" : "PRIVATE_MODEL_OUTPUT",
          model: "fixture",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          toolCalls:
            requests === 2
              ? [
                  {
                    id: "call-one",
                    name: tool.name,
                    arguments: { text: "PRIVATE_ARGUMENT" },
                  },
                ]
              : [],
          finishReason: requests === 2 ? "tool_calls" : "stop",
        };
      },
    });
    let linked;
    const input = {
      messages: [{ role: "user", content: "PRIVATE_USER" }],
      versions: {
        workspaceId: 1,
        agentId: 9,
        agentVersionId: 31,
        promptVersionId: 8,
        modelPlanVersionId: 13,
        localRunId: "langsmith-native-acceptance",
        localTraceId: "local-native-trace",
      },
      limits: { maxDecisions: 2, maxToolCalls: 1 },
    };
    const result = await tracer.span(
      "agent_execution",
      "chain",
      input.versions,
      async (span) => {
        linked = tracer.link(span);
        return new ManagedDeepAgentHarness(llm).run(input, {
          systemPrompt: "PRIVATE_PROMPT",
          tools: [tool],
          skills: [],
          gateway: runtime,
          toolContext: { permissions: [tool.name], state: new Map() },
        });
      },
    );
    assert.equal(result.result.answer, "PRIVATE_MODEL_OUTPUT");
    assert.equal(result.toolCalls, 1);
    assert.equal(requests, 3);
    assert.equal(await tracer.flush(), true);
    const attempt = spans.find((s) => s.name === "tool_attempt");
    assert.equal(attempt.metadata.toolVersionId, 87);
    assert.equal(attempt.metadata.mcpServerId, 12);
    assert.equal(
      spans.find((s) => s.name === "deep_agent").metadata.localRunId,
      "langsmith-native-acceptance",
    );
    assert.ok(spans.every((s) => s.traceId === linked.traceId));
    assert.ok(spans.some((s) => s.status.message === "provider_unavailable"));
    assert.doesNotMatch(JSON.stringify(spans), /PRIVATE_/);
    await assert.rejects(
      tracer.span(
        "exception_acceptance",
        "tool",
        { localRunId: "failed-native-acceptance" },
        async () => {
          throw Object.assign(new Error("PRIVATE_ERROR_BODY"), {
            code: "tool_timeout",
          });
        },
      ),
      /PRIVATE_ERROR_BODY/,
    );
    await tracer.flush();
    assert.equal(
      spans.find((s) => s.name === "exception_acceptance").status.code,
      2,
    );
    const failure = spans.find((s) => s.name === "exception_acceptance");
    assert.equal(failure.events.length, 1);
    assert.equal(failure.events[0].name, "exception");
    assert.deepEqual(
      Object.fromEntries(
        failure.events[0].attributes.map((a) => [
          a.key,
          Object.values(a.value)[0],
        ]),
      ),
      { "exception.message": "tool_timeout" },
    );
    assert.doesNotMatch(JSON.stringify(spans), /PRIVATE_/);
  } finally {
    await client.close();
    await tracer.close();
  }
});

test("real HTTP Tool and remote MCP are executed by the native Deep Agents loop on a shared trace with credential-free wire attributes", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { makeManagedTool } = await import(
    "../dist/agent-management/managed-tool.js"
  );
  const { toolSchema } = await import(
    "../dist/agent-management/resource.types.js"
  );
  const { toolFetch } = await import("../dist/tool-management/network.js");
  const { withRemoteMcp, discoverMcp, callMcp } = await import(
    "../dist/tool-management/remote-mcp.js"
  );
  let httpCalls = 0,
    mcpCalls = 0;
  const credential = {
    kind: "bearer",
    header: "Authorization",
    secret: "PRIVATE_TRACE_AUTH",
  };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${credential.secret}`) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.url.startsWith("/lookup")) {
      httpCalls++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: "PRIVATE_HTTP_BODY" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const mcp = new McpServer({
      name: "remote-trace-acceptance",
      version: "1.0.0",
    });
    mcp.registerTool(
      "lookup",
      { inputSchema: { text: z.string() } },
      async () => {
        mcpCalls++;
        return { content: [{ type: "text", text: "PRIVATE_REMOTE_MCP_BODY" }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    const parts = [];
    for await (const part of req) parts.push(part);
    await transport.handleRequest(
      req,
      res,
      JSON.parse(Buffer.concat(parts).toString()),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const previous = process.env.AGENT_TOOL_ALLOWED_HOSTS;
  process.env.AGENT_TOOL_ALLOWED_HOSTS = "127.0.0.1";
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENT_TOOL_ALLOWED_HOSTS;
    else process.env.AGENT_TOOL_ALLOWED_HOSTS = previous;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = makeManagedTool(
    {
      id: 88,
      key: "http_trace_lookup",
      config: toolSchema.parse({
        type: "rest",
        description: "Read-only HTTP",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        readOnly: true,
        maxRetries: 0,
        endpoint: { url: base + "/lookup", method: "GET", credentialId: 1 },
      }),
    },
    () => {
      throw Error("No legacy tool");
    },
    { fetch: toolFetch, credential: async () => credential },
  );
  const remote = {
    name: "remote_trace_lookup",
    description: "Read-only MCP",
    inputSchema: z.object({ text: z.string() }),
    execution: {
      channel: "tools",
      source: "mcp",
      toolVersionId: 89,
      mcpServerId: 14,
    },
    planning: { canBatch: true, isIdempotent: true },
    execute: async (args, context) =>
      withRemoteMcp(
        { url: base + "/mcp", credentialId: 1, timeoutMs: 5000 },
        credential,
        context.signal,
        async (client) => {
          const [descriptor] = await discoverMcp(client);
          const result = await callMcp(client, descriptor, args);
          return { success: !result.isError, content: result.content[0].text };
        },
      ),
  };
  const registry = new ToolRegistry();
  registry.register(http);
  registry.register(remote);
  const runtime = new ToolExecutionService(registry, new ToolPolicy()),
    state = runtime.createState(),
    spans = [];
  const tracer = new TestExecutionTracer(
    { enabled: true, project: "fixture" },
    collectOtlpSpans(spans),
  );
  try {
    let requests = 0;
    const llm = new LlmService({
      model: "fixture",
      contextWindowTokens: 32000,
      chat: async (request) => {
        requests++;
        if (requests === 2) {
          assert.equal(
            request.messages.filter((message) => message.role === "tool")
              .length,
            2,
          );
          assert.ok(
            request.messages.some(
              (message) =>
                message.role === "tool" &&
                message.content.includes("PRIVATE_HTTP_BODY"),
            ),
          );
          assert.ok(
            request.messages.some(
              (message) =>
                message.role === "tool" &&
                message.content.includes("PRIVATE_REMOTE_MCP_BODY"),
            ),
          );
        }
        return {
          content: requests === 1 ? "" : "complete",
          toolCalls:
            requests === 1
              ? [http, remote].map((tool, i) => ({
                  id: `call-${i}`,
                  name: tool.name,
                  arguments: { text: "PRIVATE_ARGUMENT" },
                }))
              : [],
          finishReason: requests === 1 ? "tool_calls" : "stop",
          model: "fixture",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        };
      },
    });
    const input = {
      messages: [{ role: "user", content: "PRIVATE_TOOL_TASK" }],
      versions: {
        agentId: 9,
        agentVersionId: 31,
        promptVersionId: 8,
        localRunId: "langsmith-http-mcp-acceptance",
      },
      limits: { maxDecisions: 2, maxToolCalls: 2 },
    };
    const result = await tracer.span(
      "agent_execution",
      "chain",
      input.versions,
      () =>
        new ManagedDeepAgentHarness(llm).run(input, {
          systemPrompt: "Complete task",
          tools: [http, remote],
          skills: [],
          gateway: runtime,
          toolContext: {
            permissions: [http.name, remote.name],
            state: new Map(),
          },
        }),
    );
    assert.equal(result.result.answer, "complete");
    assert.equal(requests, 2);
    assert.equal(result.toolCalls, 2);
    assert.equal(await tracer.flush(), true);
    assert.equal(httpCalls, 1);
    assert.equal(mcpCalls, 1);
    assert.ok(
      spans.some(
        (s) => s.name === "tool_attempt" && s.metadata.toolVersionId === 88,
      ),
    );
    assert.ok(
      spans.some(
        (s) =>
          s.name === "tool_attempt" &&
          s.metadata.toolVersionId === 89 &&
          s.metadata.mcpServerId === 14,
      ),
    );
    assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
    assert.doesNotMatch(
      JSON.stringify(spans),
      /PRIVATE_|Authorization|authorization|Bearer/,
    );
  } finally {
    await tracer.close();
  }
});

async function requestWithSummary(failSummary = false) {
  const { ConversationService } = await import(
    "../dist/chat/conversation.service.js"
  );
  const { DEFAULT_AGENT_CONFIGURATION } = await import(
    "../dist/config/agent-config.js"
  );
  const { ProviderAuthenticationError } = await import(
    "../dist/ai/providers/provider-errors.js"
  );
  const spans = [],
    tracer = new TestExecutionTracer(
      { enabled: true, project: "fixture" },
      collectOtlpSpans(spans),
    );
  let release, started, saved, summary;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const summaryStarted = new Promise((resolve) => {
    started = resolve;
  });
  const summarySaved = new Promise((resolve) => {
    saved = resolve;
  });
  const llm = new LlmService({
    model: "fixture",
    chat: async (request) => {
      if (request.messages.at(-1).content.includes("PRIVATE_HISTORY")) {
        started();
        await gate;
        if (failSummary)
          throw Object.assign(new ProviderAuthenticationError(401), {
            diagnostics: { message: "PRIVATE_PROVIDER_AUTH" },
          });
      }
      return {
        content: request.messages.at(-1).content.includes("PRIVATE_HISTORY")
          ? "PRIVATE_MODEL_BODY"
          : "complete",
        model: "fixture",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      };
    },
  });
  const database = {
    query: async (sql, values) => {
      if (sql.includes("SELECT summary_through_message_id"))
        return {
          rows: [{ summaryThroughMessageId: null, agentMemoryScope: "scope" }],
        };
      if (sql.includes("SELECT id::int, role, content"))
        return {
          rows: Array.from({ length: 24 }, (_, i) => ({
            id: i + 1,
            role: i % 2 ? "assistant" : "user",
            content: "PRIVATE_HISTORY",
          })),
        };
      if (sql.includes("INSERT INTO conversation_runs"))
        return { rows: [{ id: values[0] }], rowCount: 1 };
      if (sql.includes("UPDATE conversations SET busy_until = now()"))
        return {
          rows: [{ id: "conversation-fixture", busyUntil: "busy-fixture" }],
          rowCount: 1,
        };
      if (sql.includes("INSERT INTO chat_traces")) {
        summary = { id: values[0], context: JSON.parse(values[2]) };
        saved();
      }
      return { rows: [], rowCount: 1 };
    },
    transaction: async (work) =>
      work({
        query: async (sql, values) => {
          if (sql.includes("INSERT INTO chat_traces")) {
            summary = { id: values[0], context: JSON.parse(values[2]) };
            saved();
          }
          return { rowCount: 1, rows: [] };
        },
      }),
  };
  let main;
  const snapshot = nativeChat({
    respond: () => {
      throw Error("Snapshot fixture supplier must not run");
    },
  }).snapshot;
  const execution = new AgentExecutionService(
    new DeepAgentExecutionService(
      llm,
      new ToolExecutionService(new ToolRegistry(), new ToolPolicy()),
      tracer,
    ),
  );
  const chat = {
    askDetailed: async (
      question,
      history,
      summary,
      onContext,
      _step,
      _commentary,
      _skill,
      _callbacks,
      input,
    ) => {
      const result = await execution.run(
        snapshot,
        { ...input, question, recentHistory: history, summary },
        { onContext },
      );
      return { ...result, traceId: input.traceId };
    },
  };
  const service = new ConversationService(
    database,
    chat,
    llm,
    undefined,
    { agent: DEFAULT_AGENT_CONFIGURATION },
    undefined,
    undefined,
    undefined,
    undefined,
    tracer,
  );
  service.snapshot = async () => ({
    summary: "PRIVATE_PREVIOUS_SUMMARY",
    history: [],
    agentTranscript: [],
    contextBlocks: [],
    recentMessages: [],
  });
  service.saveResult = async (_id, _question, run, _duration, runId) => {
    main = { traceId: run.traceId, runId, context: run.contextSnapshot };
  };
  let answerFinished = false;
  try {
    const answering = service
      .ask(
        "owner-fixture",
        "conversation-fixture",
        "PRIVATE_QUESTION",
        undefined,
        undefined,
        "summary-acceptance",
      )
      .then((x) => {
        answerFinished = true;
        return x;
      });
    await summaryStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      answerFinished,
      true,
      "Answer must not await background summary",
    );
    assert.equal((await answering).answer, "complete");
    release();
    await summarySaved;
    // The DB completion callback runs just before the summary span's finalizer.
    await new Promise((resolve) => setImmediate(resolve));
    await tracer.flush();
    const root = spans.find((s) => s.name === "agent_request"),
      graph = spans.find((s) => s.name === "agent_execution"),
      child = spans.find((s) => s.name === "conversation_summary");
    assert.equal(root.metadata.localRunId, main.runId);
    assert.equal(root.metadata.localTraceId, main.traceId);
    assert.equal(graph.parentSpanId, root.spanId);
    assert.equal(child.parentSpanId, root.spanId);
    assert.equal(
      child.attributes["langsmith.span.parent_id"],
      root.attributes["langsmith.span.id"],
    );
    assert.equal(
      child.attributes["langsmith.trace.id"],
      root.attributes["langsmith.span.id"],
    );
    assert.equal(
      summary.context.externalTrace.rootRunId,
      root.attributes["langsmith.span.id"],
    );
    assert.ok(
      child.attributes["langsmith.span.dotted_order"].startsWith(
        root.attributes["langsmith.span.dotted_order"] + ".",
      ),
    );
    assert.equal(child.metadata.localTraceId, summary.id);
    assert.equal(summary.context.externalTrace.traceId, root.traceId);
    assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
    const attempt = spans.find(
      (s) => s.name === "model_attempt" && s.parentSpanId === child.spanId,
    );
    assert.equal(attempt.metadata.purpose, "summary");
    assert.equal(attempt.metadata.promptVersionId, null);
    assert.match(attempt.metadata.codePromptVersion, /^[a-f0-9]{64}$/);
    assert.equal(child.status.code, failSummary ? 2 : 1);
    assert.equal(root.status.code, 1);
    assert.doesNotMatch(
      JSON.stringify(spans),
      /PRIVATE_|previousSummary|messages|input\.value|output\.value/,
    );
  } finally {
    release();
    await tracer.close();
  }
}

test("request trace includes the graph and asynchronous summary without waiting for the summary response", () =>
  requestWithSummary());
test("background summary failure is traced under the successful request and retains the local summary Trace ID", () =>
  requestWithSummary(true));
