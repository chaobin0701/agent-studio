import type { PlanVersion } from "../model-management/model-management.types";
import { isRoutedProvider } from "../model-management/model-route";
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { LLM_PROVIDER, LlmProvider } from "../ai/providers/llm-provider";
import {
  ProviderError,
  type ProviderErrorKind,
} from "../ai/providers/provider-errors";
import {
  LlmMessage,
  LlmRequest,
  LlmResponseFormat,
  LlmToolCall,
  LlmToolDefinition,
} from "../ai/providers/provider.types";
import { AppConfigService } from "../config/config.service";
import { reserveModelCall } from "./model-call-accounting";
import {
  executionSpan,
  annotateExecution,
} from "../observability/execution-tracer";

import { measureModelContext, type ModelContextUsage } from "./context-governor";

export const LLM_MAX_RETRIES = 3;
export const LLM_MAX_ATTEMPTS = LLM_MAX_RETRIES + 1;
export const LLM_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
const TEST_RETRY_DELAYS_MS = [10, 20, 40] as const;
export const RETRY_AFTER_BUFFER_MS = 1000;

export type LlmErrorKind =
  | ProviderErrorKind
  | "empty_response"
  | "protocol"
  | "stream_interrupted"
  | "unknown";

export type LlmAttemptRecord = {
  attempt: number;
  maxAttempts: number;
  deploymentId?: number;
  versionId?: number;
  model?: string;
  durationMs: number;
  ok: boolean;
  errorCode?: string;
  errorKind?: LlmErrorKind;
  retryable?: boolean;
  delayMs?: number;
  timestamp: string;
};

export type RetryStatusEvent = {
  type: "retry_status";
  state: "waiting" | "recovered" | "exhausted";
  target: "model" | "tool";
  stage: "planning" | "tool" | "answer" | "summary";
  attempt: number;
  maxAttempts: number;
  delayMs?: number;
  errorCode: string;
  errorKind: LlmErrorKind;
  message: string;
};

export type ModelResult = {
  context?: ModelContextUsage;
  content: string;
  toolCalls: LlmToolCall[];
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  finishReason: string | null;
  durationMs: number;
  attempts: number;
  ttftMs?: number | null;
  attemptsTrail?: LlmAttemptRecord[];
};

export type LlmCompletionOptions = {
  signal?: AbortSignal;
  messages?: LlmMessage[];
  images?: LlmRequest["images"];
  tools?: LlmToolDefinition[];
  responseFormat?: LlmResponseFormat;
  toolChoice?: LlmRequest["toolChoice"];
  maxRetries?: number;
  retryDelaysMs?: readonly number[];
  onRetryStatus?: (event: RetryStatusEvent) => void;
};

export type LlmStreamCallbacks = {
  onTextDelta?: (text: string) => void;
  onRetryStatus?: (event: RetryStatusEvent) => void;
};

export class ModelStreamProtocolError extends Error {
  constructor(readonly reason: string) {
    super(`Model stream protocol error: ${reason}`);
    this.name = "ModelStreamProtocolError";
  }
}

export class ModelFailure extends ServiceUnavailableException {
  readonly errorCode: string;
  readonly errorKind: LlmErrorKind;
  readonly attempts: number;
  readonly retryExhausted: boolean;
  readonly attemptsTrail: LlmAttemptRecord[];

  constructor(
    readonly usage: Pick<
      ModelResult,
      "inputTokens" | "outputTokens" | "totalTokens"
    >,
    details?: {
      errorCode?: string;
      errorKind?: LlmErrorKind;
      attempts?: number;
      retryExhausted?: boolean;
      attemptsTrail?: LlmAttemptRecord[];
      message?: string;
    },
  ) {
    super(
      details?.message ??
        "Answer service is temporarily unavailable; please try again later",
    );
    this.errorCode = details?.errorCode ?? "model_unavailable";
    this.errorKind = details?.errorKind ?? "server";
    this.attempts = details?.attempts ?? 1;
    this.retryExhausted = details?.retryExhausted ?? false;
    this.attemptsTrail = details?.attemptsTrail ?? [];
  }
}

