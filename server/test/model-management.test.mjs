import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
import { ModelManagementService } from "../dist/model-management/model-management.service.js";
import { ManagedRuntimeProvider } from "../dist/model-management/model-route.js";
import { ModelManagementPermissionGuard } from "../dist/model-management/model-management.controller.js";
import { SecretBox } from "../dist/security/secret-box.js";
import {
  embeddingFingerprint,
  embeddingProfileSchema,
} from "../dist/documents/profile-embedding.js";
import { embedForProfile } from "../dist/documents/embedding-runtime.js";
import { LlmService } from "../dist/chat/llm.service.js";
import { withModelCallAccounting } from "../dist/chat/model-call-accounting.js";

const endpoint = "https://model.example.invalid/v1";
const runtime = {
  llm: {
    provider: "openai-compatible",
    baseUrl: endpoint,
    allowedBaseUrls: [endpoint],
    apiKey: "fixture-env-key",
    model: "environment",
    timeoutMs: 1000,
    contextWindowTokens: 32000,
    maxOutputTokens: 1200,
  },
  embedding: {
    baseUrl: endpoint,
    allowedBaseUrls: [endpoint],
    apiKey: "fixture-env-key",
    connections: {},
  },
  jwt: { secret: "fixture-encryption-key" },
};
const secrets = new SecretBox(runtime);
const llmConfig = {
  provider: "openai-compatible",
  model: "primary",
  timeoutMs: 1000,
  contextWindowTokens: 32000,
  maxOutputTokens: 1200,
  maxRetries: 1,
};
const embedConfig = {
  provider: "openai-compatible",
  model: "vectors",
  dimensions: 2,
  timeoutMs: 1000,
  maxInputChars: 8000,
  batchSize: 16,
};
function plan(id = 1, model = "primary") {
  return {
    id,
    plan_id: id,
    version: 1,
    status: "published",
    kind: "llm",
    name: "fixture",
    config: {
      deployments: [
        {
          id: 10,
          accountId: 10,
          name: "主",
          baseUrl: endpoint,
          config: { ...llmConfig, model },
        },
        {
          id: 20,
          accountId: 20,
          name: "备",
          baseUrl: endpoint,
          config: {
            ...llmConfig,
            model: "backup",
            contextWindowTokens: 16000,
            maxOutputTokens: 800,
            maxRetries: 0,
          },
        },
      ],
    },
  };
}
function sse(content = "ok") {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
function probeFetch(_url, options) {
  const body = JSON.parse(options.body);
  if (body.input)
    return Response.json({
      data: body.input.map((_, index) => ({ index, embedding: [1, 0] })),
    });
  if (body.stream) return sse("连接成功");
  if (body.tools)
    return Response.json({
      model: body.model,
      choices: [
        {
          message: {
            role: "assistant",
            content: "{}",
            tool_calls: [
              {
                id: "probe",
                type: "function",
                function: {
                  name: "connection_probe",
                  arguments: '{"probe":"connection-test"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
  return Response.json({
    model: body.model,
    choices: [
      {
        message: { role: "assistant", content: '{"message":"连接成功"}' },
        finish_reason: "stop",
      },
    ],
  });
}

test("management permission guard checks the requested kind and operation, never a permission from the other kind", async () => {
  const guard = new ModelManagementPermissionGuard({
    query: async () => {
      throw Error("Global role must not override workspace membership");
    },
  });
  const context = (kind, method, permissions = ["model_profiles.manage"]) => ({
    switchToHttp: () => ({
      getRequest: () => ({
        admin: { id: 1 },
        params: { kind },
        method,
        workspacePermissionCodes: permissions,
      }),
    }),
  });
  assert.equal(await guard.canActivate(context("llm", "POST")), true);
  await assert.rejects(
    guard.canActivate(context("embedding", "PATCH")),
    (e) => e.getStatus() === 403,
  );
  await assert.rejects(
    guard.canActivate(context("llm", "PATCH", ["model_profiles.read"])),
    (e) => e.getStatus() === 403,
  );
  assert.equal(
    await guard.canActivate(
      context("embedding", "GET", ["embedding_profiles.read"]),
    ),
    true,
  );
  await assert.rejects(
    guard.canActivate(context("invalid", "GET")),
    (e) => e.getStatus() === 400,
  );
});

test("routing freezes version across planner/answer, retries primary before ordered fallback and meters every actual call", async (t) => {
  let active = plan(),
    key = "first";
  const calls = [],
    reservations = [];
  const provider = new ManagedRuntimeProvider(
    { activePlan: async () => active, credential: async () => key },
    () => ({ model: "environment" }),
  );
  const llm = new LlmService(provider);
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push({
      model: body.model,
      key: new Headers(options.headers).get("authorization"),
    });
    if (body.model === "primary")
      return Response.json(
        { error: { message: "unavailable" } },
        { status: 503 },
      );
    return Response.json({
      model: body.model,
      choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
  });
  await llm.withModelPlan(async () => {
    assert.equal(llm.model, "primary");
    assert.equal(llm.contextWindowTokens, 16000);
    assert.equal(llm.maxOutputTokens, 800);
    active = plan(2, "new-primary");
    const result = await withModelCallAccounting(
      {
        reserve: async (r) => {
          reservations.push(r.model);
          return { settle: async () => {} };
        },
      },
      () =>
        llm.completeDetailed("s", "q", llm.model, "planner", {
          retryDelaysMs: [0],
        }),
    );
    assert.equal(result.model, "backup");
    assert.equal(result.attempts, 3);
    assert.deepEqual(
      result.attemptsTrail.map((a) => [a.deploymentId, a.versionId]),
      [
        [10, 1],
        [10, 1],
        [20, 1],
      ],
    );
    key = "rotated";
    await llm.completeDetailed("s", "q", llm.model, "answer", {
      maxRetries: 0,
      retryDelaysMs: [0],
    });
    assert.deepEqual(llm.planMetadata(), {
      versionId: 1,
      planId: 1,
      version: 1,
    });
  });
  assert.deepEqual(reservations, ["primary", "primary", "backup"]);
  assert.equal(calls.at(-1).key, "Bearer rotated");
  await llm.withModelPlan(async () => assert.equal(llm.model, "new-primary"));
});

test("stream fallback rewrites model and stops after any emitted text; auth failures never switch", async (t) => {
  const provider = new ManagedRuntimeProvider(
    { activePlan: async () => plan(), credential: async () => "fixture-key" },
    () => ({ model: "environment" }),
  );
  const llm = new LlmService(provider);
  const calls = [];
  const mock = t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.model);
    if (body.model === "primary")
      return Response.json({ error: {} }, { status: 503 });
    return sse();
  });
  const result = await llm.streamDetailed("s", "q", undefined, "answer", {
    retryDelaysMs: [0],
  });
  assert.equal(result.model, "backup");
  assert.deepEqual(calls, ["primary", "primary", "backup"]);
  calls.length = 0;
  mock.mock.mockImplementation(async (_url, options) => {
    calls.push(JSON.parse(options.body).model);
    return Response.json({ error: {} }, { status: 401 });
  });
  await assert.rejects(
    llm.completeDetailed("s", "q", undefined, "answer", { retryDelaysMs: [0] }),
  );
  assert.deepEqual(calls, ["primary"]);
  calls.length = 0;
  mock.mock.mockImplementation(async (_url, options) => {
    calls.push(JSON.parse(options.body).model);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
            ),
          );
          setTimeout(() => controller.error(new Error("connection closed")), 1);
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const deltas = [];
  await assert.rejects(
    llm.streamDetailed(
      "s",
      "q",
      undefined,
      "answer",
      { retryDelaysMs: [0] },
      { onTextDelta: (t) => deltas.push(t) },
    ),
  );
  assert.deepEqual(calls, ["primary"]);
  assert.deepEqual(deltas, ["partial"]);
});

test("managed retry status uses deployment counters and never treats application errors as transient", async (t) => {
  const provider = new ManagedRuntimeProvider(
    { activePlan: async () => plan(), credential: async () => "fixture-key" },
    () => ({ model: "environment" }),
  );
  const llm = new LlmService(provider);
  const statuses = [];
  t.mock.method(globalThis, "fetch", async (_url, options) =>
    JSON.parse(options.body).model === "primary"
      ? Response.json({ error: {} }, { status: 503 })
      : sse(),
  );
  await llm.streamDetailed(
    "s",
    "q",
    undefined,
    "answer",
    { retryDelaysMs: [0] },
    { onRetryStatus: (e) => statuses.push(e) },
  );
  assert.deepEqual(
    statuses.map((e) => [e.state, e.attempt, e.maxAttempts]),
    [
      ["waiting", 1, 1],
      ["waiting", 0, 0],
      ["recovered", 0, 0],
    ],
  );
  let calls = 0;
  provider.attemptPlan = () => [
    {
      provider: {
        model: "fixture",
        chat: async () => {
          calls++;
          throw new Error("application failure");
        },
        async *stream() {
          calls++;
          throw new Error("application failure");
        },
      },
      deploymentId: 10,
      versionId: 1,
      deploymentAttempt: 1,
      maxRetries: 3,
    },
  ];
  await assert.rejects(
    llm.completeDetailed("s", "q"),
    (e) => e.errorKind === "unknown" && !e.retryExhausted,
  );
  await assert.rejects(
    llm.streamDetailed("s", "q"),
    (e) => e.errorKind === "unknown" && !e.retryExhausted,
  );
  assert.equal(calls, 2);
});

test("managed stream EOF without a finish reason is interrupted and never replayed after text", async (t) => {
  const provider = new ManagedRuntimeProvider(
    { activePlan: async () => plan(), credential: async () => "fixture-key" },
    () => ({ model: "environment" }),
  );
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const deltas = [];
  await assert.rejects(
    new LlmService(provider).streamDetailed(
      "s",
      "q",
      undefined,
      "answer",
      { retryDelaysMs: [0] },
      { onTextDelta: (e) => deltas.push(e) },
    ),
    (e) => e.errorCode === "missing_completion_event" && !e.retryExhausted,
  );
  assert.deepEqual(deltas, ["partial"]);
  assert.equal(calls, 1);
});

test("cancel during backoff does not call another deployment", async (t) => {
  const provider = new ManagedRuntimeProvider(
    { activePlan: async () => plan(), credential: async () => "fixture-key" },
    () => ({ model: "environment" }),
  );
  const llm = new LlmService(provider);
  const abort = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ error: {} }, { status: 503 });
  });
  await assert.rejects(
    llm.completeDetailed("s", "q", undefined, "answer", {
      signal: abort.signal,
      retryDelaysMs: [5000],
      onRetryStatus: () => abort.abort(),
    }),
  );
  assert.equal(calls, 1);
});

test(
  "PostgreSQL: migrate legacy bindings, test/publish/rollback, immutable geometry, live key rotation and safe reads",
  { skip: process.env.KB_INTEGRATION !== "1" },
  async (t) => {
    const client = new Client({
      host: process.env.POSTGRES_HOST ?? "127.0.0.1",
      port: Number(process.env.POSTGRES_PORT ?? 5433),
      user: process.env.POSTGRES_USER ?? "grounded",
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB ?? "agent_studio",
    });
    await client.connect();
    const schema = "model_test_" + randomUUID().replaceAll("-", "");
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}", public`);
      const directory = new URL("../migrations/", import.meta.url);
      const files = (await readdir(directory))
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const file of files.filter((f) => f < "0035"))
        await client.query(
          (await readFile(new URL(file, directory), "utf8")).split(
            "-- Down Migration",
          )[0],
        );
      const actor = Number(
        (
          await client.query(
            "INSERT INTO admins(email,password_hash,display_name) VALUES('models@example.invalid','fixture','models') RETURNING id",
          )
        ).rows[0].id,
      );
      const legacyLlm = await client.query(
        "INSERT INTO llm_profiles(name,platform_key,base_url,model,api_key_ciphertext,is_default) VALUES('legacy','custom',$1,'primary',$2,true) RETURNING id",
        [endpoint, secrets.encrypt("legacy-key")],
      );
      const frozen = embeddingProfileSchema.parse({
        ...embedConfig,
        baseUrl: endpoint,
      });
      const oldEmbed = Number(
        (
          await client.query(
            "INSERT INTO embedding_profiles(name,platform_key,config,api_key_ciphertext) VALUES('old vectors','custom',$1,$2) RETURNING id",
            [JSON.stringify(frozen), secrets.encrypt("legacy-vectors-key")],
          )
        ).rows[0].id,
      );
      await client.query(
        "UPDATE embedding_profiles SET config=$2 WHERE id=$1",
        [
          oldEmbed,
          JSON.stringify({
            ...frozen,
            profileId: oldEmbed,
            fingerprint: embeddingFingerprint(frozen),
          }),
        ],
      );
      for (const file of files.filter((f) => f >= "0035"))
        await client.query(
          (await readFile(new URL(file, directory), "utf8")).split(
            "-- Down Migration",
          )[0],
        );
      const database = {
        query: (sql, args) => client.query(sql, args),
        transaction: async (work) => {
          await client.query("SAVEPOINT service_call");
          try {
            const value = await work(client);
            await client.query("RELEASE SAVEPOINT service_call");
            return value;
          } catch (e) {
            await client.query("ROLLBACK TO SAVEPOINT service_call");
            throw e;
          }
        },
      };
      const service = new ModelManagementService(database, runtime, secrets);
      await service.onModuleInit();
      const initial = await service.activePlan();
      assert.equal(initial.config.deployments[0].config.model, "primary");
      assert.equal(legacyLlm.rowCount, 1);
      const migrated = (
        await client.query("SELECT * FROM embedding_profiles WHERE id=$1", [
          oldEmbed,
        ])
      ).rows[0];
      assert.equal(migrated.config.fingerprint, embeddingFingerprint(frozen));
      assert.ok(migrated.model_account_id);
      const llmList = await service.list("llm");
      assert.equal(llmList.versions.length, 1);
      assert.ok(!JSON.stringify(llmList).includes("legacy-key"));
      t.mock.method(globalThis, "fetch", probeFetch);
      const clone = await service.clone(actor, "llm", initial.id);
      await assert.rejects(
        service.activate(actor, "llm", clone.id),
        (e) => e.getStatus() === 409,
      );
      await assert.rejects(
        service.publish(actor, "llm", clone.id),
        (e) => e.getStatus() === 409,
      );
      assert.equal(
        (await service.testVersion(actor, "llm", clone.id)).ok,
        true,
      );
      const a = llmList.accounts[0].id;
      await service.updateAccount(actor, "llm", a, {
        apiKey: "rotated-secret",
      });
      await assert.rejects(
        service.publish(actor, "llm", clone.id),
        (e) => e.getStatus() === 409,
      );
      await service.testVersion(actor, "llm", clone.id);
      await service.publish(actor, "llm", clone.id);
      await service.activate(actor, "llm", clone.id);
      await assert.rejects(
        service.updateDraft(actor, "llm", clone.id, {
          revision: 1,
          deploymentIds: [llmList.deployments[0].id],
        }),
        (e) => e.getStatus() === 409,
      );
      await assert.rejects(
        database.transaction((c) =>
          c.query("UPDATE model_plan_versions SET config=$2 WHERE id=$1", [
            clone.id,
            "{}",
          ]),
        ),
        /immutable/,
      );
      await service.saveDeployment(actor, "llm", llmList.deployments[0].id, {
        name: "changed",
        accountId: a,
        config: { ...llmConfig, model: "new" },
      });
      assert.equal(
        (await service.version(database, "llm", clone.id)).config.deployments[0]
          .config.model,
        "primary",
      );
      await service.activate(actor, "llm", initial.id);
      assert.equal((await service.activePlan()).id, initial.id);
      await assert.rejects(
        service.updateAccount(actor, "llm", a, { enabled: false }),
        (e) => e.getStatus() === 409,
      );
      const ea = await service.createAccount(actor, "embedding", {
        name: "vectors account",
        platformKey: "custom",
        baseUrl: endpoint,
        apiKey: "vectors-key",
      });
      const ed = await service.saveDeployment(actor, "embedding", null, {
        name: "vector deployment",
        accountId: ea.id,
        config: embedConfig,
      });
      await assert.rejects(
        service.createPlan(actor, "embedding", {
          name: "bad",
          deploymentIds: [ed.id, ed.id],
        }),
        (e) => e.getStatus() === 400,
      );
      const ev = await service.createPlan(actor, "embedding", {
        name: "vectors plan",
        deploymentIds: [ed.id],
      });
      await service.testVersion(actor, "embedding", ev.id);
      await service.publish(actor, "embedding", ev.id);
      const ep = (
        await client.query(
          "SELECT id::int,config FROM embedding_profiles WHERE model_plan_version_id=$1",
          [ev.id],
        )
      ).rows[0];
      assert.equal(ep.config.dimensions, 2);
      const fingerprint = ep.config.fingerprint;
      await client.query(
        "INSERT INTO knowledge_bases(name,draft_config) VALUES('vector usage',$1)",
        [JSON.stringify({ embeddingProfileId: ep.id })],
      );
      const usageVersion = (await service.list("embedding")).versions.find(
        (v) => v.id === ev.id,
      );
      assert.equal(usageVersion.knowledge_bases[0].name, "vector usage");
      assert.equal(usageVersion.knowledge_bases[0].configured, true);
      await service.saveDeployment(actor, "embedding", ed.id, {
        name: "next",
        accountId: ea.id,
        config: { ...embedConfig, model: "new-space", dimensions: 3 },
      });
      assert.equal(
        (
          await client.query(
            "SELECT config FROM embedding_profiles WHERE id=$1",
            [ep.id],
          )
        ).rows[0].config.fingerprint,
        fingerprint,
      );
      await service.updateAccount(actor, "embedding", ea.id, {
        apiKey: "vector-key-rotated",
      });
      const mock = t.mock.method(globalThis, "fetch", async (_url, options) => {
        assert.equal(
          new Headers(options.headers).get("authorization"),
          "Bearer vector-key-rotated",
        );
        assert.equal(JSON.parse(options.body).model, "vectors");
        return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
      });
      await embedForProfile(database, runtime, ep.config, ["文本"]);
      assert.equal(mock.mock.callCount(), 1);
      await assert.rejects(
        service.updateAccount(actor, "embedding", ea.id, { enabled: false }),
        (e) => e.getStatus() === 409,
      );
      await assert.rejects(
        service.activate(actor, "embedding", ev.id),
        (e) => e.getStatus() === 400,
      );
      const audits = (
        await client.query(
          "SELECT * FROM audit_logs WHERE target_type='model_management'",
        )
      ).rows;
      assert.ok(audits.length > 10);
      assert.ok(!JSON.stringify(audits).includes("rotated-secret"));
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);

test("probe uses deployment token budget and separates tool/schema checks", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(body.max_tokens, 2400);
    if (body.tools) assert.equal(body.response_format, undefined);
    return probeFetch(url, options);
  });
  const service = new ModelManagementService({}, runtime, secrets);
  service.account = async () => ({
    enabled: true,
    base_url: endpoint,
    api_key_ciphertext: secrets.encrypt("test-secret"),
  });
  const result = await service.probe("llm", {
    id: 4,
    accountId: 4,
    name: "reasoning",
    baseUrl: endpoint,
    config: { ...llmConfig, maxOutputTokens: 2400 },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.checks.map((c) => c.stage),
    ["structured", "tools", "stream"],
  );
  assert.equal(calls.length, 3);
});

