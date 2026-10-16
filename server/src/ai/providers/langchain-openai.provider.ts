import { Injectable } from "@nestjs/common";
import { ChatOpenAI } from "@langchain/openai";
import {
  AIMessage,
  SystemMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { privateFrameworkCallbackHandlers } from "../agent/private-framework-callbacks";
import { frameworkModelCallbacks } from "../../observability/framework-callbacks";
import type { LlmProvider } from "./llm-provider";
import type {
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  LlmUsage,
  LlmToolCall,
} from "./provider.types";
import {
  ProviderAuthenticationError,
  ProviderContextLengthError,
  ProviderInvalidRequestError,
  ProviderInvalidResponseError,
  ProviderModelNotFoundError,
  ProviderQuotaExhaustedError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderError,
  ProviderUnsupportedResponseFormatError,
  isNonRetryableQuota429,
  parseRetryAfterMs,
  providerDiagnostics,
  ProviderOutputTruncatedError,
  ProviderContentFilteredError,
} from "./provider-errors";

export const MODEL_SDK_IMPLEMENTATION_VERSION = `langchain-openai-${(require("@langchain/openai/package.json") as { version: string }).version}/platform-v1`;

export interface OpenAICompatibleProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens?: number;
  contextWindowTokens?: number;
  supportedModels?: readonly string[];
  /** Explicit compatibility setting, never an unaccounted automatic retry. */
  streamUsage?: boolean;
  supportsImageInput?: boolean;
}

/** Capability adapter, not a governance or execution engine. One SDK invocation
 * per call; retry/fallback/reservations remain exclusively in LlmService. */
