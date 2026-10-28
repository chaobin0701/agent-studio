import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  AlwaysOnSampler,
} from "@opentelemetry/sdk-trace-base";
import {
  ROOT_CONTEXT,
  trace,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  SemanticConventions,
  OpenInferenceSpanKind,
} from "@arizeai/openinference-semantic-conventions";
import { LangSmithSpanProcessor } from "./langsmith-exporter";
import {
  normalizeTracingOptions,
  type TracingOptions,
  type ResolvedTracingOptions,
} from "../config/tracing-config";
import {
  destinationId,
  langSmithRunId,
  safeExternalTrace,
  type ExternalTraceMapping,
} from "./trace-mapping";
import {
  createFrameworkCapture,
  frameworkParent,
  type FrameworkCapture,
} from "./framework-callbacks";
import {
  InteractionSuspension,
  InteractionWaiting,
} from "../interactions/contracts";
import { traceContentValue } from "./trace-content";

export type TraceMetadata = Record<string, unknown>;
export type TraceKind = "chain" | "llm" | "tool" | "retriever" | "embedding";
export type ExecutionSpan = {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  kind: TraceKind;
  startedAt: number;
  sampled: boolean;
  metadata: Record<string, string | number | boolean | null>;
};
export interface ExecutionTracer {
  framework?(allowedNames: readonly string[]): FrameworkCapture;
  span<T>(
    name: string,
    kind: TraceKind,
    metadata: TraceMetadata,
    operation: (span: ExecutionSpan) => Promise<T>,
  ): Promise<T>;
  annotate(metadata: TraceMetadata): void;
  annotateContent?(content: { input?: unknown; output?: unknown }): void;
  link(span: ExecutionSpan): ExternalTraceMapping;
}
const activeTracer = new AsyncLocalStorage<ExecutionTracer>();
export function executionSpan<T>(
  name: string,
  kind: TraceKind,
  metadata: TraceMetadata,
  operation: () => Promise<T>,
): Promise<T> {
  const tracer = activeTracer.getStore();
  return tracer
    ? tracer.span(name, kind, metadata, async () => operation())
    : operation();
}
export function annotateExecution(metadata: TraceMetadata): void {
  activeTracer.getStore()?.annotate(metadata);
}
export function annotateTraceContent(content: {
  input?: unknown;
  output?: unknown;
}): void {
  activeTracer.getStore()?.annotateContent?.(content);
}
export function frameworkTracing(
  allowedNames: readonly string[] = [],
): FrameworkCapture {
  return (
    activeTracer.getStore()?.framework?.(allowedNames) ?? {
      callbacks: [],
      close() {},
    }
  );
}

