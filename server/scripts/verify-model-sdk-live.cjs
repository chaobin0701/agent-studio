// Explicit paid, read-only acceptance. Uses existing published model/credential
// configuration; creates no resources, conversations or business transactions.
if (process.env.AGENT_ACCEPTANCE_ENV_FILE)
  process.loadEnvFile(process.env.AGENT_ACCEPTANCE_ENV_FILE);
process.env.PHOENIX_TRACING =
  process.env.AGENT_ACCEPTANCE_PHOENIX === "true" ? "true" : "false";
require("reflect-metadata");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const load = (path) => require(`../dist/${path}.js`);
const { AppConfigService } = load("config/config.service");
const { DatabaseService } = load("database.service");
const { SecretBox } = load("security/secret-box");
const { ModelManagementService } = load(
  "model-management/model-management.service",
);
const { ManagedRuntimeProvider } = load("model-management/model-route");
const { LangChainOpenAIProvider } = load(
  "ai/providers/langchain-openai.provider",
);
const { LlmService } = load("chat/llm.service");
const { withModelCallAccounting } = load("chat/model-call-accounting");
const { SharedExecutionBudget, withExecutionBudget } = load(
  "ai/agent/execution-budget",
);
const { ExecutionTracingService } = load("observability/tracing.module");
const { inWorkspace } = load("workspaces/workspace-context");
let stage = "read_configuration";
(async () => {
  const workspaceId = Number(process.env.AGENT_ACCEPTANCE_WORKSPACE_ID ?? 1);
  assert.ok(Number.isSafeInteger(workspaceId) && workspaceId > 0);
  const config = new AppConfigService(),
    db = new DatabaseService(config);
  const tracing =
    process.env.AGENT_ACCEPTANCE_PHOENIX === "true"
      ? new ExecutionTracingService(config)
      : undefined;
  const originalFetch = globalThis.fetch;
  try {
    await inWorkspace(workspaceId, async () => {
      const management = new ModelManagementService(
        db,
        config,
        new SecretBox(config),
      );
      const selected = (
        await db.query(
          "SELECT v.id::int FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE p.kind='llm' AND p.deleted_at IS NULL AND p.archived_at IS NULL AND v.status='published' ORDER BY (v.id=p.current_version_id) DESC,v.id DESC LIMIT 1",
        )
      ).rows[0];
      assert.ok(selected, "No published model");
      const version = await management.version(db, "llm", selected.id);
      const deployment = version.config.deployments[0];
      assert.ok(deployment);
      const origin = new URL(deployment.baseUrl).origin;
      let requests = 0,
        controller;
      globalThis.fetch = (url, options) => {
        const target = new URL(
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url,
        );
        if (
          target.origin === origin &&
          target.pathname.endsWith("/chat/completions")
        ) {
          requests++;
          if (controller)
            setTimeout(
              () =>
                controller.abort(
                  Object.assign(Error("Acceptance cancellation"), {
                    code: "run_cancelled",
                  }),
                ),
              250,
            ).unref();
        }
        return originalFetch(url, options);
      };
      stage = "supplier_schema_tools_stream";
      const probe = await management.probe("llm", deployment);
      assert.equal(probe.ok, true);
      assert.deepEqual(
        probe.checks.map((check) => [check.stage, check.ok]),
        [
          ["structured", true],
          ["tools", true],
          ["stream", true],
        ],
      );
      assert.equal(
        requests,
        3,
        "SDK must not add retries or protocol negotiation",
      );
      console.log(
        JSON.stringify({
          scenario: "real-sdk-structured-tools-stream",
          ok: true,
          modelPlanVersionId: version.id,
          actualRequests: requests,
          stages: probe.checks.map((check) => check.stage),
        }),
      );

      stage = "supplier_cancellation_accounting";
      requests = 0;
      controller = new AbortController();
      const plan = {
        ...version,
        config: {
          ...version.config,
          deployments: [
            { ...deployment, config: { ...deployment.config, maxRetries: 0 } },
          ],
        },
      };
      const route = new ManagedRuntimeProvider(
        management,
        () => new LangChainOpenAIProvider(config.llm),
      );
      const llm = new LlmService(route, config),
        budget = new SharedExecutionBudget({
          maxModelCalls: 1,
          maxToolCalls: 0,
          maxTotalTokens: 10000,
        });
      let reservations = 0,
        settlements = 0,
        settledUsage,
        link;
      const execute = () =>
        withExecutionBudget(budget, () =>
          withModelCallAccounting(
            {
              reserve: async () => {
                reservations++;
                return {
                  settle: async (usage) => {
                    settlements++;
                    settledUsage = usage;
                  },
                };
              },
            },
            () =>
              llm.withPinnedModelPlan(plan, () =>
                llm.streamDetailed(
                  "",
                  "请依次列出从1到1000的整数，不要省略。",
                  llm.model,
                  "planner",
                  { signal: controller.signal, maxRetries: 0 },
                ),
              ),
          ),
        );
      try {
        if (tracing)
          await tracing.span(
            "sdk_cancel_acceptance",
            "chain",
            {
              workspaceId,
              modelPlanVersionId: version.id,
              localRunId: randomUUID(),
              localTraceId: randomUUID(),
            },
            async (span) => {
              link = tracing.link(span);
              return execute();
            },
          );
        else await execute();
        assert.fail("Supplier cancellation must terminate execution");
      } catch {
        assert.equal(controller.signal.aborted, true);
        assert.equal(requests, 1);
        assert.equal(reservations, 1);
        assert.equal(settlements, 1);
        assert.equal(settledUsage?.totalTokens ?? null, null);
        assert.equal(budget.counters.modelCalls, 1);
        assert.ok(
          budget.counters.totalTokens > 0,
          "Unknown paid usage remains conservatively reserved",
        );
      }
      let persistedSpans;
      if (tracing) {
        stage = "cancel_trace_readback";
        assert.equal(await tracing.flush(), true);
        assert.equal(tracing.metrics.failed, 0);
        const base = config.tracing.endpoint.replace(/\/v1\/traces\/?$/, "");
        let spans = [];
        for (let i = 0; i < 20; i++) {
          const response = await fetch(
            `${base}/v1/projects/${encodeURIComponent(config.tracing.project)}/spans?limit=1000&trace_id=${link.traceId}`,
            {
              signal: AbortSignal.timeout(3000),
              headers: config.tracing.apiKey
                ? { Authorization: `Bearer ${config.tracing.apiKey}` }
                : {},
            },
          );
          if (response.ok) spans = (await response.json()).data;
          if (spans.some((span) => span.name === "model_attempt")) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        assert.ok(
          spans.some(
            (span) =>
              span.name === "model_attempt" && span.status_code === "ERROR",
          ),
        );
        assert.doesNotMatch(
          JSON.stringify(spans),
          /PRIVATE_|input\.value|output\.value|authorization|apiKey/,
        );
        persistedSpans = spans.length;
      }
      console.log(
        JSON.stringify({
          scenario: "real-sdk-cancellation",
          ok: true,
          modelPlanVersionId: version.id,
          actualRequests: requests,
          reservations,
          settlements,
          usage: "unknown/conservative budget",
          ...(persistedSpans ? { phoenixPersistedSpans: persistedSpans } : {}),
        }),
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
    await tracing?.close();
    await db.onModuleDestroy();
  }
})().catch(() => {
  console.error(JSON.stringify({ ok: false, stage }));
  process.exitCode = 1;
});