@Injectable()
export class LangChainOpenAIProvider implements LlmProvider {
  readonly implementationVersion = MODEL_SDK_IMPLEMENTATION_VERSION;
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly contextWindowTokens?: number;
  constructor(private readonly configuration: OpenAICompatibleProviderOptions) {
    this.model = configuration.model;
    this.maxOutputTokens = configuration.maxOutputTokens;
    this.contextWindowTokens = configuration.contextWindowTokens;
  }
  private modelFor(request: LlmRequest) {
    if (!this.configuration.apiKey) throw new ProviderAuthenticationError();
    if (
      request.images?.length &&
      (!this.configuration.supportsImageInput ||
        request.images.length > 5 ||
        request.images.some(
          (image) =>
            image.mimeType !== "image/jpeg" ||
            !Buffer.isBuffer(image.data) ||
            !image.data.length ||
            image.data.length > 5242880 ||
            image.width < 1 ||
            image.height < 1 ||
            image.width > 2048 ||
            image.height > 2048,
        ))
    )
      throw new ProviderInvalidRequestError();
    if (
      this.configuration.supportedModels?.length &&
      !this.configuration.supportedModels.includes(request.model)
    )
      throw new ProviderModelNotFoundError();
    return new ChatOpenAI({
      apiKey: this.configuration.apiKey,
      model: request.model,
      temperature: request.temperature ?? 0.1,
      maxTokens: request.maxTokens ?? this.maxOutputTokens ?? 1200,
      timeout: this.configuration.timeoutMs,
      maxRetries: 0,
      streamUsage: this.configuration.streamUsage ?? true,
      useResponsesApi: false,
      configuration: {
        baseURL: this.configuration.baseUrl.replace(/\/+$/, ""),
        apiKey: this.configuration.apiKey,
        maxRetries: 0,
        organization: null,
        project: null,
        adminAPIKey: null,
        webhookSecret: null,
        logLevel: "off",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        fetch: async (url, init) => {
          const response = await fetch(url, { ...init, redirect: "error" });
          if (!response.body) return response;
          let bytes = 0;
          const body = response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                bytes += chunk.byteLength;
                if (bytes > 4 * 1024 * 1024)
                  throw new ProviderInvalidResponseError();
                controller.enqueue(chunk);
              },
            }),
          );
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
      },
    });
  }
  private callOptions(request: LlmRequest, signal: AbortSignal) {
    return {
      signal,
      callbacks: frameworkModelCallbacks([...privateFrameworkCallbackHandlers]),
      maxRetries: 0,
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
      ...(request.toolChoice
        ? {
            tool_choice:
              typeof request.toolChoice === "string"
                ? request.toolChoice
                : {
                    type: "function" as const,
                    function: { name: request.toolChoice.name },
                  },
          }
        : {}),
      ...(request.responseFormat
        ? { response_format: request.responseFormat }
        : {}),
    };
  }
  private scope(request: LlmRequest) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new ProviderTimeoutError()),
      this.configuration.timeoutMs,
    );
    timer.unref();
    return {
      signal: request.signal
        ? AbortSignal.any([request.signal, controller.signal])
        : controller.signal,
      close() {
        clearTimeout(timer);
        controller.abort();
      },
    };
  }
  async chat(request: LlmRequest): Promise<LlmResponse> {
    request.signal?.throwIfAborted();
    const model = this.modelFor(request),
      scope = this.scope(request),
      started = Date.now();
    try {
      const message = await model.invoke(
        modelMessages(request),
        this.callOptions(request, scope.signal),
      );
      scope.signal.throwIfAborted();
      if (!AIMessage.isInstance(message))
        throw new ProviderInvalidResponseError();
      return {
        content: textContent(message.content).trim(),
        toolCalls: toolCalls(message),
        usage: messageUsage(message),
        finishReason:
          typeof message.response_metadata.finish_reason === "string"
            ? message.response_metadata.finish_reason
            : null,
        model: request.model,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      throw this.mapError(error, request, scope.signal);
    } finally {
      scope.close();
    }
  }
  stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        const scope = this.scope(request),
          iterator = this.sdkStream(request, scope);
        // Abort BEFORE waiting on the SDK iterator's return. A pending body read
        // must not keep HTTP running merely because a consumer stopped iterating.
        return {
          next: () => iterator.next(),
          return: async () => {
            scope.close();
            return iterator.return();
          },
          throw: async (error: unknown) => {
            scope.close();
            return iterator.throw(error);
          },
        };
      },
    };
  }
  private async *sdkStream(
    request: LlmRequest,
    scope: ReturnType<LangChainOpenAIProvider["scope"]>,
  ): AsyncGenerator<LlmStreamEvent, void> {
    let usage: LlmUsage = {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      },
      finishReason: string | null = null;
    try {
      request.signal?.throwIfAborted();
      const model = this.modelFor(request);
      // The SDK owns SSE, incremental tool IDs and cancellation. No local frame
      // parser, duplicate decoder or stream_options negotiation/retry.
      const stream = await model.stream(
        modelMessages(request),
        this.callOptions(request, scope.signal),
      );
      for await (const chunk of stream) {
        scope.signal.throwIfAborted();
        const text = textContent(chunk.content);
        if (text) yield { type: "text_delta", delta: text };
        for (const call of chunk.tool_call_chunks ?? []) {
          if (
            !Number.isInteger(call.index) ||
            call.index! < 0 ||
            (call.args !== undefined && typeof call.args !== "string")
          )
            throw new ProviderInvalidResponseError();
          yield {
            type: "tool_call_delta",
            index: call.index!,
            ...(call.id ? { id: call.id } : {}),
            ...(call.name ? { name: call.name } : {}),
            ...(call.args ? { argumentsDelta: call.args } : {}),
          };
        }
        const reported = messageUsage(chunk);
        usage = {
          inputTokens: reported.inputTokens ?? usage.inputTokens,
          outputTokens: reported.outputTokens ?? usage.outputTokens,
          totalTokens: reported.totalTokens ?? usage.totalTokens,
        };
        if (typeof chunk.response_metadata.finish_reason === "string")
          finishReason = chunk.response_metadata.finish_reason;
      }
      scope.signal.throwIfAborted();
      yield { type: "completed", usage, finishReason };
    } catch (error) {
      throw this.mapError(error, request, scope.signal);
    } finally {
      scope.close();
    }
  }
  private mapError(
    error: unknown,
    request: LlmRequest,
    signal: AbortSignal,
  ): unknown {
    if (request.signal?.aborted) return request.signal.reason ?? error;
    if (signal.aborted && signal.reason instanceof ProviderTimeoutError)
      return signal.reason;
    if (error instanceof ProviderError) return error;
    const chain: Record<string, unknown>[] = [],
      seen = new Set<unknown>();
    for (
      let cause = error, i = 0;
      cause && typeof cause === "object" && !seen.has(cause) && i < 12;
      i++
    ) {
      seen.add(cause);
      chain.push(cause as Record<string, unknown>);
      cause = (cause as { cause?: unknown }).cause;
    }
    if (
      chain.some((value) =>
        ["TimeoutError", "APIConnectionTimeoutError"].includes(
          String(value.name),
        ),
      )
    )
      return new ProviderTimeoutError();
    const owned = chain.find((value) => value instanceof ProviderError);
    if (owned) return owned;
    if (chain.some((value) => value.name === "ContextOverflowError"))
      return new ProviderContextLengthError(400);
    if (
      chain.some(
        (value) => value.constructor?.name === "LengthFinishReasonError",
      )
    )
      return new ProviderOutputTruncatedError();
    if (
      chain.some(
        (value) => value.constructor?.name === "ContentFilterFinishReasonError",
      )
    )
      return new ProviderContentFilteredError();
    const http = chain.find((value) => typeof value.status === "number");
    if (!http)
      return chain.some((value) =>
        ["APIConnectionError", "AbortError"].includes(String(value.name)),
      )
        ? new ProviderUnavailableError(undefined, null, "connection")
        : new ProviderInvalidResponseError();
    const status = Number(http.status),
      payload = {
        error: http.error ?? { code: http.code, message: http.message },
      };
    const text = JSON.stringify(payload).toLowerCase();
    const retryAfter = parseRetryAfterMs(
      http.headers as { get?: (name: string) => string | null },
    );
    let mapped: ProviderError;
    if (
      request.responseFormat &&
      [400, 422].includes(status) &&
      /response[_ -]?format|json[_ -]?object|structured output/.test(text)
    )
      mapped = new ProviderUnsupportedResponseFormatError(status);
    else if ([401, 403].includes(status))
      mapped = new ProviderAuthenticationError(status);
    else if (
      status === 402 ||
      (status === 429 && isNonRetryableQuota429(payload))
    )
      mapped = new ProviderQuotaExhaustedError(status);
    else if (status === 429)
      mapped = new ProviderRateLimitError(status, retryAfter);
    else if ([408, 504].includes(status)) mapped = new ProviderTimeoutError();
    else if (
      status === 400 &&
      /context[_ -]?length|context window|too many tokens|token limit/.test(
        text,
      )
    )
      mapped = new ProviderContextLengthError(status);
    else if (
      [400, 404].includes(status) &&
      /model[_ -]?not[_ -]?found|model[^\n]*?(not found|does not exist|不存在|未开通)/.test(
        text,
      )
    )
      mapped = new ProviderModelNotFoundError(status);
    else if (status >= 400 && status < 500 && status !== 409)
      mapped = new ProviderInvalidRequestError(status);
    else mapped = new ProviderUnavailableError(status, retryAfter, "server");
    mapped.diagnostics = providerDiagnostics(
      payload,
      this.configuration.apiKey,
    );
    return mapped;
  }
}
function modelMessages(request: LlmRequest): BaseMessage[] {
  let lastUser = -1;
  for (let i = 0; i < request.messages.length; i++)
    if (request.messages[i].role === "user") lastUser = i;
  if (request.images?.length && lastUser < 0)
    throw new ProviderInvalidRequestError();
  return request.messages.map((message, index) => {
    if (message.role === "system")
      return new SystemMessage({
        content: message.content,
        name: message.name,
      });
    if (message.role === "user")
      return new HumanMessage({
        content:
          index === lastUser && request.images?.length
            ? [
                { type: "text", text: message.content },
                ...request.images.map((image) => ({
                  type: "image_url",
                  image_url: {
                    url: `data:${image.mimeType};base64,${image.data.toString("base64")}`,
                    detail: "high",
                  },
                })),
              ]
            : message.content,
        name: message.name,
      });
    if (message.role === "assistant")
      return new AIMessage({
        content: message.content,
        name: message.name,
        tool_calls: message.toolCalls?.map((call) => ({
          id: call.id,
          name: call.name,
          args: call.arguments,
          type: "tool_call" as const,
        })),
      });
    if (message.role === "tool" && message.toolCallId)
      return new ToolMessage({
        content: message.content,
        tool_call_id: message.toolCallId,
        name: message.name,
      });
    throw new ProviderInvalidRequestError();
  });
}
function textContent(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (part) =>
        typeof part === "object" &&
        part.type === "text" &&
        !("thought" in part && part.thought === true) &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}
