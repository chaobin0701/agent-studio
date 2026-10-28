import { runtimeScope } from "../../agent-management/runtime-scope";
import { Injectable, Logger } from "@nestjs/common";
import { safeToolValidation, type ToolValidationDiagnostics } from "./tool-validation";
import { z } from "zod";
import { AgentTool } from "./agent-tool";
import { ToolContext } from "./tool-context";
import { ToolPolicy, ToolExecutionState } from "./tool-policy";
import { ToolRegistry } from "./tool-registry";
import { ToolResult } from "./tool-result";
import type { LlmToolDefinition } from "../providers/provider.types";
import type { ContextResource } from "../context/context-contribution";
import {
  hasToolCapability,
  type AgentToolCapability,
} from "./tool-capabilities";
import { ProviderError } from "../providers/provider-errors";
import { redactToolData } from "../../tool-management/network";
import {
  formatRetryExhaustedMessage,
  formatRetryWaitingMessage,
  type RetryStatusEvent,
} from "../../chat/llm.service";
import {
  executionSpan,
  annotateExecution,
  annotateTraceContent,
} from "../../observability/execution-tracer";
import { currentExecutionBudget } from "../agent/execution-budget";
import type {
  AgentExecutionChannel,
  AgentAction,
} from "../agent/execution-contract";

export const TOOL_MAX_RETRIES = 3;
export const TOOL_MAX_ATTEMPTS = TOOL_MAX_RETRIES + 1;
export const TOOL_RETRY_DELAYS_MS = [500, 1000, 2000] as const;
const TEST_TOOL_RETRY_DELAYS_MS = [10, 20, 40] as const;
// Only bounded, credential-free knowledge diagnostics may enter the trace.
const retrievalTraceSchema = z.object({
  embeddingPlanVersionId: z.number().int().positive().nullable(),
  embeddingCalls: z.number().int().min(0).max(40),
  retrievalConfigs: z
    .array(
      z.object({
        knowledgeBaseId: z.number().int().positive(),
        indexVersionId: z.number().int().positive().nullable(),
        config: z.object({
          retrievalMode: z.enum(["auto", "fulltext", "vector", "hybrid"]),
        }),
        requestedRetrievalMode: z.enum([
          "auto",
          "fulltext",
          "vector",
          "hybrid",
        ]),
        fallbackReason: z
          .enum([
            "index_has_no_vectors",
            "index_model_unavailable",
            "model_mismatch",
            "index_not_ready",
          ])
          .nullable(),
        embeddingProfileId: z.number().int().positive().nullable().optional(),
      }),
    )
    .max(40),
});

export type ToolAttemptRecord = {
  attempt: number;
  maxAttempts: number;
  durationMs: number;
  ok: boolean;
  errorCode?: string;
  retryable?: boolean;
  delayMs?: number;
  timestamp: string;
};

export type ToolExecutionTrace = {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  attempts?: number;
  retryExhausted?: boolean;
  attemptsTrail?: ToolAttemptRecord[];
  errorCode?: string;
  resultChars?: number;
  reused?: boolean;
  deferred?: boolean;
  retrieval?: z.infer<typeof retrievalTraceSchema>;
  validation?: ToolValidationDiagnostics;
};

export type ToolExecutionOutcome = {
  result: ToolResult;
  trace: ToolExecutionTrace;
  contextResources?: ContextResource[];
};

export type ToolExecutionOptions = {
  maxRetries?: number;
  retryDelaysMs?: readonly number[];
  onRetryStatus?: (event: RetryStatusEvent) => void;
};

const TRANSIENT_TOOL_ERROR_CODES = new Set([
  "tool_timeout",
  "mcp_tool_unavailable",
  "service_unavailable",
  "rate_limited",
  "transient_error",
]);

const TRANSIENT_EXCEPTION_MARKERS = [
  "etimedout",
  "econnreset",
  "econnrefused",
  "epipe",
  "und_err_connect_timeout",
  "timeouterror",
  "timeout",
  "timed out",
  "rate limit",
  "temporarily unavailable",
  "overloaded",
  "connection terminated",
  "connection timeout",
  "network_error",
  "502",
  "503",
  "504",
] as const;

