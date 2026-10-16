import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { nativeChat } from "./helpers/native-chat.mjs";
import { KnowledgeSearchTool } from "../dist/ai/tools/knowledge-search.tool.js";
import { DEFAULT_AGENT_CONFIGURATION } from "../dist/config/agent-config.js";

const hit = {
  chunkId: 12,
  documentId: 3,
  documentTitle: "Returns policy",
  originalFilename: "returns.md",
  ordinal: 0,
  headingPath: "Conditions",
  content: "Returns are accepted within seven days.",
  sourceStartLine: 2,
  sourceEndLine: 4,
  score: 0.86,
};
const input = {
  question: "What is the returns policy?",
  summary: "",
  recentHistory: [],
};
const native = (id, name, args = {}) => ({
  content: "",
  toolCalls: [{ id, name, arguments: args }],
});
const final = {
  content: JSON.stringify({
    answer: "Returns are accepted within seven days.",
    citationIds: [12],
  }),
};
const searchTool = () =>
  new KnowledgeSearchTool({
    searchForAgent: async () => ({
      hits: [hit],
      retrievalMode: "lexical-only",
      vectorIndexedChunks: 0,
    }),
  });

test("native public progress precedes real capability execution and never exposes model bodies, arguments or tool results", async (t) => {
  for (const name of [
    "list_product_categories",
    "list_products",
    "get_product_detail",
  ])
    await t.test(name, async () => {
      const progress = [],
        order = [];
      const tool = {
        name,
        description: "Read authorized source",
        inputSchema: z.object({ id: z.string() }),
        execute: async () => {
          assert.ok(
            progress.some(
              (event) => event.stage === "tool" && event.status === "running",
            ),
          );
          order.push("execute");
          return { success: true, content: "PRIVATE_TOOL_RESULT" };
        },
      };
      const f = nativeChat({
        tools: [tool],
        respond: (_request, round) =>
          round === 1
            ? native("read", name, { id: "PRIVATE_ARGUMENT" })
            : { content: "Public answer" },
      });
      const result = await f.runner.run(input, {
        onProgress: (event) => {
          progress.push(event);
          if (event.stage === "tool") order.push(event.status === "running" ? "started" : "completed");
        },
      });
      assert.equal(result.result.answer, "Public answer");
      assert.deepEqual(order, ["started", "execute", "completed"]);
      assert.doesNotMatch(
        JSON.stringify(progress),
        /PRIVATE_|arguments|toolCallId/,
      );
      assert.equal(f.requests.length, 2);
    });
});

test("knowledge capability separates bounded model content from backend evidence and preserves its existing schema", async () => {
  let topK;
  const tool = new KnowledgeSearchTool({
    searchForAgent: async (query, k) => {
      assert.equal(query, "returns");
      topK = k;
      return { hits: [hit], retrievalMode: "hybrid", vectorIndexedChunks: 4 };
    },
  });
  const parsed = tool.inputSchema.safeParse({ query: "returns", topK: 3 });
  assert.equal(parsed.success, true);
  const result = await tool.execute(parsed.data, {
    permissions: [],
    state: new Map(),
  });
  assert.equal(topK, 3);
  assert.deepEqual(result.data.hits, [hit]);
  assert.equal(result.data.lexicalResults, undefined);
  assert.equal(result.metadata.retrievalMode, "hybrid");
  assert.match(result.content, /\[12\]/);
  assert.equal(
    tool.inputSchema.safeParse({ query: "returns", topK: 9 }).success,
    false,
  );
});

test("native decision budget terminates repeated identical calls without replaying the successful knowledge query", async () => {
  let queries = 0;
  const configuration = structuredClone(DEFAULT_AGENT_CONFIGURATION);
  configuration.runtime.maxPlannerRounds = 2;
  const tool = {
    name: "search_knowledge",
    description: "Read",
    inputSchema: z.object({ query: z.string() }),
    execute: async () => {
      queries++;
      return { success: true, content: "Retrieved source" };
    },
  };
  const f = nativeChat({
    configuration,
    tools: [tool],
    respond: (_request, round) =>
      native(`search-${round}`, tool.name, { query: "returns" }),
  });
  let context;
  await assert.rejects(
    f.runner.run(input, {
      onContext: (value) => {
        context = value;
      },
    }),
    (error) => error.code === "agent_budget_exceeded",
  );
  assert.equal(f.requests.length, 2);
  assert.equal(queries, 1);
  assert.ok(
    context.toolCalls.some((call) => call.errorCode === "duplicate_tool_call"),
  );
  assert.equal(context.errorSummary.errorCode, "agent_budget_exceeded");
});