// Allowlisted identifiers and counters only. Never accept prompt/message/document/tool bodies.
const metadataKeys = new Set([
  "workspaceId",
  "agentId",
  "agentVersionId",
  "promptVersionId",
  "modelPlanVersionId",
  "embeddingPlanVersionId",
  "indexVersionId",
  "knowledgeBaseId",
  "toolVersionId",
  "mcpServerId",
  "skillVersionId",
  "skillId",
  "localRunId",
  "localTraceId",
  "conversationId",
  "graphVersion",
  "workflowKey",
  "workflowVersion",
  "workflowNodeCount",
  "workflowModelCalls",
  "workflowToolCalls",
  "node",
  "provider",
  "modelName",
  "modelAdapterVersion",
  "purpose",
  "codePromptVersion",
  "attempt",
  "maxAttempts",
  "fallback",
  "retryable",
  "durationMs",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "toolCalls",
  "artifactCount",
  "artifactBytes",
  "decisions",
  "status",
  "errorCode",
  "finishReason",
  "retrievalMode",
  "fallbackReason",
  "hitCount",
  "embeddingCalls",
  "deferred",
  "reused",
  "depth",
]);
// External/custom errors may put credential-looking strings in `code`. Only
// platform classifications are exportable; unknown codes become execution_failed.
const errorCodes = new Set([
  "execution_failed",
  "workflow_context_required",
  "workflow_not_allowed",
  "workflow_dependency_missing",
  "workflow_nesting_denied",
  "workflow_invalid_input",
  "workflow_invalid_output",
  "workflow_limit_exceeded",
  "workflow_timeout",
  "workflow_tool_failed",
  "workflow_model_failed",
  "workflow_failed",
  "answer_failed",
  "summary_failed",
  "invalid_request",
  "conflict",
  "provider_timeout",
  "provider_rate_limit",
  "provider_quota_exhausted",
  "provider_authentication",
  "provider_context_length",
  "provider_model_not_found",
  "provider_invalid_request",
  "provider_invalid_response",
  "provider_unavailable",
  "provider_unsupported_response_format",
  "model_retry_exhausted",
  "model_output_truncated",
  "model_content_filtered",
  "model_protocol_error",
  "invalid_tool_arguments",
  "output_truncated",
  "invalid_native_tool_calls",
  "invalid_tool_finish_reason",
  "invalid_tool_index",
  "conflicting_tool_id",
  "missing_tool_calls",
  "missing_completion_event",
  "event_after_completion",
  "empty_response",
  "agent_budget_exceeded",
  "agent_timeout",
  "run_cancelled",
  "collaboration_failed",
  "specialist_failed",
  "task_budget_exceeded",
  "task_depth_exceeded",
  "delegation_denied",
  "skill_unavailable",
  "unknown_tool",
  "invalid_arguments",
  "tool_call_limit_exceeded",
  "tool_not_allowed",
  "duplicate_tool_call",
  "tool_requires_replanning",
  "tool_timeout",
  "tool_unavailable",
  "tool_approval_required",
  "tool_http_error",
  "tool_network_error",
  "tool_credential_missing",
  "tool_credential_forbidden",
  "tool_response_too_large",
  "mcp_tool_failed",
  "mcp_tool_unavailable",
  "mcp_contract_changed",
  "rate_limited",
  "service_unavailable",
  "daily_request_quota_exceeded",
  "daily_token_quota_exceeded",
  "token_budget_reserved",
  "request_rate_limit",
  "concurrency_limit",
  "context_length_exceeded",
  "23505",
  "23503",
  "57014",
  "ECONNRESET",
  "ETIMEDOUT",
]);
export function safeTraceMetadata(
  value: TraceMetadata,
): ExecutionSpan["metadata"] {
  const safe: ExecutionSpan["metadata"] = {};
  for (const [key, item] of Object.entries(value)) {
    if (!metadataKeys.has(key)) continue;
    if (
      key === "errorCode" &&
      (typeof item !== "string" || !errorCodes.has(item))
    )
      continue;
    if (item === null || typeof item === "boolean") safe[key] = item;
    else if (typeof item === "number" && Number.isFinite(item))
      safe[key] = item;
    else if (
      typeof item === "string" &&
      item.length <= 200 &&
      /^[a-z0-9_:/.-]+$/iu.test(item) &&
      !/^(?:sk-|Bearer)|(?:token|api[_-]?key|password|secret)[=:]/iu.test(item)
    )
      safe[key] = item;
  }
  return safe;
}

/** Keep a safe external mapping when local conversation bodies are disabled. */
export function safeTraceSnapshot(value: TraceMetadata): TraceMetadata {
  const mapping = safeExternalTrace(value.externalTrace);
  return {
    ...safeTraceMetadata(value),
    ...(mapping ? { externalTrace: mapping } : {}),
  };
}

type LiveSpan = { span: ExecutionSpan; otel?: Span };

/** Private OpenTelemetry provider with governance spans and request-local,
 * metadata-only official framework callbacks. No global instrumentation;
 * only actual model attempts carry LLM kind and usage counters. */