type AttemptFailureDetails = NonNullable<
  ConstructorParameters<typeof ModelFailure>[1]
> & { usage: ModelFailure["usage"] };
// Live ownership marker: remote errors cannot forge this with JSON properties.
// Existing public attempt fields remain compatible; adapters read this record.
const attemptFailures = new WeakMap<object, AttemptFailureDetails>();
export function modelFailureFromError(
  error: unknown,
): ModelFailure | undefined {
  if (error instanceof ModelFailure) return error;
  const details =
    error && typeof error === "object" ? attemptFailures.get(error) : undefined;
  return details ? new ModelFailure(details.usage, details) : undefined;
}

export function calculateLlmRetryDelayMs(
  attempt: number,
  retryAfterMs?: number | null,
  delaysMs: readonly number[] = LLM_RETRY_DELAYS_MS,
): number {
  if (
    typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
  ) {
    return Math.min(retryAfterMs + RETRY_AFTER_BUFFER_MS, 60_000);
  }
  const index = Math.max(0, Math.min(attempt - 1, delaysMs.length - 1));
  return delaysMs[index] ?? 1000;
}

export function formatRetryWaitingMessage(
  target: "model" | "tool",
  errorKind: LlmErrorKind,
  attempt: number,
  maxRetries: number,
  delayMs: number,
): string {
  const prefix =
    target === "tool"
      ? "资料查询暂时异常"
      : errorKind === "timeout"
        ? "模型响应超时"
        : errorKind === "rate_limit"
          ? "模型请求繁忙"
          : errorKind === "connection"
            ? "网络连接波动"
            : "服务响应波动";
  const seconds = Math.max(1, Math.round(delayMs / 1000));
  return `${prefix}，正在进行第 ${attempt}/${maxRetries} 次自动重试（约 ${seconds} 秒后）…`;
}

export function formatRetryExhaustedMessage(
  target: "model" | "tool",
  errorKind: LlmErrorKind,
  maxRetries: number,
): string {
  if (target === "tool") {
    return `工具调用连续重试 ${maxRetries} 次后仍未成功`;
  }
  if (errorKind === "timeout") {
    return `回答服务响应超时（已自动重试 ${maxRetries} 次），请点击重新发送。`;
  }
  if (errorKind === "rate_limit") {
    return `回答服务当前请求繁忙（已自动重试 ${maxRetries} 次），请稍后点击重新发送。`;
  }
  if (errorKind === "quota") {
    return "模型服务账户额度已耗尽，请联系管理员检查模型配置。";
  }
  return `回答服务暂时不可用（已自动重试 ${maxRetries} 次），请点击重新发送。`;
}

@Injectable()
export class LlmService {
  readonly logger = new Logger(LlmService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    @Optional() private readonly config?: AppConfigService,
  ) {}

  async withModelPlan<T>(task: () => Promise<T>): Promise<T> {
    return isRoutedProvider(this.provider)
      ? this.provider.withPlan(task)
      : task();
  }

  async withPinnedModelPlan<T>(
    version: PlanVersion | null,
    task: () => Promise<T>,
  ): Promise<T> {
    return isRoutedProvider(this.provider)
      ? this.provider.withPlanVersion(version, task)
      : task();
  }

  planMetadata() {
    return isRoutedProvider(this.provider)
      ? this.provider.planMetadata()
      : null;
  }

  private schedule(maxRetries?: number) {
    if (isRoutedProvider(this.provider))
      return this.provider.attemptPlan(maxRetries);
    const retries = Math.min(
      LLM_MAX_RETRIES,
      Math.max(0, maxRetries ?? LLM_MAX_RETRIES),
    );
    return Array.from({ length: retries + 1 }, (_, index) => ({
      provider: this.provider,
      deploymentAttempt: index + 1,
      maxRetries: retries,
      deploymentId: undefined as number | undefined,
      versionId: undefined as number | undefined,
    }));
  }

