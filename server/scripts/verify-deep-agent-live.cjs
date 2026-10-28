// Explicit opt-in real supplier verification. Read-only source configuration;
// ephemeral Agent/Prompt/Skill/tool, no HTTP deployment or resource publication.
const root = require("node:path").resolve(__dirname, "../..");
if (process.env.AGENT_ACCEPTANCE_ENV_FILE)
  process.loadEnvFile(process.env.AGENT_ACCEPTANCE_ENV_FILE);
process.env.AGENT_STUDIO_LANGSMITH_ENABLED =
  process.env.AGENT_ACCEPTANCE_LANGSMITH === "true" ? "true" : "false";
require(root + "/server/node_modules/reflect-metadata");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { z } = require(root + "/server/node_modules/zod");
const load = (path) => require(root + "/server/dist/" + path + ".js");
const { AppConfigService } = load("config/config.service");
const { DatabaseService } = load("database.service");
const { SecretBox } = load("security/secret-box");
const { ModelManagementService } = load(
  "model-management/model-management.service",
);
const { ManagedRuntimeProvider } = load("model-management/model-route");
const { OpenAICompatibleProvider } = load(
  "ai/providers/openai-compatible.provider",
);
const { LlmService } = load("chat/llm.service");
const { ManagedDeepAgentHarness } = load("ai/deep-agents/managed-harness");
const { ToolRegistry } = load("ai/tools/tool-registry");
const { ToolExecutionService } = load("ai/tools/tool-execution");
const { ToolPolicy } = load("ai/tools/tool-policy");
const { ExecutionTracingService } = load("observability/tracing.module");
const { withModelCallAccounting } = load("chat/model-call-accounting");
const { inWorkspace } = load("workspaces/workspace-context");
let acceptanceStage = "configuration";
(async () => {
  const config = new AppConfigService(),
    db = new DatabaseService(config);
  const workspaceId = Number(process.env.AGENT_ACCEPTANCE_WORKSPACE_ID ?? 1);
  assert.ok(Number.isSafeInteger(workspaceId) && workspaceId > 0);
  const tracing =
    process.env.AGENT_ACCEPTANCE_LANGSMITH === "true"
      ? new ExecutionTracingService(config)
      : undefined;
  try {
    await inWorkspace(workspaceId, async () => {
      const management = new ModelManagementService(
        db,
        config,
        new SecretBox(config),
      );
      const row = (
        await db.query(
          "SELECT v.id::int FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE p.kind='llm' AND p.deleted_at IS NULL AND p.archived_at IS NULL AND v.status='published' AND jsonb_array_length(v.config->'deployments')>0 ORDER BY (v.id=p.current_version_id) DESC,v.id DESC LIMIT 1",
        )
      ).rows[0];
      assert.ok(row, "No available published model plan");
      const original = await management.version(db, "llm", row.id);
      const plan = {
        ...original,
        config: {
          ...original.config,
          deployments: original.config.deployments
            .slice(0, 1)
            .map((d) => ({ ...d, config: { ...d.config, maxRetries: 0 } })),
        },
      };
      const provider = new ManagedRuntimeProvider(
        management,
        () => new OpenAICompatibleProvider(config.llm),
      );
      const llm = new LlmService(provider, config),
        harness = new ManagedDeepAgentHarness(llm);
      let actualTools = 0;
      const tool = {
        name: "add_verified_numbers",
        description:
          "精确求两个整数之和，验证任务必须调用本工具取得确认结果。只读，无副作用。",
        inputSchema: z
          .object({ a: z.number().int(), b: z.number().int() })
          .strict(),
        planning: { canBatch: true, isIdempotent: true },
        execute: async ({ a, b }) => {
          actualTools++;
          return { success: true, content: JSON.stringify({ sum: a + b }) };
        },
      };
      for (const withSkillAndTool of [false, true]) {
        acceptanceStage = withSkillAndTool
          ? "skill_tool_invocation"
          : "single_invocation";
        const registry = new ToolRegistry();
        if (withSkillAndTool) registry.register(tool);
        const localRunId = randomUUID(),
          localTraceId = randomUUID();
        let traceLink,
          modelCalls = 0;
        const operation = () =>
          llm.withPinnedModelPlan(plan, () =>
            withModelCallAccounting(
              {
                reserve: async () => {
                  modelCalls++;
                  return { settle: async () => {} };
                },
              },
              () =>
                harness.run(
                  {
                    messages: [
                      {
                        role: "user",
                        content: withSkillAndTool
                          ? "按已挂载的 analysis-guide 指导，用工具计算 137 加 286，然后报告结果。"
                          : "请确认通用任务能力。",
                      },
                    ],
                    versions: {
                      workspaceId,
                      modelPlanVersionId: plan.id,
                      localRunId,
                      localTraceId,
                    },
                    limits: {
                      maxDecisions: 5,
                      maxToolCalls: 4,
                      maxModelCalls: 6,
                      maxDurationMs: 90000,
                    },
                  },
                  {
                    systemPrompt: withSkillAndTool
                      ? "先读取 /skills/analysis-guide/SKILL.md，按指导调用 add_verified_numbers 取得准确结果。不要自行计算，也不要调用其他无关能力；最终用中文报告结果。"
                      : "直接回答：Deep Agents 通用任务验收成功。不要使用工具。",
                    tools: withSkillAndTool ? [tool] : [],
                    skills: withSkillAndTool
                      ? [
                          {
                            id: "analysis-guide",
                            name: "分析指导",
                            version: "1",
                            description: "执行计算验收前按需读取本指导。",
                            systemInstructions:
                              "调用 add_verified_numbers，参数 a=137、b=286。取得成功结果后用中文报告和，不输出工具参数或内部过程。",
                          },
                        ]
                      : [],
                    gateway: new ToolExecutionService(
                      registry,
                      new ToolPolicy(),
                    ),
                    toolContext: {
                      state: new Map(),
                      permissions: withSkillAndTool ? [tool.name] : [],
                    },
                  },
                ),
            ),
          );
        const result = tracing
          ? await tracing.span(
              "agent_request",
              "chain",
              {
                workspaceId,
                modelPlanVersionId: plan.id,
                localRunId,
                localTraceId,
              },
              async (span) => {
                traceLink = tracing.link(span);
                return operation();
              },
            )
          : await operation();
        acceptanceStage = withSkillAndTool
          ? "skill_tool_result"
          : "single_result";
        assert.equal(result.result.status, "completed");
        if (withSkillAndTool) {
          assert.equal(actualTools, 1);
          assert.ok(result.result.answer.includes("423"));
          assert.ok(
            result.toolCalls >= 2,
            "Skill guidance really read through framework filesystem",
          );
        } else {
          assert.ok(result.result.answer.includes("验收成功"));
          assert.equal(result.toolCalls, 0);
          assert.equal(modelCalls, 1);
        }
        let persistedSpans;
        if (tracing) {
          acceptanceStage = "trace_export";
          assert.equal(await tracing.flush(), true);
          assert.equal(tracing.metrics.failed, 0);
          const rows = await require("./langsmith-readback.cjs").readStoredTrace(config.tracing, traceLink, ["deep_agent", "model_attempt"]);
          acceptanceStage = "trace_agent_kind";
          assert.ok(
            rows.some(
              (span) =>
                span.name === "deep_agent" && span.run_type === "chain",
            ),
          );
          acceptanceStage = "trace_models";
          assert.equal(
            rows.filter((span) => span.name === "model_attempt").length,
            modelCalls,
          );
          assert.ok(
            rows
              .filter((span) => span.name === "model_attempt")
              .every(
                (span) => span.attributes["app.modelPlanVersionId"] === plan.id,
              ),
          );
          if (withSkillAndTool)
            assert.ok(rows.some((span) => span.name === "workspace_read_file"));
          const payload = JSON.stringify(rows);
          acceptanceStage = "trace_privacy";
          const framework = rows.filter(span => span.attributes["app.layer"] === "framework");
          assert.ok(framework.length > 2, "Live provider framework callback tree not persisted");
          assert.ok(framework.every(span => span.span_kind === "CHAIN"));
          assert.ok(framework.every(span => !Object.keys(span.attributes).some(k => /llm.token_count|input.value|output.value/.test(k))));
          for (const marker of [
            "api_key",
            "Authorization",
            "systemPrompt",
            "analysis-guide/SKILL.md",
            "直接回答",
            "137 加 286",
          ])
            assert.ok(
              !payload.includes(marker),
              "Private body absent from stored spans",
            );
          persistedSpans = rows.length;
        }
        console.log(
          JSON.stringify({
            engine: result.runtimeVersion,
            mode: withSkillAndTool ? "skill-and-readonly-tool" : "no-resources",
            modelPlanVersionId: plan.id,
            modelCalls,
            toolCalls: result.toolCalls,
            totalTokens: result.result.usage.totalTokens,
            ...(persistedSpans ? { persistedSpans } : {}),
          }),
        );
      }
    });
  } finally {
    await tracing?.close();
    await db.onModuleDestroy();
  }
})().catch((error) => {
  console.error(
    "Deep Agents live verification failed:",
    acceptanceStage,
    error.code ?? error.name,
  );
  process.exitCode = 1;
});
