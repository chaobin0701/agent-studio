import { collectPhoenixSpans } from "./helpers/phoenix-collector.mjs";
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import {
  embeddingProfileSchema,
  embeddingFingerprint,
} from "../dist/documents/profile-embedding.js";
import { retrievalDecision } from "../dist/documents/retrieval-compatibility.js";
import { VersionSearchService } from "../dist/documents/version-search.service.js";
import { agentRetrievalSchema } from "../dist/documents/knowledge-config.js";
import { assertIndexCompatible } from "../dist/documents/index-compatibility.js";
import { ToolExecutionService } from "../dist/ai/tools/tool-execution.js";
import { ToolPolicy } from "../dist/ai/tools/tool-policy.js";
import { PhoenixExecutionTracer } from "../dist/observability/execution-tracer.js";
import { agentSchema } from "../dist/agent-management/resource.types.js";

test("new Agents default to fulltext while historical auto policies remain readable", () => {
  assert.equal(agentRetrievalSchema.parse({}).retrievalMode, "fulltext");
  const input = {
    responsibility: "Knowledge assistant",
    promptVersionId: 1,
    modelPlanVersionId: null,
    toolVersionIds: [],
    skillVersionIds: [],
    knowledgeBaseIds: [],
    runtime: {},
  };
  assert.equal(agentSchema.parse(input).retrieval.retrievalMode, "fulltext");
  assert.equal(
    agentSchema.parse({ ...input, retrieval: { retrievalMode: "auto" } })
      .retrieval.retrievalMode,
    "auto",
  );
});

const profile = (model = "model-a", id = 1) =>
  embeddingProfileSchema.parse({
    provider: "openai-compatible",
    baseUrl: "https://vectors.example.invalid/v1",
    model,
    dimensions: 2,
    profileId: id,
  });
const fingerprint = embeddingFingerprint(profile());

test("retrieval compatibility distinguishes models even when dimensions match", () => {
  assert.deepEqual(retrievalDecision("economy", "hybrid", null, fingerprint), {
    mode: "fulltext",
    fallbackReason: "index_has_no_vectors",
  });
  assert.deepEqual(
    retrievalDecision(
      "high_quality",
      "hybrid",
      embeddingFingerprint(profile("model-b")),
      fingerprint,
    ),
    { mode: "fulltext", fallbackReason: "model_mismatch" },
  );
  assert.deepEqual(
    retrievalDecision("high_quality", "vector", fingerprint, fingerprint),
    { mode: "vector", fallbackReason: null },
  );
  assert.deepEqual(
    retrievalDecision("high_quality", "fulltext", fingerprint, fingerprint),
    { mode: "fulltext", fallbackReason: null },
  );
  assert.deepEqual(retrievalDecision("economy", "auto", null), {
    mode: "fulltext",
    fallbackReason: null,
  });
  for (const [mode, indexFingerprint] of [
    ["economy", null],
    ["high_quality", embeddingFingerprint(profile("model-b"))],
  ]) {
    assert.throws(
      () => retrievalDecision(mode, "vector", indexFingerprint, fingerprint),
      (e) => e.getStatus() === 400,
    );
  }
});

function fixture() {
  const statements = [];
  const versions = [
    {
      id: 1,
      knowledgeBaseId: 1,
      config: { indexMode: "high_quality", embeddingProfileId: 1 },
      embedding_snapshot: profile("model-a", 1),
    },
    {
      id: 2,
      knowledgeBaseId: 2,
      config: { indexMode: "high_quality", embeddingProfileId: 2 },
      embedding_snapshot: profile("model-a", 2),
    },
    {
      id: 3,
      knowledgeBaseId: 3,
      config: { indexMode: "high_quality", embeddingProfileId: 4 },
      embedding_snapshot: profile("model-b", 4),
    },
    {
      id: 4,
      knowledgeBaseId: 4,
      config: { indexMode: "economy" },
      embedding_snapshot: null,
    },
  ];
  const hit = (id) => ({
    chunkId: id * 100,
    documentId: id,
    ordinal: 1,
    documentTitle: `Library ${id}`,
    headingPath: "",
    content: "Validated knowledge",
    score: 1,
  });
  const db = {
    query: async (sql, values) => {
      statements.push({ sql, values });
      if (sql.startsWith("SELECT v.id::int"))
        return {
          rows: versions.filter((v) => v.knowledgeBaseId === values[0]),
        };
      if (sql.startsWith("SELECT config,api_key_ciphertext")) {
        assert.equal(
          values[0],
          3,
          "use the Agent-selected profile credentials, not the library profile",
        );
        return {
          rows: [
            {
              config: profile("model-a", 3),
              api_key_ciphertext: null,
              model_account_id: null,
            },
          ],
        };
      }
      if (sql.startsWith("SELECT count(*)")) return { rows: [{ count: 1 }] };
      if (sql.startsWith("WITH scored") || sql.startsWith("WITH compatible"))
        return { rows: [hit(values[0])] };
      throw Error("Unexpected retrieval SQL");
    },
  };
  const runtime = {
    embedding: {
      baseUrl: profile().baseUrl,
      apiKey: "fixture-query-key",
      allowedBaseUrls: [profile().baseUrl],
      connections: {},
    },
  };
  return {
    service: new VersionSearchService(db, runtime),
    statements,
    scope: versions.map((v) => ({
      id: v.knowledgeBaseId,
      indexVersionId: v.id,
    })),
  };
}

