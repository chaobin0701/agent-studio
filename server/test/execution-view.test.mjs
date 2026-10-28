import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { executionContextView } from "../dist/observability/execution-view.js";
import { recordedLangSmithLink } from "../dist/observability/langsmith-link.js";
import { normalizeTracingOptions } from "../dist/config/tracing-config.js";
import { configuredTraceUrl, destinationId, safeLangSmithAppPath } from "../dist/observability/trace-mapping.js";
import { AdminExecutionController } from "../dist/observability/admin-execution.controller.js";
import { AdminChatTraceController } from "../dist/chat/admin-chat-trace.controller.js";
import { platformPermission } from "../dist/workspaces/workspace-access.js";
import { PERMISSION_KEY } from "../dist/admin/permission.decorator.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const options = normalizeTracingOptions({
  enabled: true, apiKey: "fixture-key", project: "acceptance",
  workspaceId: uuid, projectId: "22222222-2222-4222-8222-222222222222",
});
const link = {
  schemaVersion: 1, provider: "langsmith", enabled: true,
  traceId: "33333333333343338333333333333333",
  runId: "33333333-3333-4333-8333-333333333333",
  destination: destinationId(options),
};
const cloudUrl = configuredTraceUrl(options, link.runId);

test("ordinary execution projection retains nested attempts/retrieval/version IDs, never full state or collector links", () => {
  const privateData = {
    systemPrompt: "PRIVATE_PROMPT",
    arguments: { token: "PRIVATE_KEY" },
    result: "PRIVATE_TOOL_BODY",
    content: "PRIVATE_MODEL",
    extra: "PRIVATE_OTHER",
  };
  const step = {
    ...privateData,
    type: "tool_call",
    name: "lookup",
    ok: true,
    attemptsTrail: [{ ...privateData, attempt: 2, ok: true, durationMs: 10 }],
  };
  const snapshot = {
    ...privateData,
    executionEngine: "langgraph",
    graphVersion: "agent-graph-v1",
    graphNodes: ["initialize_context", "model_decision"],
    entryPoint: "generic_run",
    executionInput: {
      messages: [{ role: "user", content: "PRIVATE_CALLER_HISTORY" }],
      attachments: [{ kind: "document", id: "1", body: "PRIVATE_DOC" }],
      versions: { localRunId: uuid, credentials: "PRIVATE_KEY" },
      limits: {
        maxToolCalls: 0,
        maxDecisions: 12,
        maxDurationMs: 1000,
        maxTotalTokens: "PRIVATE_SECRET",
        apiKey: "PRIVATE_KEY",
      },
    },
    agentComposition: {
      agentId: 5,
      entryVersionId: 12,
      agents: [
        {
          ...privateData,
          agentId: 5,
          versionId: 12,
          promptVersionId: 6,
          knowledge: [{ id: 8, indexVersionId: 9, ...privateData }],
        },
      ],
    },
    executionSteps: [step],
    toolCalls: [
      {
        ...step,
        retrieval: {
          embeddingCalls: 1,
          retrievalConfigs: [
            {
              knowledgeBaseId: 8,
              indexVersionId: 9,
              config: { retrievalMode: "fulltext", ...privateData },
              fallbackReason: "model_mismatch",
            },
          ],
        },
      },
    ],
    modelCalls: [
      {
        ...privateData,
        id: "model-1",
        response: { content: "PRIVATE_MODEL", totalTokens: 42 },
      },
    ],
    specialistTasks: [
      {
        key: "member",
        task: "PRIVATE_TASK",
        context: { ...privateData, executionSteps: [step], externalTrace: link },
      },
    ],
    executionBudget: {
      modelCalls: 3,
      toolCalls: 1,
      totalTokens: 42,
      maxModelCalls: 6,
      maxToolCalls: 25,
      maxTotalTokens: 60000,
      ...privateData,
    },
    output: {
      artifacts: [{ id: "report-1", kind: "report", data: privateData }],
      structured: privateData,
    },
    externalTrace: link,
  };
  const result = executionContextView(snapshot);
  assert.equal(result.runId, uuid);
  assert.equal(result.entryPoint, "generic_run");
  assert.deepEqual(result.limits, {
    maxToolCalls: 0,
    maxDecisions: 12,
    maxDurationMs: 1000,
  });
  assert.ok(!JSON.stringify(result).includes("PRIVATE_CALLER_HISTORY"));
  assert.equal(result.composition.agents[0].knowledge[0].indexVersionId, 9);
  assert.equal(result.tasks[0].execution.steps[0].attemptsTrail[0].attempt, 2);
  assert.equal(
    result.tools[0].retrieval.libraries[0].retrievalMode,
    "fulltext",
  );
  assert.equal(result.models[0].totalTokens, 42);
  assert.equal(result.budget.modelCalls, 3);
  assert.equal(result.budget.maxModelCalls, 6);
  assert.equal(result.budget.maxToolCalls, 25);
  assert.equal(result.budget.maxTotalTokens, 60000);
  assert.deepEqual(result.output.artifacts, [
    { id: "report-1", kind: "report" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE_|redirects\/traces|1212121212121212|traceId/,
  );
});

test("private LangSmith links reject invalid IDs, untrusted paths and changed destination mappings", async () => {
  assert.equal((await recordedLangSmithLink(link, options)).url, cloudUrl);
  assert.equal((await recordedLangSmithLink(link, { ...options, project: "changed" })).available, false);
  assert.equal(safeLangSmithAppPath(options.webUrl,"//evil.invalid/",link.runId),null);
  assert.equal(safeLangSmithAppPath(options.webUrl,"/o/../other",link.runId),null);
  assert.equal((await recordedLangSmithLink({...link,runId:"../other"},options)).available,false);
  assert.equal((await recordedLangSmithLink({...link,enabled:false},options)).available,false);
  assert.equal((await recordedLangSmithLink({traceId:link.traceId,project:"old",url:cloudUrl},options)).reason,"historical_or_missing");
  assert.equal(platformPermission("observability.external.read"), true);
  assert.equal(platformPermission("conversations.read"), false);
  assert.deepEqual(
    Reflect.getMetadata(
      PERMISSION_KEY,
      AdminExecutionController.prototype.external,
    ),
    ["observability.external.read"],
  );
});

test("execution endpoints use scoped queries, bound filters, independent collector permission and missing-record guards", async () => {
  const calls = [],
    db = {
      query: async (sql, args) => {
        calls.push([sql, args]);
        return {
          rows: sql.includes("count(*)")
            ? [{ total: 1 }]
            : [
                {
                  id: uuid,
                  contextSnapshot: {
                    externalTrace: link,
                    systemPrompt: "PRIVATE_PROMPT",
                  },
                },
              ],
        };
      },
    };
  const controller = new AdminExecutionController(db, { tracing: options });
  await controller.list("2", "20", "5", "failed");
  assert.deepEqual(calls[0][1], ["5", "failed", 20, 20]);
  for (const args of [
    ["0"],
    ["1", "101"],
    ["1", "20", "1;DROP TABLE"],
    ["1", "20", "1", "bad"],
  ])
    await assert.rejects(
      controller.list(...args),
      (e) => e.getStatus() === 400,
    );
  assert.doesNotMatch(
    JSON.stringify(await controller.detail(uuid)),
    /PRIVATE|redirects\/traces/,
  );
  await assert.rejects(
    controller.external(uuid, { workspacePermissionCodes: [] }),
    (e) => e.getStatus() === 403,
  );
  assert.equal(
    (
      await controller.external(uuid, {
        workspacePermissionCodes: ["conversations.read"],
      })
    ).url,
    cloudUrl,
  );
  assert.doesNotMatch(
    JSON.stringify(await new AdminChatTraceController(db).detail(uuid)),
    /redirects\/traces|runId|traceId/,
  );
  const missing = new AdminExecutionController(
    { query: async () => ({ rows: [] }) },
    { tracing: options },
  );
  await assert.rejects(missing.detail(uuid), (e) => e.getStatus() === 404);
});
