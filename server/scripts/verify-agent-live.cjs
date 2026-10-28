// Explicit opt-in live acceptance: consumes model Tokens, never mutates resources.
const root = require("node:path").resolve(__dirname, "../..");
if (process.env.AGENT_ACCEPTANCE_ENV_FILE)
  process.loadEnvFile(process.env.AGENT_ACCEPTANCE_ENV_FILE);
// Explicit metadata-only trace acceptance; never implicitly export model bodies.
process.env.AGENT_STUDIO_LANGSMITH_ENABLED =
  process.env.AGENT_ACCEPTANCE_LANGSMITH === "true" ? "true" : "false";
require(root + "/server/node_modules/reflect-metadata");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { z } = require(root + "/server/node_modules/zod");
const load = (path) => require(root + "/server/dist/" + path + ".js");
const { AppConfigService } = load("config/config.service");
const { ExecutionTracingService } = load("observability/tracing.module");
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
const { DeepAgentExecutionService } = load(
  "ai/deep-agents/deep-agent-execution.service",
);
const { ToolRegistry } = load("ai/tools/tool-registry");
const { ToolExecutionService } = load("ai/tools/tool-execution");
const { ToolPolicy } = load("ai/tools/tool-policy");
const { DEFAULT_AGENT_CONFIGURATION } = load("config/agent-config");
const { agentSchema } = load("agent-management/resource.types");
const { freeze } = load("agent-management/runtime-scope");
const { inWorkspace } = load("workspaces/workspace-context");
(async () => {
  const workspaceId = Number(process.env.AGENT_ACCEPTANCE_WORKSPACE_ID ?? "1");
  assert.ok(
    Number.isSafeInteger(workspaceId) && workspaceId > 0,
    "Invalid acceptance workspace",
  );
  const config = new AppConfigService(),
    db = new DatabaseService(config);
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
      if (!row)
        throw Object.assign(Error("No published model"), {
          code: "no_published_model",
        });
      const original = await management.version(db, "llm", row.id);
      // Only transient acceptance limits; source model resources remain unchanged.
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
      const llm = new LlmService(provider, config);
      let toolCalls = 0;
      const tool = {
        name: "add_verified_numbers",
        description:
          "精确求两个整数之和。此验收任务必须调用此工具取得确认结果，不要自行计算。只读无副作用。",
        inputSchema: z
          .object({ a: z.number().int(), b: z.number().int() })
          .strict(),
        planning: { canBatch: true, isIdempotent: true },
        execute: async ({ a, b }) => {
          toolCalls++;
          return {
            success: true,
            content: JSON.stringify({ sum: a + b }),
            data: { sum: a + b },
          };
        },
      };
      async function run(withTool, withFiles = false) {
        const tools = new Map(withTool ? [[tool.name, tool]] : []);
        const spec = agentSchema.parse({
          responsibility: "通用计算与报告",
          promptVersionId: 1,
          modelPlanVersionId: plan.id,
          toolVersionIds: [],
          skillVersionIds: [],
          knowledgeBaseIds: [],
          fileOutputs: { enabled: withFiles },
          runtime: { maxPlannerRounds: 4, maxToolCalls: 2 },
        });
        const configuration = structuredClone(DEFAULT_AGENT_CONFIGURATION);
        configuration.identity = {
          name: "通用验收 Agent",
          role: spec.responsibility,
          persona: "按任务完成请求，不假定任何产品、客服或知识库。",
        };
        configuration.answeringInstructions = "遵循通用输出协议，简短回答。";
        configuration.answerInstructions = "使用中文。";
        configuration.enabledSkills = [];
        configuration.runtime = {
          ...spec.runtime,
          allowedTools: [...tools.keys()],
        };
        const entry = {
          version: {
            id: 1,
            resourceId: 1,
            key: "ephemeral_acceptance",
            name: "Transient test (not saved)",
            version: 1,
            status: "published",
            enabled: true,
          },
          spec,
          configurationSnapshot: {
            configuration,
            revision: "ephemeral",
            configurationVersion: 1,
          },
          promptSnapshot: {
            environment: "dev",
            prompts: {},
            businessPrompt: withFiles
              ? "按用户要求生成唯一的最终文件。使用一次 write_file，不使用读取、规划或其他工具。最后输出 answer 和 filePaths 的 JSON，不输出文件正文。"
              : withTool
                ? '对于计算请求，先调用 add_verified_numbers；取得结果后在 answer 给出和，structured 填 {"sum":数字}。'
                : "直接回复：通用 Agent 验收成功。",
            delegationHints: "",
          },
          modelPlan: plan,
          embeddingPlan: null,
          tools,
          skills: new Map(),
          skillSpecs: new Map(),
          knowledge: [],
        };
        const composition = freeze({
          workspaceId,
          agentId: 1,
          environment: "dev",
          mode: "single",
          entryVersionId: 1,
          agents: new Map([[1, entry]]),
          createdAt: new Date().toISOString(),
        });
        const execution = new ToolExecutionService(
          new ToolRegistry(),
          new ToolPolicy({ agent: configuration }),
        );
        const service = new DeepAgentExecutionService(llm, execution, tracing);
        const result = await service.runTask(
          composition,
          {
            messages: [],
            task: withFiles
              ? "生成一个 Markdown 文件，只含标题“# 验证”和一行“artifact-live-423”。使用一次 write_file，保存到 /workspace/outputs/verification.md；不要调用 read_file 或其他工具。最后用 JSON 返回 answer 和 filePaths。"
              : withTool
                ? "使用工具计算 137 加 286，并给出 structured.sum。"
                : "请确认通用任务能力。",
            versions: {},
            ...(withTool
              ? {
                  outputSchema: {
                    type: "object",
                    properties: { sum: { type: "integer" } },
                    required: ["sum"],
                    additionalProperties: false,
                  },
                }
              : {}),
            limits: {
              maxDecisions: spec.runtime.maxPlannerRounds,
              maxToolCalls: spec.runtime.maxToolCalls,
              maxDurationMs: 90000,
            },
          },
          {
            runId: randomUUID(),
            traceId: randomUUID(),
            signal: AbortSignal.timeout(90000),
          },
        );
        assert.equal(result.output.status, "completed");
        assert.equal(result.contextSnapshot.products, undefined);
        assert.equal(result.contextSnapshot.executionEngine, "deepagents");
        if (withFiles) {
          assert.equal(result.fileOutputs.length, 1);
          assert.equal(result.fileOutputs[0].filename, "verification.md");
          assert.ok(
            result.fileOutputs[0].content.includes("artifact-live-423"),
          );
          assert.ok(result.fileOutputs[0].content.includes("# 验证"));
          assert.equal(result.output.artifacts[0].kind, "execution_file");
          assert.equal(result.contextSnapshot.modelCalls.length, 2);
          assert.equal(result.toolCalls.length, 1);
          assert.doesNotMatch(
            JSON.stringify(result.output.artifacts),
            /artifact-live-423|# 验证|"content"/,
          );
          assert.ok(!("content" in result.output.artifacts[0].data));
        } else if (withTool) {
          assert.equal(toolCalls, 1);
          assert.equal(result.output.structured.sum, 423);
          assert.ok(result.contextSnapshot.graphNodes.includes("tools"));
        } else {
          assert.ok(result.output.answer.includes("验收成功"));
          assert.equal(result.toolCalls.length, 0);
        }
        let persistedSpans;
        if (tracing) {
          assert.equal(await tracing.flush(), true);
          assert.equal(tracing.metrics.failed, 0);
          const link = result.contextSnapshot.externalTrace;
          assert.equal(link.enabled, true);
          const rows = await require("./langsmith-readback.cjs").readStoredTrace(config.tracing, result.contextSnapshot.externalTrace, ["deep_agent", "model_attempt"]);
          assert.ok(
            rows.some(
              (row) =>
                row.name === "model_attempt" &&
                row.attributes["app.modelPlanVersionId"] === plan.id,
            ),
          );
          assert.ok(rows.some((row) => row.name === "deep_agent"));
          assert.ok(
            rows.every(
              (row) =>
                row.attributes["app.localRunId"] &&
                row.attributes["app.localTraceId"],
            ),
          );
          if (withFiles)
            assert.ok(rows.some((row) => row.name === "artifact_selection"));
          if (withTool)
            assert.ok(rows.some((row) => row.name === "tool_attempt"));
          assert.doesNotMatch(
            JSON.stringify(rows),
            /input\.value|output\.value|apiKey|authorization/,
          );
          persistedSpans = rows.length;
        }
        console.log(
          JSON.stringify({
            scenario: withFiles
              ? "real-model-native-file-output"
              : withTool
                ? "real-model-native-read-tool"
                : "real-model-no-business-dependencies",
            ok: true,
            modelPlanVersionId: plan.id,
            model: plan.config.deployments[0].config.model,
            graphNodes: result.contextSnapshot.graphNodes,
            actualModelCalls: result.contextSnapshot.modelCalls.length,
            actualToolCalls: result.toolCalls.length,
            totalTokens: result.totalTokens,
            ...(persistedSpans
              ? { langsmithPersistedSpans: persistedSpans }
              : {}),
          }),
        );
      }
      if (
        process.env.AGENT_ACCEPTANCE_FILES_ONLY === "true" ||
        process.argv.includes("--files-only")
      )
        await run(false, true);
      else {
        await run(false);
        await run(true);
      }
    });
  } finally {
    await tracing?.close();
    await db.onModuleDestroy();
  }
})().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      errorCode:
        error.code ?? error.errorCode ?? error.name ?? "acceptance_failed",
    }),
  );
  process.exitCode = 1;
});