function messageUsage(message: BaseMessage): LlmUsage {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const metadata = record(message.response_metadata);
  const raw = record(metadata.usage),
    sdk = record(metadata.tokenUsage);
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  return {
    inputTokens: number(raw.prompt_tokens) ?? number(sdk.promptTokens),
    outputTokens: number(raw.completion_tokens) ?? number(sdk.completionTokens),
    totalTokens: number(raw.total_tokens) ?? number(sdk.totalTokens),
  };
}
function toolCalls(message: AIMessage): LlmToolCall[] {
  // A few compatible services send already-parsed argument objects. Keep this
  // narrow normalization without duplicating the SDK's standard JSON parser.
  const normalized = (message.invalid_tool_calls ?? []).map((call) => {
    if (
      typeof call.id !== "string" ||
      !call.id ||
      typeof call.name !== "string" ||
      !call.name ||
      !call.args ||
      typeof call.args !== "object" ||
      Array.isArray(call.args)
    )
      throw new ProviderInvalidResponseError();
    return {
      id: call.id,
      name: call.name,
      args: call.args as Record<string, unknown>,
    };
  });
  const byId = new Map(
    [...(message.tool_calls ?? []), ...normalized].map((call) => [
      call.id,
      call,
    ]),
  );
  if (byId.size !== (message.tool_calls?.length ?? 0) + normalized.length)
    throw new ProviderInvalidResponseError();
  const rawOrder = message.additional_kwargs.tool_calls;
  const ordered = Array.isArray(rawOrder)
    ? rawOrder.map((call) => byId.get(call.id))
    : [...byId.values()];
  return ordered.map((call) => {
    if (!call) throw new ProviderInvalidResponseError();
    if (
      typeof call.id !== "string" ||
      !call.id ||
      typeof call.name !== "string" ||
      !call.name ||
      !call.args ||
      typeof call.args !== "object" ||
      Array.isArray(call.args)
    )
      throw new ProviderInvalidResponseError();
    return { id: call.id, name: call.name, arguments: call.args };
  });
}
