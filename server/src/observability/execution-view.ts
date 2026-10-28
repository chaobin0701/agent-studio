import { safeExternalTrace } from "./trace-mapping";
import { safeToolValidation } from "../ai/tools/tool-validation";

/** Ordinary execution views are an allowlist, not a redacted dump of graph state.
 * Prompt bodies, native arguments/results, raw model text and cloud project IDs
 * never pass this boundary. Debug inspection remains a separate audited API. */
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function scalarFields(value: unknown, keys: readonly string[]) {
  const source = object(value),
    target: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const item = source[key];
    if (
      item === null ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      target[key] = item;
    else if (typeof item === "string") target[key] = item.slice(0, 500);
  }
  return target;
}
function array(value: unknown, max = 200): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}
const attempts = (value: unknown) =>
  array(value, 20).map((item) =>
    scalarFields(item, [
      "attempt",
      "maxAttempts",
      "durationMs",
      "ok",
      "model",
      "target",
      "fallback",
      "errorCode",
      "errorKind",
      "retryable",
      "delayMs",
      "timestamp",
    ]),
  );
const versionFields = [
  "agentId",
  "key",
  "name",
  "versionId",
  "version",
  "promptVersionId",
  "modelPlanVersionId",
  "embeddingPlanVersionId",
  "fileOutputsEnabled",
];