export class LangSmithExecutionTracer implements ExecutionTracer {
  private readonly scope = new AsyncLocalStorage<LiveSpan>();
  private readonly processor?: LangSmithSpanProcessor;
  private readonly provider?: BasicTracerProvider;
  private readonly tracer?: Tracer;
  readonly metrics: LangSmithSpanProcessor["metrics"];
  private readonly options: ResolvedTracingOptions;
  constructor(options: TracingOptions, fetcher?: typeof fetch) {
    this.options = normalizeTracingOptions(options);
    if (this.options.enabled) {
      this.processor = new LangSmithSpanProcessor(this.options, fetcher);
      this.provider = new BasicTracerProvider({
        // Sampling is governed above, never by ambient OTEL configuration.
        sampler: new AlwaysOnSampler(),
        generalLimits: {
          attributeCountLimit: 128,
          attributeValueLengthLimit: 4_000_000,
        },
        spanLimits: {
          attributeCountLimit: 128,
          attributeValueLengthLimit: 4_000_000,
          // Only our safe exception classification event is emitted. The SDK
          // facade discards arbitrary events and original exceptions.
          eventCountLimit: 1,
          linkCountLimit: 0,
          attributePerEventCountLimit: 1,
          attributePerLinkCountLimit: 0,
        },
        resource: resourceFromAttributes({
          "service.name": "agent-studio",
          ...(this.options.project
            ? { "openinference.project.name": this.options.project }
            : {}),
        }),
        spanProcessors: [this.processor],
      });
      this.tracer = this.provider.getTracer("agent-studio.agent", "2.0.0");
    }
    this.metrics = this.processor?.metrics ?? {
      exported: 0,
      failed: 0,
      dropped: 0,
    };
  }
  async span<T>(
    name: string,
    kind: TraceKind,
    metadata: TraceMetadata,
    operation: (span: ExecutionSpan) => Promise<T>,
  ): Promise<T> {
    const parent = this.scope.getStore();
    const sampled =
      parent?.span.sampled ??
      Boolean(this.tracer && Math.random() < (this.options.sampleRate ?? 1));
    const safeName = /^[a-z0-9_./-]{1,160}$/iu.test(name) ? name : "operation";
    const frameworkContext = parent?.otel
      ? frameworkParent(parent.span.id)
      : undefined;
    const otel = sampled
      ? this.tracer!.startSpan(
          safeName,
          {},
          frameworkContext
            ? trace.setSpanContext(ROOT_CONTEXT, frameworkContext)
            : parent?.otel
              ? trace.setSpan(ROOT_CONTEXT, parent.otel)
              : ROOT_CONTEXT,
        )
      : undefined;
    const ids = otel?.spanContext();
    const span: ExecutionSpan = {
      id: ids?.spanId ?? randomBytes(8).toString("hex"),
      traceId:
        ids?.traceId ?? parent?.span.traceId ?? randomBytes(16).toString("hex"),
      parentId: frameworkContext?.spanId ?? parent?.span.id,
      name: safeName,
      kind,
      startedAt: Date.now(),
      sampled,
      metadata: { ...parent?.span.metadata, ...safeTraceMetadata(metadata) },
    };
    const live: LiveSpan = { span, otel };
    try {
      const result = await this.scope.run(live, () =>
        activeTracer.run(this, () => operation(span)),
      );
      this.finish(live, "completed");
      return result;
    } catch (error) {
      // Human interaction is a successful control-flow boundary. Only trusted
      // platform classes qualify; an external tool's matching code is no grant.
      // Never inspect/export the request, checkpoint or private continuation.
      if (
        error instanceof InteractionSuspension ||
        error instanceof InteractionWaiting
      ) {
        this.finish(live, "waiting");
        throw error;
      }
      const record =
        error && typeof error === "object"
          ? (error as { code?: unknown; errorCode?: unknown })
          : {};
      const raw = record.code ?? record.errorCode ?? span.metadata.errorCode;
      const code = safeTraceMetadata({ errorCode: raw }).errorCode;
      this.finish(
        live,
        "failed",
        typeof code === "string" ? code : "execution_failed",
      );
      throw error;
    }
  }
  framework(allowedNames: readonly string[]): FrameworkCapture {
    const current = this.scope.getStore();
    if (!this.tracer || !current?.otel || !current.span.sampled)
      return { callbacks: [], close() {} };
    try {
      return createFrameworkCapture(
        this.tracer,
        trace.setSpan(ROOT_CONTEXT, current.otel),
        current.span.id,
        safeTraceMetadata(current.span.metadata),
        allowedNames,
      );
    } catch {
      // An optional tracing adapter failure must never fail a paid execution.
      return { callbacks: [], close() {} };
    }
  }
  annotate(metadata: TraceMetadata): void {
    const current = this.scope.getStore();
    if (current)
      Object.assign(current.span.metadata, safeTraceMetadata(metadata));
  }
  annotateContent(content: { input?: unknown; output?: unknown }): void {
    if (!this.options.contentEnabled) return;
    const current = this.scope.getStore();
    if (!current?.otel) return;
    if (content.input !== undefined)
      current.otel.setAttribute("input.value", traceContentValue(content.input));
    if (content.output !== undefined)
      current.otel.setAttribute("output.value", traceContentValue(content.output));
  }
  link(span: ExecutionSpan): ExternalTraceMapping {
    return {
      schemaVersion: 1,
      provider: "langsmith",
      enabled: span.sampled,
      traceId: span.traceId,
      runId: langSmithRunId(span.traceId, span.id),
      rootRunId:
        this.processor?.rootRunId(span.id) ??
        langSmithRunId(span.traceId, span.id),
      destination: destinationId(this.options),
    };
  }
  private finish(
    { span, otel }: LiveSpan,
    status: string,
    errorCode?: string,
  ): void {
    if (!otel) return;
    const failed = status === "failed" || span.metadata.status === "failed";
    const metadata = safeTraceMetadata({
      ...span.metadata,
      durationMs: Date.now() - span.startedAt,
      status: failed ? "failed" : status,
      ...(errorCode ? { errorCode } : {}),
    });
    const kinds = {
      chain: OpenInferenceSpanKind.CHAIN,
      llm: OpenInferenceSpanKind.LLM,
      tool: OpenInferenceSpanKind.TOOL,
      retriever: OpenInferenceSpanKind.RETRIEVER,
      embedding: OpenInferenceSpanKind.EMBEDDING,
    };
    otel.setAttribute(
      SemanticConventions.OPENINFERENCE_SPAN_KIND,
      ["agent_graph", "deep_agent", "member_agent", "skill_task"].includes(
        span.name,
      )
        ? OpenInferenceSpanKind.AGENT
        : kinds[span.kind],
    );
    otel.setAttribute("langsmith.span.kind", span.kind);
    otel.setAttribute(
      SemanticConventions.METADATA,
      JSON.stringify({
        ...metadata,
        ...(metadata.conversationId
          ? { thread_id: metadata.conversationId }
          : {}),
      }),
    );
    for (const [key, value] of Object.entries(metadata))
      if (value !== null) otel.setAttribute(`app.${key}`, value);
    for (const [key, attribute] of Object.entries(
      span.kind === "llm"
        ? {
            modelName: SemanticConventions.LLM_MODEL_NAME,
            provider: SemanticConventions.LLM_PROVIDER,
            inputTokens: SemanticConventions.LLM_TOKEN_COUNT_PROMPT,
            outputTokens: SemanticConventions.LLM_TOKEN_COUNT_COMPLETION,
            totalTokens: SemanticConventions.LLM_TOKEN_COUNT_TOTAL,
          }
        : span.kind === "embedding"
          ? { modelName: SemanticConventions.EMBEDDING_MODEL_NAME }
          : {},
    )) {
      const value = metadata[key];
      if (typeof value === "string" || typeof value === "number")
        otel.setAttribute(attribute, value);
    }
    const failureCode =
      errorCode ?? String(metadata.errorCode ?? "execution_failed");
    // LangSmith derives run.error from exception events. Export only the
    // allowlisted classification, never the original Error or its stack.
    if (failed)
      otel.addEvent("exception", { "exception.message": failureCode });
    otel.setStatus({
      code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      ...(failed
        ? {
            message: failureCode,
          }
        : {}),
    });
    otel.end();
  }
  async flush(timeoutMs = 3000): Promise<boolean> {
    return this.processor?.flush(timeoutMs) ?? true;
  }
  async close(): Promise<void> {
    await this.provider?.shutdown();
  }
}