  async completeDetailed(
    system: string,
    user: string,
    model = this.model,
    purpose: "answer" | "summary" | "planner" = "answer",
    options: LlmCompletionOptions = {},
  ): Promise<ModelResult> {
    const explicitModel = model !== this.model;
    return this.withModelPlan(() =>
      this.completeOnPlan(
        system,
        user,
        explicitModel ? model : this.model,
        purpose,
        options,
      ),
    );
  }

  async streamDetailed(
    system: string,
    user: string,
    model = this.model,
    purpose: "answer" | "summary" | "planner" = "answer",
    options: LlmCompletionOptions = {},
    callbacks: LlmStreamCallbacks = {},
  ): Promise<ModelResult> {
    const explicitModel = model !== this.model;
    return this.withModelPlan(() =>
      this.streamOnPlan(
        system,
        user,
        explicitModel ? model : this.model,
        purpose,
        options,
        callbacks,
      ),
    );
  }

  get model(): string {
    return this.provider.model;
  }

  get maxOutputTokens(): number {
    return (
      this.provider.maxOutputTokens ?? this.config?.llm.maxOutputTokens ?? 1200
    );
  }

  get contextWindowTokens(): number {
    return (
      this.provider.contextWindowTokens ??
      this.config?.llm.contextWindowTokens ??
      32000
    );
  }

  async complete(
    system: string,
    user: string,
    model = this.model,
  ): Promise<string> {
    return (await this.completeDetailed(system, user, model)).content;
  }