export function executionContextView(
  value: unknown,
  depth = 0,
): Record<string, unknown> {
  const context = object(value),
    composition = object(context.agentComposition);
  const task = object(context.executionInput),
    versions = object(task.versions);
  return {
    ...scalarFields(context, [
      "executionEngine",
      "graphVersion",
      "currentNode",
      "runtimeProtocolVersion",
    ]),
    ...(["generic_run", "workflow_test", "agent_preview"].includes(
      String(context.entryPoint),
    )
      ? { entryPoint: context.entryPoint }
      : {}),
    ...(typeof versions.localRunId === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(versions.localRunId)
      ? { runId: versions.localRunId }
      : {}),
    outputContract: scalarFields(context.outputContract, [
      "mode",
      "source",
      "schemaHash",
      "agentVersionId",
    ]),
    outputValidation: scalarFields(context.outputValidation, ["status"]),
    outputIssues: array(object(context.errorSummary).outputIssues, 12).map(
      (i) => scalarFields(i, ["path", "message"]),
    ),
    limits: Object.fromEntries(
      Object.entries(
        scalarFields(task.limits, [
          "maxDecisions",
          "maxToolCalls",
          "maxDurationMs",
          "maxModelCalls",
          "maxTotalTokens",
        ]),
      ).filter(
        ([, value]) => typeof value === "number" && Number.isFinite(value),
      ),
    ),
    graphNodes: array(context.graphNodes).filter(
      (node) => typeof node === "string",
    ),
    specializedFlows: array(context.specializedFlows, 20).map((item) =>
      scalarFields(item, [
        "key",
        "version",
        "ok",
        "durationMs",
        "nodes",
        "modelCalls",
        "toolCalls",
        "errorCode",
      ]),
    ),
    composition: {
      ...(composition.previewDraft
        ? {
            previewDraft: scalarFields(composition.previewDraft, [
              "versionId",
              "revision",
            ]),
          }
        : {}),
      ...scalarFields(composition, [
        "workspaceId",
        "agentId",
        "mode",
        "entryVersionId",
        "createdAt",
      ]),
      agents: array(composition.agents, 9).map((agent) => ({
        ...scalarFields(agent, versionFields),
        outputContract: scalarFields(object(agent).outputContract, [
          "mode",
          "source",
          "schemaHash",
          "agentVersionId",
        ]),
        knowledge: array(object(agent).knowledge, 40).map((kb) =>
          scalarFields(kb, ["id", "indexVersionId"]),
        ),
      })),
    },
    steps: array(context.executionSteps).map((item) => ({
      ...scalarFields(item, [
        "type",
        "stage",
        "name",
        "skillId",
        "plannerRound",
        "toolBatchId",
        "toolIndex",
        "ok",
        "durationMs",
        "model",
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "finishReason",
        "attempts",
        "retryExhausted",
        "errorCode",
        "retrievalMode",
        "hitCount",
        "reused",
        "deferred",
        "origin",
      ]),
      attemptsTrail: attempts(object(item).attemptsTrail),
    })),
    models: array(context.modelCalls).map((item) => ({
      ...scalarFields(item, [
        "id",
        "purpose",
        "ok",
        "errorCode",
        "errorKind",
        "retryExhausted",
        "plannerRound",
        "model",
        "durationMs",
        "attempts",
      ]),
      ...scalarFields(object(item).response, [
        "finishReason",
        "inputTokens",
        "outputTokens",
        "totalTokens",
      ]),
      attemptsTrail: attempts(object(item).attemptsTrail),
    })),
    tools: array(context.toolCalls).map((item) => {
      const validation = safeToolValidation(object(item).validation);
      return {
      ...scalarFields(item, [
        "name",
        "ok",
        "durationMs",
        "attempts",
        "retryExhausted",
        "errorCode",
        "resultChars",
        "reused",
        "deferred",
      ]),
      attemptsTrail: attempts(object(item).attemptsTrail),
      ...(validation ? { validation } : {}),
      retrieval: {
        ...scalarFields(object(item).retrieval, [
          "embeddingPlanVersionId",
          "embeddingCalls",
        ]),
        libraries: array(
          object(object(item).retrieval).retrievalConfigs,
          40,
        ).map((kb) => ({
          ...scalarFields(kb, [
            "knowledgeBaseId",
            "indexVersionId",
            "requestedRetrievalMode",
            "fallbackReason",
            "embeddingProfileId",
          ]),
          ...scalarFields(object(kb).config, ["retrievalMode"]),
        })),
      },
      };
    }),
    tasks:
      depth < 3
        ? array(context.specialistTasks, 10).map((item) => ({
            ...scalarFields(item, [
              "type",
              "key",
              "agentVersionId",
              "depth",
              "startedAt",
              "completedAt",
              "ok",
              "errorCode",
              "inputTokens",
              "outputTokens",
              "totalTokens",
            ]),
            execution: executionContextView(object(item).context, depth + 1),
          }))
        : [],
    budget: scalarFields(context.executionBudget, [
      "modelCalls",
      "toolCalls",
      "totalTokens",
      "reservedTokens",
      "maxModelCalls",
      "maxToolCalls",
      "maxTotalTokens",
    ]),
    timing: scalarFields(context.timing, [
      "plannerTtftMs",
      "firstCommentaryMs",
      "toolWaitMs",
      "toolExecutionMs",
      "answerTtftMs",
      "totalMs",
    ]),
    error: scalarFields(context.errorSummary, [
      "phase",
      "errorCode",
      "errorKind",
      "attempts",
      "retryExhausted",
      "plannerRounds",
    ]),
    output: {
      ...scalarFields(context.output, ["status"]),
      artifacts: array(object(context.output).artifacts, 20).map((item) =>
        scalarFields(item, ["id", "kind"]),
      ),
      references: array(object(context.output).references, 20).map((item) =>
        scalarFields(item, ["id", "kind", "title"]),
      ),
    },
    externalTrace: {
      sampled: safeExternalTrace(context.externalTrace)?.enabled === true,
      provider: safeExternalTrace(context.externalTrace)?.provider ?? (context.phoenix ? "phoenix" : null),
    },
  };
}

export function omitExternalTraceLinks(
  value: unknown,
  depth = 0,
): Record<string, unknown> {
  const {
    externalTrace: _external, phoenix: _link, langSmith: _legacyLink, ...context
  } = object(value);
  if (depth >= 3) {
    delete context.specialistTasks;
    return context;
  }
  if (Array.isArray(context.specialistTasks))
    context.specialistTasks = context.specialistTasks.map((task) => {
      const item = object(task);
      return {
        ...item,
        ...(item.context
          ? { context: omitExternalTraceLinks(item.context, depth + 1) }
          : {}),
      };
    });
  return context;
}