export function isTransientToolException(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof ToolTimeoutError) return true;
  if (error instanceof ProviderError) return error.retryable;
  if (
    typeof error === "object" &&
    "retryable" in error &&
    typeof (error as { retryable?: unknown }).retryable === "boolean"
  ) {
    return Boolean((error as { retryable: boolean }).retryable);
  }
  const code =
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code.toLowerCase()
      : "";
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  const combined = `${code} ${name} ${message}`;
  return TRANSIENT_EXCEPTION_MARKERS.some((marker) =>
    combined.includes(marker),
  );
}

export function isRetryableToolResult(result: ToolResult): boolean {
  if (result.success) return false;
  if (
    result.metadata &&
    typeof result.metadata === "object" &&
    (result.metadata as { retryable?: unknown }).retryable === true
  ) {
    return true;
  }
  return Boolean(
    result.errorCode && TRANSIENT_TOOL_ERROR_CODES.has(result.errorCode),
  );
}

@Injectable()
export class ToolExecutionService {
  private readonly logger = new Logger(ToolExecutionService.name);
  constructor(
    private readonly registry: ToolRegistry,
    private readonly policy: ToolPolicy,
  ) {}

  get maxToolCalls(): number {
    return this.policy.maxToolCalls;
  }

  capabilities() {
    const definitions = this.toolDefinitions();
    const registryWithList = this.registry as ToolRegistry & {
      list?: () => AgentTool[];
    };
    const registered =
      typeof registryWithList.list === "function"
        ? registryWithList.list()
        : [];
    const byName = new Map(registered.map((tool) => [tool.name, tool]));
    const hasCapability = (name: string, capability: AgentToolCapability) => {
      const tool = byName.get(name);
      return (
        tool?.capabilities?.includes(capability) ||
        hasToolCapability(name, capability)
      );
    };
    const groups: Array<{
      id: string;
      name: string;
      description: string;
      capability: AgentToolCapability;
      source: string;
      system: boolean;
    }> = [
      {
        id: "knowledge",
        name: "知识库检索",
        description: "检索已启用知识库的资料，返回可引用片段。",
        capability: "knowledge-search",
        source: "知识库",
        system: false,
      },
      {
        id: "skills",
        name: "专项指导读取",
        description: "模型按需读取可用专项指导，不改变 Agent 权限。",
        capability: "skill",
        source: "静态 Skill 注册表",
        system: true,
      },
    ];
    return groups
      .map(({ capability, ...group }) => ({
        ...group,
        names: definitions
          .filter((tool) => hasCapability(tool.name, capability))
          .map((tool) => tool.name),
        tools: definitions
          .filter((tool) => hasCapability(tool.name, capability))
          .map((tool) => ({
            ...tool,
            source: tool.name.startsWith("mcp_") ? "MCP" : "本地",
            canBatch: this.canBatch(tool.name),
            dependency: byName.get(tool.name)?.planning?.dependency ?? "",
          })),
      }))
      .filter((group) => group.tools.length);
  }

  plannerHints(allowedTools?: readonly string[]): string {
    const registryWithList = this.registry as ToolRegistry & {
      list?: () => AgentTool[];
    };
    const tools =
      typeof registryWithList.list === "function"
        ? registryWithList.list()
        : [];
    return tools
      .filter(
        (tool) =>
          tool.planning && (!allowedTools || allowedTools.includes(tool.name)),
      )
      .map(
        (tool) =>
          `${tool.name}: ${tool.planning!.canBatch ? "可与当前轮其他独立只读工具一起返回" : "单独返回"}${tool.planning!.dependency ? `；${tool.planning!.dependency}` : ""}`,
      )
      .join("\n");
  }

  canBatch(name: string): boolean {
    try {
      return this.registry.get(name).planning?.canBatch ?? true;
    } catch {
      return true;
    }
  }