  private async completeOnPlan(
    system: string,
    user: string,
    model = this.model,
    purpose: "answer" | "summary" | "planner" = "answer",
    options: LlmCompletionOptions = {},
  ): Promise<ModelResult> {
    const started = Date.now();
    const schedule = this.schedule(options.maxRetries);
    const managed = schedule.some(
      (candidate) => candidate.deploymentId !== undefined,
    );
    const maxRetries = managed
      ? countScheduledRetries(schedule)
      : schedule[0]!.maxRetries;
    const maxAttempts = schedule.length;
    const delaysMs =
      options.retryDelaysMs ??
      (process.env.NODE_TEST_CONTEXT
        ? TEST_RETRY_DELAYS_MS
        : LLM_RETRY_DELAYS_MS);
    const stage: RetryStatusEvent["stage"] =
      purpose === "planner" ? "planning" : purpose;
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      seen: false,
    };
    const attemptsTrail: LlmAttemptRecord[] = [];
    let lastReason = "network_error";
    let lastErrorKind: LlmErrorKind = "connection";
    let lastRetryable = true;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      options.signal?.throwIfAborted();
      const candidate = schedule[attempt - 1]!;
      const provider = candidate.provider;
      const attemptStarted = Date.now();
      let reason = "network_error";
      let errorKind: LlmErrorKind = "connection";
      let retryable = true;
      let retryAfterMs: number | null = null;
      const messages = options.messages ?? [
        { role: "system", content: system },
        { role: "user", content: user } satisfies LlmMessage,
      ];
      const request: LlmRequest = {
        model: candidate.deploymentId ? provider.model : model,
        signal: options.signal,
        messages,
        ...(purpose !== "summary" && options.images?.length
          ? { images: options.images }
          : {}),
        ...(options.tools?.length ? { tools: options.tools } : {}),
        ...(options.responseFormat
          ? { responseFormat: options.responseFormat }
          : {}),
        ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
        temperature: 0.1,
        maxTokens:
          purpose === "summary"
            ? Math.min(800, this.maxOutputTokens)
            : this.maxOutputTokens,
      };
      // A quota rejection is not a provider failure and must never be retried or
      // converted into a generic refusal. Each real retry obtains a separate lease.
      const lease = await reserveModelCall(request, purpose);
      let settling = false;
      try {
        const response = await executionSpan(
          "model_attempt",
          "llm",
          {
            attempt,
            maxAttempts,
            purpose,
            modelName: request.model,
            modelAdapterVersion: provider.implementationVersion,
            modelPlanVersionId: candidate.versionId,
            fallback: candidate.deploymentId !== schedule[0]?.deploymentId,
          },
          async () => {
            const value = await provider.chat(request);
            annotateExecution({
              ...value.usage,
              finishReason: value.finishReason,
              ...(!value.content && !value.toolCalls?.length
                ? { status: "failed", errorCode: "empty_response" }
                : {}),
            });
            return value;
          },
        );
        settling = true;
        await lease?.settle(response.usage);
        if (
          response.usage.inputTokens !== null ||
          response.usage.outputTokens !== null ||
          response.usage.totalTokens !== null
        )
          usage.seen = true;
        usage.inputTokens += response.usage.inputTokens ?? 0;
        usage.outputTokens += response.usage.outputTokens ?? 0;
        usage.totalTokens += response.usage.totalTokens ?? 0;
        const toolCalls = response.toolCalls ?? [];
        if (response.content || toolCalls.length > 0) {
          attemptsTrail.push({
            attempt,
            maxAttempts,
            deploymentId: candidate.deploymentId,
            versionId: candidate.versionId,
            model: request.model,
            durationMs: Date.now() - attemptStarted,
            ok: true,
            timestamp: new Date().toISOString(),
          });
          if (attempt > 1) {
            options.onRetryStatus?.({
              type: "retry_status",
              state: "recovered",
              target: "model",
              stage,
              attempt: managed ? candidate.deploymentAttempt - 1 : attempt - 1,
              maxAttempts: managed ? candidate.maxRetries : maxRetries,
              errorCode: lastReason,
              errorKind: lastErrorKind,
              message: "连接已恢复，正在继续处理…",
            });
          }
          return {
            context: measureModelContext(request, provider.contextWindowTokens ?? this.contextWindowTokens, response.usage.inputTokens),
            content: response.content,
            toolCalls,
            model: response.model,
            inputTokens: usage.seen ? usage.inputTokens : null,
            outputTokens: usage.seen ? usage.outputTokens : null,
            totalTokens: usage.seen ? usage.totalTokens : null,
            finishReason: response.finishReason,
            durationMs: Date.now() - started,
            attempts: attempt,
            attemptsTrail,
          };
        }
        reason = `empty_response:${response.finishReason || "unknown"}`;
        errorKind = "empty_response";
        retryable = true;
      } catch (error) {
        if (settling) throw error; // Accounting failure must not repeat a paid model request.
        await lease?.settle(null, error);
        if (
          options.signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        )
          throw error;
        if (error instanceof ProviderError) {
          reason = error.code;
          errorKind = error.errorKind;
          retryable = error.retryable;
          retryAfterMs = error.retryAfterMs;
        } else if (managed) {
          reason = "unknown_error";
          errorKind = "unknown";
          retryable = false;
        }
      }
      lastReason = reason;
      lastErrorKind = errorKind;
      lastRetryable = retryable;
      const canRetry = retryable && attempt < maxAttempts;
      const delayMs = canRetry
        ? calculateLlmRetryDelayMs(
            candidate.deploymentAttempt,
            retryAfterMs,
            delaysMs,
          )
        : undefined;
      attemptsTrail.push({
        attempt,
        maxAttempts,
        deploymentId: candidate.deploymentId,
        versionId: candidate.versionId,
        model: request.model,
        durationMs: Date.now() - attemptStarted,
        ok: false,
        errorCode: reason,
        errorKind,
        retryable,
        ...(delayMs !== undefined ? { delayMs } : {}),
        timestamp: new Date().toISOString(),
      });
      this.logger.warn(
        `Answer model failed model=${request.model} purpose=${purpose} attempt=${attempt}/${maxAttempts} reason=${reason}`,
      );
      if (!canRetry) {
        if (retryable && attempt >= maxAttempts) {
          options.onRetryStatus?.({
            type: "retry_status",
            state: "exhausted",
            target: "model",
            stage,
            attempt: maxRetries,
            maxAttempts: maxRetries,
            errorCode: reason,
            errorKind,
            message: managed
              ? "当前方案中的模型均未能完成请求，请稍后点击重新发送。"
              : formatRetryExhaustedMessage("model", errorKind, maxRetries),
          });
        }
        break;
      }
      options.onRetryStatus?.({
        type: "retry_status",
        state: "waiting",
        target: "model",
        stage,
        attempt: managed
          ? schedule[attempt]?.deploymentId !== candidate.deploymentId
            ? 0
            : candidate.deploymentAttempt
          : attempt,
        maxAttempts: managed
          ? (schedule[attempt]?.maxRetries ?? candidate.maxRetries)
          : maxRetries,
        delayMs,
        errorCode: reason,
        errorKind,
        message:
          schedule[attempt]?.deploymentId !== candidate.deploymentId
            ? "当前模型重试后仍不可用，正在切换备用模型…"
            : formatRetryWaitingMessage(
                "model",
                errorKind,
                candidate.deploymentAttempt,
                candidate.maxRetries,
                delayMs!,
              ),
      });
      await waitForRetry(delayMs!, options.signal);
    }
    const retryExhausted = lastRetryable && attemptsTrail.length >= maxAttempts;
    throw new ModelFailure(
      {
        inputTokens: usage.seen ? usage.inputTokens : null,
        outputTokens: usage.seen ? usage.outputTokens : null,
        totalTokens: usage.seen ? usage.totalTokens : null,
      },
      {
        errorCode: retryExhausted ? "model_retry_exhausted" : lastReason,
        errorKind: lastErrorKind,
        attempts: attemptsTrail.length,
        retryExhausted,
        attemptsTrail,
      },
    );
  }

  async streamText(
    system: string,
    user: string,
    onDelta: (text: string) => void,
    model = this.model,
    purpose: "answer" | "summary" | "planner" = "answer",
    options: Pick<
      LlmCompletionOptions,
      "maxRetries" | "retryDelaysMs" | "onRetryStatus" | "signal"
    > = {},
  ): Promise<ModelResult> {
    return this.streamDetailed(
      system,
      user,
      model,
      purpose,
      {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user } satisfies LlmMessage,
        ],
        ...options,
      },
      { onTextDelta: onDelta, onRetryStatus: options.onRetryStatus },
    );
  }

  private async streamOnPlan(
    system: string,
    user: string,
    model = this.model,
    purpose: "answer" | "summary" | "planner" = "answer",
    options: LlmCompletionOptions = {},
    callbacks: LlmStreamCallbacks = {},
  ): Promise<ModelResult> {
    const started = Date.now();
    const schedule = this.schedule(options.maxRetries);
    const managed = schedule.some(
      (candidate) => candidate.deploymentId !== undefined,
    );
    const maxRetries = managed
      ? countScheduledRetries(schedule)
      : schedule[0]!.maxRetries;
    const maxAttempts = schedule.length;
    const delaysMs =
      options.retryDelaysMs ??
      (process.env.NODE_TEST_CONTEXT
        ? TEST_RETRY_DELAYS_MS
        : LLM_RETRY_DELAYS_MS);
    const stage: RetryStatusEvent["stage"] =
      purpose === "planner" ? "planning" : purpose;
    const notifyRetry = callbacks.onRetryStatus ?? options.onRetryStatus;
    const messages = options.messages ?? [
      { role: "system", content: system },
      { role: "user", content: user } satisfies LlmMessage,
    ];
    const baseRequest: LlmRequest = {
      model,
      signal: options.signal,
      messages,
      ...(purpose !== "summary" && options.images?.length
        ? { images: options.images }
        : {}),
      ...(options.tools?.length ? { tools: options.tools } : {}),
      ...(options.responseFormat
        ? { responseFormat: options.responseFormat }
        : {}),
      ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
      temperature: 0.1,
      maxTokens:
        purpose === "summary"
          ? Math.min(800, this.maxOutputTokens)
          : this.maxOutputTokens,
    };
    const cumulativeUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      seen: false,
    };
    const attemptsTrail: LlmAttemptRecord[] = [];
    let lastError: unknown;
    let lastReason = "network_error";
    let lastErrorKind: LlmErrorKind = "connection";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      options.signal?.throwIfAborted();
      const candidate = schedule[attempt - 1]!;
      const provider = candidate.provider;
      const attemptStarted = Date.now();
      let content = "";
      let usage = {
        inputTokens: null as number | null,
        outputTokens: null as number | null,
        totalTokens: null as number | null,
      };
      let finishReason: string | null = null;
      let completed = false;
      let emitted = false;
      let ttftMs: number | null = null;
      let settling = false;
      const calls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      const request = {
        ...baseRequest,
        model: candidate.deploymentId ? provider.model : model,
      };
      const lease = await reserveModelCall(request, purpose);
      try {
        const toolCalls = await executionSpan(
          "model_attempt",
          "llm",
          {
            attempt,
            maxAttempts,
            purpose,
            modelName: request.model,
            modelAdapterVersion: provider.implementationVersion,
            modelPlanVersionId: candidate.versionId,
            fallback: candidate.deploymentId !== schedule[0]?.deploymentId,
          },
          async () => {
            for await (const event of provider.stream(request)) {
              if (completed)
                throw new ModelStreamProtocolError("event_after_completion");
              if (event.type !== "completed" && ttftMs === null)
                ttftMs = Date.now() - started;
              if (event.type === "text_delta") {
                emitted = true;
                content += event.delta;
                callbacks.onTextDelta?.(event.delta);
              } else if (event.type === "tool_call_delta") {
                emitted = true;
                if (!Number.isInteger(event.index) || event.index < 0)
                  throw new ModelStreamProtocolError("invalid_tool_index");
                const call = calls.get(event.index) ?? {
                  id: "",
                  name: "",
                  arguments: "",
                };
                if (event.id && call.id && event.id !== call.id)
                  throw new ModelStreamProtocolError("conflicting_tool_id");
                if (event.id) call.id = event.id;
                if (event.name) call.name += event.name;
                if (event.argumentsDelta)
                  call.arguments += event.argumentsDelta;
                calls.set(event.index, call);
              } else {
                completed = true;
                usage = event.usage;
                finishReason = event.finishReason;
              }
            }
            if (!completed || (managed && !finishReason))
              throw new ModelStreamProtocolError("missing_completion_event");
            const toolCalls: LlmToolCall[] = [];
            for (const call of [...calls.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, value]) => value)) {
              if (
                !call.id ||
                !call.name ||
                toolCalls.some((previous) => previous.id === call.id)
              )
                throw new ModelStreamProtocolError("invalid_native_tool_calls");
              let parsed: unknown;
              try {
                parsed = JSON.parse(call.arguments);
              } catch {
                throw new ModelStreamProtocolError("invalid_tool_arguments");
              }
              if (
                !parsed ||
                typeof parsed !== "object" ||
                Array.isArray(parsed)
              )
                throw new ModelStreamProtocolError("invalid_tool_arguments");
              toolCalls.push({
                id: call.id,
                name: call.name,
                arguments: parsed as Record<string, unknown>,
              });
            }
            if (!content && toolCalls.length === 0)
              throw new ModelStreamProtocolError("empty_response");
            // Removing application-level answer length caps does not make a model
            // truncation a complete answer. A provider finish reason of `length`
            // means the configured max output token budget was reached; callers
            // must keep the partial text as interrupted and never emit completed.
            if (finishReason === "length")
              throw new ModelStreamProtocolError("output_truncated");
            if (
              toolCalls.length &&
              finishReason !== null &&
              finishReason !== "tool_calls"
            )
              throw new ModelStreamProtocolError("invalid_tool_finish_reason");
            if (!toolCalls.length && finishReason === "tool_calls")
              throw new ModelStreamProtocolError("missing_tool_calls");
            annotateExecution({ ...usage, finishReason });
            return toolCalls;
          },
        );
        settling = true;
        await lease?.settle(usage);
        if (
          usage.inputTokens !== null ||
          usage.outputTokens !== null ||
          usage.totalTokens !== null
        )
          cumulativeUsage.seen = true;
        cumulativeUsage.inputTokens += usage.inputTokens ?? 0;
        cumulativeUsage.outputTokens += usage.outputTokens ?? 0;
        cumulativeUsage.totalTokens += usage.totalTokens ?? 0;
        attemptsTrail.push({
          attempt,
          maxAttempts,
          deploymentId: candidate.deploymentId,
          versionId: candidate.versionId,
          model: request.model,
          durationMs: Date.now() - attemptStarted,
          ok: true,
          timestamp: new Date().toISOString(),
        });
        if (attempt > 1) {
          notifyRetry?.({
            type: "retry_status",
            state: "recovered",
            target: "model",
            stage,
            attempt: managed ? candidate.deploymentAttempt - 1 : attempt - 1,
            maxAttempts: managed ? candidate.maxRetries : maxRetries,
            errorCode: lastReason,
            errorKind: lastErrorKind,
            message: "连接已恢复，正在继续处理…",
          });
        }
        return {
          context: measureModelContext(request, provider.contextWindowTokens ?? this.contextWindowTokens, usage.inputTokens),
          content,
          toolCalls,
          model: request.model,
          inputTokens: cumulativeUsage.seen
            ? cumulativeUsage.inputTokens
            : usage.inputTokens,
          outputTokens: cumulativeUsage.seen
            ? cumulativeUsage.outputTokens
            : usage.outputTokens,
          totalTokens: cumulativeUsage.seen
            ? cumulativeUsage.totalTokens
            : usage.totalTokens,
          finishReason,
          durationMs: Date.now() - started,
          attempts: attempt,
          ttftMs,
          attemptsTrail,
        };
      } catch (error) {
        if (settling) throw error;
        await lease?.settle(usage, error);
        if (
          options.signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        )
          throw error;
        if (
          usage.inputTokens !== null ||
          usage.outputTokens !== null ||
          usage.totalTokens !== null
        )
          cumulativeUsage.seen = true;
        cumulativeUsage.inputTokens += usage.inputTokens ?? 0;
        cumulativeUsage.outputTokens += usage.outputTokens ?? 0;
        cumulativeUsage.totalTokens += usage.totalTokens ?? 0;
        lastError = error;

        const classified = classifyStreamError(error, emitted, managed);
        lastReason = classified.errorCode;
        lastErrorKind = classified.errorKind;
        const canRetry = classified.retryable && attempt < maxAttempts;
        const delayMs = canRetry
          ? calculateLlmRetryDelayMs(
              candidate.deploymentAttempt,
              classified.retryAfterMs,
              delaysMs,
            )
          : undefined;
        attemptsTrail.push({
          attempt,
          maxAttempts,
          deploymentId: candidate.deploymentId,
          versionId: candidate.versionId,
          model: request.model,
          durationMs: Date.now() - attemptStarted,
          ok: false,
          errorCode: classified.errorCode,
          errorKind: classified.errorKind,
          retryable: classified.retryable,
          ...(delayMs !== undefined ? { delayMs } : {}),
          timestamp: new Date().toISOString(),
        });
        this.logger.warn(
          `Answer stream failed model=${request.model} purpose=${purpose} attempt=${attempt}/${maxAttempts} emitted=${emitted} reason=${classified.errorCode}`,
        );
        if (!canRetry) {
          const retryExhausted = classified.retryable && attempt >= maxAttempts;
          if (retryExhausted) {
            notifyRetry?.({
              type: "retry_status",
              state: "exhausted",
              target: "model",
              stage,
              attempt: maxRetries,
              maxAttempts: maxRetries,
              errorCode: classified.errorCode,
              errorKind: classified.errorKind,
              message: managed
                ? "当前方案中的模型均未能完成请求，请稍后点击重新发送。"
                : formatRetryExhaustedMessage(
                    "model",
                    classified.errorKind,
                    maxRetries,
                  ),
            });
          }
          attachAttemptMetadata(error, {
            errorCode: retryExhausted
              ? "model_retry_exhausted"
              : classified.errorCode,
            errorKind: classified.errorKind,
            attempts: attemptsTrail.length,
            retryExhausted,
            attemptsTrail,
            usage: {
              inputTokens: cumulativeUsage.seen
                ? cumulativeUsage.inputTokens
                : null,
              outputTokens: cumulativeUsage.seen
                ? cumulativeUsage.outputTokens
                : null,
              totalTokens: cumulativeUsage.seen
                ? cumulativeUsage.totalTokens
                : null,
            },
          });
          throw error;
        }
        notifyRetry?.({
          type: "retry_status",
          state: "waiting",
          target: "model",
          stage,
          attempt: managed
            ? schedule[attempt]?.deploymentId !== candidate.deploymentId
              ? 0
              : candidate.deploymentAttempt
            : attempt,
          maxAttempts: managed
            ? (schedule[attempt]?.maxRetries ?? candidate.maxRetries)
            : maxRetries,
          delayMs,
          errorCode: classified.errorCode,
          errorKind: classified.errorKind,
          message:
            schedule[attempt]?.deploymentId !== candidate.deploymentId
              ? "当前模型重试后仍不可用，正在切换备用模型…"
              : formatRetryWaitingMessage(
                  "model",
                  classified.errorKind,
                  candidate.deploymentAttempt,
                  candidate.maxRetries,
                  delayMs!,
                ),
        });
        await waitForRetry(delayMs!, options.signal);
      }
    }
    throw lastError ?? new ModelStreamProtocolError("unknown");
  }
}