test("native knowledge tool plus final answer returns real citations and known usage with exactly two models", async () => {
  const tool = searchTool();
  const f = nativeChat({
    tools: [tool],
    knowledge: [{ id: 1, indexVersionId: 10 }],
    respond: (_request, round) =>
      round === 1 ? native("search", tool.name, { query: "returns" }) : final,
  });
  const result = await f.runner.run(input);
  assert.equal(result.result.refused, false);
  assert.equal(result.result.answer, "Returns are accepted within seven days.");
  assert.deepEqual(result.result.citations, [
    {
      chunkId: 12,
      documentId: 3,
      documentTitle: hit.documentTitle,
      originalFilename: "returns.md",
      sourceStartLine: 2,
      sourceEndLine: 4,
    },
  ]);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.inputTokens, 20);
  assert.equal(result.outputTokens, 10);
  assert.equal(result.totalTokens, 30);
  assert.equal(f.requests.length, 2);
  assert.equal(result.contextSnapshot.executionEngine, "deepagents");
});

test("native model-visible knowledge schema and call ID reach the platform gateway without old planner format or body replay", async () => {
  const tool = searchTool();
  const f = nativeChat({
    tools: [tool],
    knowledge: [{ id: 1, indexVersionId: 10 }],
    respond: (request, round) => {
      assert.ok(request.tools.some((item) => item.name === tool.name));
      assert.equal(request.responseFormat, undefined);
      if (round === 1)
        return native("native-knowledge-7", tool.name, { query: "returns" });
      assert.equal(
        request.messages.find((message) => message.role === "tool").toolCallId,
        "native-knowledge-7",
      );
      return final;
    },
  });
  const result = await f.runner.run({
    ...input,
    conversationId: "native-knowledge",
  });
  assert.equal(
    result.contextSnapshot.runtimeContextBlocks[0].toolCallId,
    "native-knowledge-7",
  );
  assert.equal(
    result.contextSnapshot.agentTranscript.some(
      (message) => message.role === "tool",
    ),
    false,
  );
  assert.equal(result.result.citations[0].chunkId, 12);
});

test("native model recovers from a safe failed capability result without another tool attempt", async () => {
  let queries = 0;
  const tool = {
    name: "read_record",
    description: "Read",
    inputSchema: z.object({ id: z.string() }),
    execute: async () => {
      queries++;
      return {
        success: false,
        content: "Not found",
        errorCode: "product_not_found",
      };
    },
  };
  const f = nativeChat({
    tools: [tool],
    respond: (request, round) =>
      round === 1
        ? native("lookup", tool.name, { id: "missing" })
        : (() => {
            assert.match(JSON.stringify(request.messages), /product_not_found/);
            return { content: "Please provide another model" };
          })(),
  });
  const result = await f.runner.run(input);
  assert.equal(result.result.answer, "Please provide another model");
  assert.equal(result.toolCalls[0].errorCode, "product_not_found");
  assert.equal(queries, 1);
  assert.equal(f.requests.length, 2);
});

test("a native greeting needs no knowledge, preflight, Skill classification or extra answer model", async () => {
  const f = nativeChat({ respond: () => ({ content: "Hello" }) });
  const result = await f.runner.run({
    question: "Hello",
    summary: "",
    recentHistory: [],
  });
  assert.equal(result.result.answer, "Hello");
  assert.equal(result.result.refused, false);
  assert.equal(f.requests.length, 1);
  assert.equal(result.contextSnapshot.toolCalls.length, 0);
  assert.equal(result.contextSnapshot.preflight, undefined);
  assert.deepEqual(result.contextSnapshot.specialistTasks, []);
  assert.equal(result.contextSnapshot.products, undefined);
});