  executionChannel(
    actions: readonly AgentAction[],
    allowedTools?: readonly string[],
  ): AgentExecutionChannel {
    // A mixed batch remains sequential in the tools node. Do not discard call
    // pairs or reorder writes just to obtain a homogeneous graph node.
    if (
      actions.length !== 1 ||
      (allowedTools && !allowedTools.includes(actions[0].name))
    )
      return "tools";
    try {
      return this.registry.get(actions[0].name).execution?.channel ?? "tools";
    } catch {
      return "tools";
    }
  }

  /** Convert the registered, policy-visible tools to the provider-neutral native tool contract. */
  toolDefinitions(allowedTools?: readonly string[]): LlmToolDefinition[] {
    const allowed = allowedTools ? new Set(allowedTools) : undefined;
    const registryWithList = this.registry as ToolRegistry & {
      list?: () => AgentTool[];
    };
    const tools =
      typeof registryWithList.list === "function"
        ? registryWithList.list()
        : [];
    return tools
      .filter((tool) => !allowed || allowed.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? nativeParametersFor(tool),
      }));
  }

  createState(): ToolExecutionState {
    return this.policy.createState();
  }

  createStateForAgent(
    allowedTools: readonly string[],
    maxToolCalls: number,
    limits: { timeoutMs?: number; maxResultChars?: number } = {},
  ): ToolExecutionState {
    return this.policy.createState({ allowedTools, maxToolCalls, ...limits });
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
    state: ToolExecutionState,
    options?: ToolExecutionOptions,
  ): Promise<ToolExecutionOutcome> {
    return executionSpan(`tool_${name}`, "tool", {}, async () => {
      annotateTraceContent({ input: args });
      const outcome = await this.executeWithTool(
        name,
        args,
        context,
        state,
        undefined,
        options,
      );
      annotateExecution({
        status: outcome.result.success ? "completed" : "failed",
        errorCode: outcome.result.errorCode,
        deferred: outcome.trace.deferred,
        reused: outcome.trace.reused,
      });
      annotateTraceContent({ output: outcome.result });
      return outcome;
    });
  }

  /** Close the native call pair explicitly; the model may reissue it after reading fresh guidance. */
  deferUntilReplanning(
    name: string,
    args: Record<string, unknown>,
    state: ToolExecutionState,
  ): ToolExecutionOutcome {
    const trace: ToolExecutionTrace = {
      name,
      arguments: redactToolData(args),
      ok: false,
      durationMs: 0,
    };
    const failure = this.policy.checkCall(state, name, args);
    if (failure) return this.failure(failure, trace);
    let tool: AgentTool;
    try {
      tool = this.registry.get(name);
    } catch {
      return this.failure("unknown_tool", trace);
    }
    const validation = this.policy.validateInput(tool, args);
    if (!validation.ok) return this.validationFailure(tool, validation.validation, trace);
    return this.failure("tool_requires_replanning", {
      ...trace,
      deferred: true,
    });
  }

  /** Trusted backend-only batch adapter. Retains the registered capability's permission and budget. */
  async executePreflight(
    tool: AgentTool,
    args: Record<string, unknown>,
    context: ToolContext,
    state: ToolExecutionState,
    options?: ToolExecutionOptions,
  ): Promise<ToolExecutionOutcome> {
    return this.executeWithTool(tool.name, args, context, state, tool, options);
  }

  private async executeWithTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
    state: ToolExecutionState,
    preflightTool?: AgentTool,
    options?: ToolExecutionOptions,
  ): Promise<ToolExecutionOutcome> {
    const started = Date.now();
    const baseTrace = (): ToolExecutionTrace => ({
      name,
      arguments: redactToolData(args),
      ok: false,
      durationMs: Date.now() - started,
    });
    // Only a trusted idempotent adapter may opt into request-local read reuse.
    // Validate inputs and permissions even when the successful result is cached.
    if (
      !preflightTool &&
      (!state.allowedTools || state.allowedTools.has(name))
    ) {
      try {
        const registered = this.registry.get(name);
        const parsed = registered.inputSchema.safeParse(args);
        const key =
          parsed.success && registered.planning?.isIdempotent !== false
            ? registered.resultCacheKey?.(parsed.data)
            : undefined;
        const cached = key ? state.resultCache?.get(key) : undefined;
        if (cached?.success)
          return this.outcome(
            registered,
            this.policy.normalizeResult(cached, state.maxResultChars),
            {
              ...baseTrace(),
              ok: true,
              reused: true,
              attempts: 1,
              resultChars: cached.content.length,
            },
          );
      } catch {
        /* The normal path safely reports unknown tools. */
      }
    }
    const policyFailure = this.policy.beforeCall(state, name, args);
    if (policyFailure) {
      return this.failure(policyFailure, baseTrace());
    }

    let tool: AgentTool;
    try {
      tool = this.registry.get(name);
      if (preflightTool) tool = preflightTool;
    } catch {
      return this.failure("unknown_tool", baseTrace());
    }

    const validation = this.policy.validateInput(tool, args);
    if (!validation.ok) return this.validationFailure(tool, validation.validation, baseTrace(), context);

    const isIdempotent = tool.planning?.isIdempotent !== false;
    const maxRetries = isIdempotent
      ? Math.min(
          TOOL_MAX_RETRIES,
          tool.runtimeLimits?.maxRetries ?? TOOL_MAX_RETRIES,
          options?.maxRetries ?? TOOL_MAX_RETRIES,
        )
      : 0;
    const maxAttempts = maxRetries + 1;
    const delaysMs =
      options?.retryDelaysMs ??
      (process.env.NODE_TEST_CONTEXT
        ? TEST_TOOL_RETRY_DELAYS_MS
        : TOOL_RETRY_DELAYS_MS);
    const timeoutMs = Math.min(
      state.timeoutMs ?? this.policy.timeoutMs,
      tool.runtimeLimits?.timeoutMs ?? Infinity,
    );
    const attemptsTrail: ToolAttemptRecord[] = [];
    let lastErrorCode = "tool_execution_failed";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      context.signal?.throwIfAborted();
      const budget = currentExecutionBudget();
      if (budget && !budget.takeTool())
        return this.failure("shared_tool_budget_exceeded", {
          ...baseTrace(),
          attempts: attemptsTrail.length,
          ...(attemptsTrail.length ? { attemptsTrail } : {}),
        });
      const attemptStarted = Date.now();
      try {
        const signal = context.signal
          ? AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs);
        signal.throwIfAborted();
        const result = await executionSpan(
          "tool_attempt",
          "tool",
          {
            attempt,
            maxAttempts,
            toolVersionId: tool.execution?.toolVersionId,
            mcpServerId: tool.execution?.mcpServerId,
          },
          async () => {
            const value = await this.withTimeout(
              tool.execute(validation.input, { ...context, signal }),
              timeoutMs,
              context.signal,
            );
            annotateExecution({
              status: value.success ? "completed" : "failed",
              errorCode: value.errorCode,
            });
            return value;
          },
        );
        const normalized = this.policy.normalizeResult(
          result,
          state.maxResultChars,
        );
        if (normalized.success) {
          if (!preflightTool && tool.planning?.isIdempotent !== false) {
            // Cache projection failure must never replay a successful operation.
            try {
              const key = tool.resultCacheKey?.(validation.input);
              if (key) (state.resultCache ??= new Map()).set(key, normalized);
            } catch {
              /* Ignore a broken optional cache projector. */
            }
          }
          attemptsTrail.push({
            attempt,
            maxAttempts,
            durationMs: Date.now() - attemptStarted,
            ok: true,
            timestamp: new Date().toISOString(),
          });
          if (attempt > 1) {
            options?.onRetryStatus?.({
              type: "retry_status",
              state: "recovered",
              target: "tool",
              stage: "tool",
              attempt: attempt - 1,
              maxAttempts: maxRetries,
              errorCode: lastErrorCode,
              errorKind: "server",
              message: "资料查询已恢复，正在继续处理…",
            });
          }
          const trace: ToolExecutionTrace = {
            name,
            arguments: redactToolData(args),
            ok: true,
            durationMs: Date.now() - started,
            attempts: attempt,
            ...(attempt > 1 ? { attemptsTrail } : {}),
            resultChars: normalized.content.length,
          };
          return this.outcome(tool, normalized, trace);
        }

        const retryableResult =
          isIdempotent && isRetryableToolResult(normalized);
        const errorCode = normalized.errorCode ?? "tool_execution_failed";
        lastErrorCode = errorCode;
        const canRetry = retryableResult && attempt < maxAttempts;
        const rawDelay =
          delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 500;
        const delayMs = canRetry
          ? Math.min(rawDelay, Math.max(10, timeoutMs))
          : undefined;
        attemptsTrail.push({
          attempt,
          maxAttempts,
          durationMs: Date.now() - attemptStarted,
          ok: false,
          errorCode,
          retryable: retryableResult,
          ...(delayMs !== undefined ? { delayMs } : {}),
          timestamp: new Date().toISOString(),
        });
        if (!canRetry) {
          const retryExhausted =
            retryableResult && attempt >= maxAttempts && maxRetries > 0;
          if (retryExhausted) {
            options?.onRetryStatus?.({
              type: "retry_status",
              state: "exhausted",
              target: "tool",
              stage: "tool",
              attempt: maxRetries,
              maxAttempts: maxRetries,
              errorCode,
              errorKind: errorCode === "tool_timeout" ? "timeout" : "server",
              message: formatRetryExhaustedMessage(
                "tool",
                errorCode === "tool_timeout" ? "timeout" : "server",
                maxRetries,
              ),
            });
          }
          const trace: ToolExecutionTrace = {
            name,
            arguments: redactToolData(args),
            ok: false,
            durationMs: Date.now() - started,
            attempts: attempt,
            ...(retryExhausted ? { retryExhausted: true } : {}),
            ...(attempt > 1 ? { attemptsTrail } : {}),
            errorCode,
            resultChars: normalized.content.length,
          };
          return this.outcome(tool, normalized, trace);
        }
        options?.onRetryStatus?.({
          type: "retry_status",
          state: "waiting",
          target: "tool",
          stage: "tool",
          attempt,
          maxAttempts: maxRetries,
          delayMs,
          errorCode,
          errorKind: errorCode === "tool_timeout" ? "timeout" : "server",
          message: formatRetryWaitingMessage(
            "tool",
            errorCode === "tool_timeout" ? "timeout" : "server",
            attempt,
            maxRetries,
            delayMs!,
          ),
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } catch (error) {
        context.signal?.throwIfAborted();
        const isTimeout = error instanceof ToolTimeoutError;
        const errorCode = isTimeout ? "tool_timeout" : "tool_execution_failed";
        lastErrorCode = errorCode;
        const retryable =
          isIdempotent && (isTimeout || isTransientToolException(error));
        const canRetry = retryable && attempt < maxAttempts;
        const rawDelay =
          delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 500;
        const delayMs = canRetry
          ? Math.min(rawDelay, Math.max(10, timeoutMs))
          : undefined;
        attemptsTrail.push({
          attempt,
          maxAttempts,
          durationMs: Date.now() - attemptStarted,
          ok: false,
          errorCode,
          retryable,
          ...(delayMs !== undefined ? { delayMs } : {}),
          timestamp: new Date().toISOString(),
        });
        if (!canRetry) {
          const retryExhausted =
            retryable && attempt >= maxAttempts && maxRetries > 0;
          if (retryExhausted) {
            options?.onRetryStatus?.({
              type: "retry_status",
              state: "exhausted",
              target: "tool",
              stage: "tool",
              attempt: maxRetries,
              maxAttempts: maxRetries,
              errorCode,
              errorKind: isTimeout ? "timeout" : "server",
              message: formatRetryExhaustedMessage(
                "tool",
                isTimeout ? "timeout" : "server",
                maxRetries,
              ),
            });
          }
          return this.failure(errorCode, {
            ...baseTrace(),
            errorCode,
            attempts: attempt,
            ...(retryExhausted ? { retryExhausted: true } : {}),
            ...(attempt > 1 ? { attemptsTrail } : {}),
          });
        }
        options?.onRetryStatus?.({
          type: "retry_status",
          state: "waiting",
          target: "tool",
          stage: "tool",
          attempt,
          maxAttempts: maxRetries,
          delayMs,
          errorCode,
          errorKind: isTimeout ? "timeout" : "server",
          message: formatRetryWaitingMessage(
            "tool",
            isTimeout ? "timeout" : "server",
            attempt,
            maxRetries,
            delayMs!,
          ),
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return this.failure(lastErrorCode, {
      ...baseTrace(),
      errorCode: lastErrorCode,
      attempts: attemptsTrail.length,
      attemptsTrail,
    });
  }

  private outcome(
    tool: AgentTool,
    result: ToolResult,
    trace: ToolExecutionTrace,
  ): ToolExecutionOutcome {
    if (result.success && hasToolCapability(tool.name, "knowledge-search")) {
      const diagnostics = retrievalTraceSchema.safeParse(result.metadata);
      if (diagnostics.success) trace.retrieval = diagnostics.data;
    }
    // Projection failures cannot change a successfully executed business operation.
    try {
      return {
        result,
        trace,
        ...(result.success && tool.contributeContext
          ? { contextResources: tool.contributeContext(result) }
          : {}),
      };
    } catch {
      return { result, trace };
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ToolTimeoutError()), timeoutMs);
          onAbort = () => reject(signal!.reason);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  private validationFailure(
    tool: AgentTool,
    diagnostics: ToolValidationDiagnostics | undefined,
    trace: ToolExecutionTrace,
    context?: ToolContext,
  ): ToolExecutionOutcome {
    const validation = safeToolValidation(diagnostics);
    const safeId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : undefined;
    this.logger.warn(JSON.stringify({
      event: "tool_input_validation_failed",
      tool: safeId(tool.name), toolVersionId: tool.execution?.toolVersionId,
      traceId: safeId(context?.traceId), sessionId: safeId(context?.sessionId),
      errorCode: "invalid_arguments", durationMs: trace.durationMs,
      ...(validation ? { validation } : {}),
    }));
    const outcome = this.failure("invalid_arguments", { ...trace, ...(validation ? { validation } : {}) });
    if (!validation) return outcome;
    return { ...outcome, result: {
      ...outcome.result,
      content: `参数校验失败。根据以下组件、JSON Pointer 路径和字段约束修正后重试；空路径表示根节点，required 表示缺少必填字段，additionalProperties 表示该组件不允许该属性。不要重复提交相同参数。${JSON.stringify(validation)}`,
    } };
  }

  private failure(
    errorCode: string,
    trace: ToolExecutionTrace,
  ): ToolExecutionOutcome {
    return {
      result: { success: false, content: errorCode, errorCode },
      trace: {
        ...trace,
        ok: false,
        errorCode,
        durationMs: Math.max(0, trace.durationMs),
      },
    };
  }
}

function nativeParametersFor(tool: AgentTool): Record<string, unknown> {
  const capabilities = new Set(tool.capabilities ?? []);
  // The registry is the source of the business capability. The fallback map in
  // hasToolCapability only exists for older adapters that have not yet declared
  // metadata.
  if (capabilities.has("skill") || hasToolCapability(tool.name, "skill")) {
    return {
      type: "object",
      properties: {
        skillId: { type: "string", description: "可用 Skill 摘要中的准确 ID" },
      },
      required: ["skillId"],
      additionalProperties: false,
    };
  }
  if (
    capabilities.has("knowledge-search") ||
    hasToolCapability(tool.name, "knowledge-search")
  ) {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "要检索的资料问题" },
        topK: { type: "integer", minimum: 1, maximum: 8 },
      },
      required: ["query"],
      additionalProperties: false,
    };
  }
  return { type: "object", additionalProperties: true };
}

export class ToolTimeoutError extends Error {
  constructor() {
    super("Tool execution timed out");
    this.name = "ToolTimeoutError";
  }
}