test("probe reports stream length truncation rather than misdiagnosing credentials", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (JSON.parse(options.body).stream)
      return new Response(
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
      );
    return probeFetch(url, options);
  });
  const service = new ModelManagementService({}, runtime, secrets);
  service.account = async () => ({
    enabled: true,
    base_url: endpoint,
    api_key_ciphertext: secrets.encrypt("test-secret"),
  });
  const result = await service.probe("llm", {
    id: 4,
    accountId: 4,
    name: "reasoning",
    baseUrl: endpoint,
    config: llmConfig,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "stream");
  assert.match(result.message, /1200 Token.*思考/);
  assert.equal(result.checks.filter((c) => c.ok).length, 2);
});

test("LLM and embedding diagnostics preserve status and redact credentials", async (t) => {
  const apiKey = "test-private-credential";
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: {
          code: "invalid_api_key",
          message: `Invalid ${apiKey}; Authorization=Bearer foo; token=other-secret`,
        },
      },
      { status: 401 },
    ),
  );
  const service = new ModelManagementService({}, runtime, secrets);
  service.account = async () => ({
    enabled: true,
    base_url: endpoint,
    api_key_ciphertext: secrets.encrypt(apiKey),
  });
  for (const kind of ["llm", "embedding"]) {
    const result = await service.probe(kind, {
      id: 4,
      accountId: 4,
      name: "fixture",
      baseUrl: endpoint,
      config: kind === "llm" ? llmConfig : embedConfig,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.providerCode, "invalid_api_key");
    assert.ok(result.providerMessage.includes("[redacted]"));
    assert.ok(!JSON.stringify(result).includes(apiKey));
    assert.ok(!JSON.stringify(result).includes("other-secret"));
  }
});