function classifyStreamError(
  error: unknown,
  emitted: boolean,
  managed = false,
): {
  errorCode: string;
  errorKind: LlmErrorKind;
  retryable: boolean;
  retryAfterMs: number | null;
} {
  if (error instanceof ModelStreamProtocolError) {
    // Before any tokens are emitted, an empty_response or premature stream close
    // is a transient upstream hiccup that can safely be retried.
    const transientProtocol =
      !emitted &&
      (error.reason === "empty_response" ||
        error.reason === "missing_completion_event");
    return {
      errorCode: error.reason,
      errorKind:
        error.reason === "empty_response" ? "empty_response" : "protocol",
      retryable: transientProtocol,
      retryAfterMs: null,
    };
  }
  if (emitted) {
    return {
      errorCode:
        error instanceof ProviderError ? error.code : "stream_interrupted",
      errorKind: "stream_interrupted",
      retryable: false,
      retryAfterMs: null,
    };
  }
  if (error instanceof ProviderError) {
    return {
      errorCode: error.code,
      errorKind: error.errorKind,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return {
    errorCode: managed ? "unknown_error" : "network_error",
    errorKind: managed ? "unknown" : "connection",
    retryable: !managed,
    retryAfterMs: null,
  };
}

function attachAttemptMetadata(
  error: unknown,
  metadata: {
    errorCode: string;
    errorKind: LlmErrorKind;
    attempts: number;
    retryExhausted: boolean;
    attemptsTrail: LlmAttemptRecord[];
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
    };
  },
) {
  if (!error || typeof error !== "object") return;
  attemptFailures.set(error, {
    ...metadata,
    usage: { ...metadata.usage },
    attemptsTrail: metadata.attemptsTrail.map((attempt) => ({ ...attempt })),
  });
  try {
    Object.assign(error, metadata);
  } catch {
    /* A frozen vendor error must not replace the actual failure. */
  }
}

async function waitForRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function countScheduledRetries(
  schedule: { deploymentAttempt: number }[],
): number {
  return schedule.filter((candidate) => candidate.deploymentAttempt > 1).length;
}