test("library diagnostics still adapt to index capabilities independently of Agent defaults", async (t) => {
  const { service } = fixture();
  t.mock.method(service, "retrieve", async (_query, _versions, policy) => ({
    mode: policy.retrievalMode,
  }));
  assert.equal((await service.search("test knowledge", 5, 1, 1)).mode, "auto");
  assert.equal(
    (await service.search("test knowledge", 5, 1, 1, {})).mode,
    "fulltext",
  );
});

test("hybrid uses the chosen Agent model once and falls back independently for incompatible libraries", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    assert.equal(JSON.parse(options.body).model, "model-a");
    return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
  });
  const { service, statements, scope } = fixture();
  const result = await service.searchMany(
    "test knowledge",
    scope,
    agentRetrievalSchema.parse({ retrievalMode: "hybrid" }),
    profile("model-a", 3),
  );
  assert.equal(calls, 1);
  assert.equal(result.embeddingCalls, 1);
  assert.deepEqual(result.hits.map((h) => h.documentId).sort(), [1, 2, 3, 4]);
  const configs = new Map(
    result.retrievalConfigs.map((c) => [c.knowledgeBaseId, c]),
  );
  assert.equal(configs.get(1).embeddingProfileId, 3);
  assert.equal(configs.get(2).config.retrievalMode, "hybrid");
  assert.equal(configs.get(3).config.retrievalMode, "fulltext");
  assert.equal(configs.get(3).fallbackReason, "model_mismatch");
  assert.equal(configs.get(4).fallbackReason, "index_has_no_vectors");
  assert.equal(configs.get(4).requestedRetrievalMode, "hybrid");
  assert.deepEqual(
    statements
      .filter((s) => s.sql.startsWith("WITH compatible"))
      .map((s) => s.values[0])
      .sort(),
    [1, 2],
  );
  assert.ok(!JSON.stringify(result).includes("fixture-query-key"));
});

test("pure vector rejects model mismatch instead of silently returning fulltext", async () => {
  const { service, statements, scope } = fixture();
  await assert.rejects(
    service.searchMany(
      "test knowledge",
      [scope[2]],
      agentRetrievalSchema.parse({ retrievalMode: "vector" }),
      profile("model-a", 3),
    ),
    (e) => e.getStatus() === 400,
  );
  assert.equal(
    statements.some(
      (s) => s.sql.startsWith("WITH") || s.sql.includes("api_key_ciphertext"),
    ),
    false,
  );
  await assert.rejects(
    service.searchMany(
      "test knowledge",
      [{ id: 4, indexVersionId: null }],
      agentRetrievalSchema.parse({ retrievalMode: "vector" }),
      profile(),
    ),
    (e) => e.getStatus() === 400,
  );
});

test("compatible pure-vector searches use the selected model and do not run lexical queries", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ data: [{ index: 0, embedding: [1, 0] }] }),
  );
  const { service, statements, scope } = fixture();
  const result = await service.searchMany(
    "test knowledge",
    [scope[0]],
    agentRetrievalSchema.parse({ retrievalMode: "vector" }),
    profile("model-a", 3),
  );
  assert.equal(result.retrievalMode, "vector");
  assert.equal(result.embeddingCalls, 1);
  assert.equal(result.retrievalConfigs[0].fallbackReason, null);
  assert.equal(
    statements.some((s) => s.sql.startsWith("WITH scored")),
    false,
  );
});

test("fulltext never generates an embedding even when a profile is supplied", async () => {
  const { service, statements, scope } = fixture();
  const result = await service.searchMany(
    "test knowledge",
    scope,
    agentRetrievalSchema.parse({}),
    profile(),
  );
  assert.equal(result.embeddingCalls, 0);
  assert.equal(
    statements.some(
      (s) =>
        s.sql.includes("api_key_ciphertext") ||
        s.sql.startsWith("WITH compatible"),
    ),
    false,
  );
});

test("index switches allow hybrid fallbacks but protect pure vector model compatibility", async () => {
  await assertIndexCompatible(
    {
      query: async (sql) => {
        assert.match(sql, /retrievalMode'='vector'/);
        return { rows: [] };
      },
    },
    1,
    { indexMode: "economy" },
  );
  const bound = {
    query: async () => ({
      rows: [
        {
          name: "Pure vector",
          embeddingPlanVersionId: 1,
          embeddingConfig: profile(),
        },
      ],
    }),
  };
  await assert.rejects(
    assertIndexCompatible(
      bound,
      1,
      { indexMode: "high_quality" },
      profile("model-b"),
    ),
    (e) => e.getStatus() === 409,
  );
  await assert.rejects(
    assertIndexCompatible(bound, 1, { indexMode: "economy" }),
    (e) => e.getStatus() === 409,
  );
  await assertIndexCompatible(
    bound,
    1,
    { indexMode: "high_quality" },
    profile("model-a", 8),
  );
});

test("knowledge execution traces retain effective modes and fallback reasons but strip arbitrary metadata", async () => {
  const tool = {
    name: "search_knowledge",
    inputSchema: { safeParse: (input) => ({ success: true, data: input }) },
    execute: async () => ({
      success: true,
      content: "Validated evidence",
      metadata: {
        embeddingPlanVersionId: 7,
        embeddingCalls: 0,
        secret: "must-not-be-traced",
        retrievalConfigs: [
          {
            knowledgeBaseId: 1,
            indexVersionId: 2,
            config: { retrievalMode: "fulltext", apiKey: "must-not-be-traced" },
            requestedRetrievalMode: "hybrid",
            fallbackReason: "model_mismatch",
            embeddingProfileId: null,
          },
        ],
      },
    }),
  };
  const runtime = new ToolExecutionService(
    { get: () => tool },
    new ToolPolicy(),
  );
  const outcome = await runtime.execute(
    "search_knowledge",
    { query: "test knowledge" },
    { permissions: [], state: new Map() },
    runtime.createState(),
  );
  assert.equal(outcome.trace.retrieval.embeddingPlanVersionId, 7);
  assert.equal(
    outcome.trace.retrieval.retrievalConfigs[0].fallbackReason,
    "model_mismatch",
  );
  assert.equal(
    outcome.trace.retrieval.retrievalConfigs[0].config.retrievalMode,
    "fulltext",
  );
  assert.ok(!JSON.stringify(outcome.trace).includes("must-not-be-traced"));
});

test("traced multi-library retrieval shares one embedding and exports only recall/fusion metadata", async (t) => {
  const exported = [];
  const tracer = new PhoenixExecutionTracer(
    { enabled: true, project: "fixture" },
    collectPhoenixSpans(exported),
  );
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ data: [{ index: 0, embedding: [1, 0] }] }),
  );
  const { service, scope } = fixture();
  await tracer.span("agent_graph", "chain", {}, async () =>
    service.searchMany(
      "PRIVATE_RETRIEVAL_QUERY",
      scope,
      agentRetrievalSchema.parse({ retrievalMode: "hybrid" }),
      profile("model-a", 3),
    ),
  );
  await tracer.flush();
  assert.equal(exported.filter((r) => r.name === "query_embedding").length, 1);
  assert.equal(
    exported.filter((r) => r.name === "knowledge_base_retrieval").length,
    4,
  );
  assert.equal(exported.filter((r) => r.name === "fulltext_recall").length, 4);
  assert.equal(exported.filter((r) => r.name === "vector_recall").length, 2);
  assert.equal(
    exported.filter((r) => r.name === "fuse_knowledge_candidates").length,
    1,
  );
  assert.ok(
    exported.some((r) => r.metadata.fallbackReason === "model_mismatch"),
  );
  assert.equal(new Set(exported.map((r) => r.traceId)).size, 1);
  assert.doesNotMatch(
    JSON.stringify(exported),
    /PRIVATE_RETRIEVAL_QUERY|fixture-query-key|Validated knowledge|WITH scored/,
  );
});

test("knowledge cancellation stops credential/embedding work and never returns partial recall as completed", async (t) => {
  const { service, scope } = fixture();
  const abort = new AbortController();
  abort.abort(Error("cancel retrieval"));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
  });
  await assert.rejects(
    service.searchMany(
      "cancelled query",
      scope,
      agentRetrievalSchema.parse({ retrievalMode: "hybrid" }),
      profile("model-a", 3),
      abort.signal,
    ),
    /cancel retrieval/,
  );
  assert.equal(calls, 0);
});
