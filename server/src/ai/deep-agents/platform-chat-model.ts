import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import {
  LlmService,
  ModelFailure,
  modelFailureFromError,
  type ModelResult,
  type RetryStatusEvent,
} from "../../chat/llm.service";
import type {
  LlmMessage,
  LlmResponseFormat,
  LlmToolDefinition,
  LlmImage,
} from "../providers/provider.types";
import { assertSerializable } from "../agent/execution-contract";
import {
  executionSpan,
  safeTraceMetadata,
} from "../../observability/execution-tracer";

export interface PlatformModelOptions extends BaseChatModelCallOptions {
  tools?: LlmToolDefinition[];
  response_format?: LlmResponseFormat;
}
export type ModelFailureDiagnostic = Pick<
  ModelResult,
  | "model"
  | "inputTokens"
  | "outputTokens"
  | "totalTokens"
  | "attempts"
  | "attemptsTrail"
> & {
  ok: false;
  errorCode: string;
  errorKind: string;
  retryExhausted: boolean;
};

/** Governance bridge, not a provider or execution loop. Each generation calls
 * the existing authoritative retry/fallback/usage layer exactly once. */
export class PlatformChatModel extends BaseChatModel<PlatformModelOptions> {
  readonly lc_serializable = false;
  constructor(
    private readonly service: LlmService,
    private readonly purpose: "planner" | "summary" = "planner",
    private readonly onRetryStatus?: (event: RetryStatusEvent) => void,
    private readonly onResult?: (result: ModelResult) => void,
    private readonly codePromptVersion?: string,
    private readonly onToken?: (text: string) => void,
    private readonly onFailure?: (
      failure: ModelFailureDiagnostic,
      error: ModelFailure,
    ) => void,
    private readonly images?: readonly LlmImage[],
  ) {
    super({ maxRetries: 0 });
  }
  _llmType(): string {
    return "platform_managed";
  }
  get modelName(): string {
    return this.service.model;
  }
  get contextWindowTokens(): number {
    return this.service.contextWindowTokens;
  }
  override get callKeys(): string[] {
    return [...super.callKeys, "tools", "tool_choice", "response_format"];
  }
  override bindTools(
    tools: BindToolsInput[],
    kwargs: Partial<PlatformModelOptions> = {},
  ) {
    const definitions = tools.map((tool): LlmToolDefinition => {
      const converted = convertToOpenAITool(tool);
      if (converted.type !== "function")
        throw new TypeError("Unsupported model tool schema");
      return {
        name: converted.function.name,
        description: converted.function.description ?? "",
        parameters: converted.function.parameters ?? {},
      };
    });
    return this.withConfig({ ...kwargs, tools: definitions });
  }
  private options(messages: BaseMessage[], options: this["ParsedCallOptions"]) {
    const converted = messages.map(platformMessage);
    const choice = options.tool_choice;
    let toolChoice: "auto" | "none" | "required" | { name: string } | undefined;
    if (choice === undefined || choice === "auto" || choice === "none")
      toolChoice = choice;
    else if (choice === "any" || choice === "required") toolChoice = "required";
    else if (
      typeof choice === "string" &&
      choice !== "any" &&
      choice !== "required"
    )
      toolChoice = { name: choice };
    else if (
      choice &&
      typeof choice === "object" &&
      choice.type === "function" &&
      typeof choice.function?.name === "string"
    )
      toolChoice = { name: choice.function.name };
    else throw new TypeError("Unsupported model tool choice");
    return {
      messages: converted,
      ...(this.purpose === "planner" && this.images?.length
        ? { images: this.images }
        : {}),
      signal: options.signal,
      tools: options.tools,
      responseFormat: options.response_format,
      toolChoice,
      onRetryStatus: this.onRetryStatus,
    };
  }
  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    const call = () =>
      this.service.completeDetailed(
        "",
        "",
        this.service.model,
        this.purpose,
        this.options(messages, options),
      );
    let result: ModelResult;
    try {
      result =
        this.purpose === "summary"
          ? await executionSpan(
              "context_summary",
              "chain",
              { purpose: "summary", codePromptVersion: this.codePromptVersion },
              call,
            )
          : await call();
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
    this.recordResult(result);
    return {
      generations: [{ text: result.content, message: modelMessage(result) }],
      llmOutput: { usage: usage(result) },
    };
  }
  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    manager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const pending: string[] = [];
    let pendingChars = 0;
    let wake: (() => void) | undefined,
      done = false,
      failure: unknown;
    let result: ModelResult | undefined;
    // Attach both handlers immediately: a stopped iterator cannot leave a rejected
    // model promise unhandled or keep an unbounded background stream running.
    const operation = this.service
      .streamDetailed(
        "",
        "",
        this.service.model,
        this.purpose,
        { ...this.options(messages, options), signal },
        {
          onTextDelta: (delta) => {
            pendingChars += delta.length;
            if (pending.length >= 4096 || pendingChars > 1024 * 1024) {
              controller.abort(new Error("Model stream buffer limit exceeded"));
              return;
            }
            pending.push(delta);
            wake?.();
          },
          onRetryStatus: this.onRetryStatus,
        },
      )
      .then(
        (value) => {
          result = value;
        },
        (error: unknown) => {
          failure = error;
        },
      )
      .finally(() => {
        done = true;
        wake?.();
      });
    try {
      while (!done || pending.length) {
        signal.throwIfAborted();
        if (!pending.length) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
          continue;
        }
        const text = pending.shift()!;
        pendingChars -= text.length;
        try {
          this.onToken?.(text);
        } catch {
          /* Transport projection never retries paid model work. */
        }
        await manager?.handleLLMNewToken(text);
        yield new ChatGenerationChunk({
          text,
          message: new AIMessageChunk({ content: text }),
        });
      }
      if (failure) {
        this.recordFailure(failure);
        throw failure;
      }
      if (!result) throw new Error("Model stream did not complete");
      this.recordResult(result);
      yield new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({
          content: "",
          tool_calls: result.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            args: call.arguments,
            type: "tool_call" as const,
          })),
          usage_metadata: usage(result),
          response_metadata: {
            finish_reason: result.finishReason,
            model_name: result.model,
          },
        }),
      });
    } finally {
      controller.abort();
      await operation;
    }
  }
  private recordFailure(error: unknown) {
    // streamDetailed retains the provider error but attaches its own attempt
    // metadata. Normalize only that owned metadata, never vendor messages/body.
    const failure = modelFailureFromError(error);
    if (!failure) return;
    try {
      this.onFailure?.(
        {
          model: this.service.model,
          ok: false,
          errorCode: String(
            safeTraceMetadata({ errorCode: failure.errorCode }).errorCode ??
              "execution_failed",
          ),
          errorKind: failure.errorKind,
          attempts: failure.attempts,
          attemptsTrail: failure.attemptsTrail,
          retryExhausted: failure.retryExhausted,
          ...failure.usage,
        },
        failure,
      );
    } catch {
      /* Diagnostics cannot retry paid work or replace the domain error. */
    }
  }
  private recordResult(result: ModelResult): void {
    try {
      this.onResult?.(result);
    } catch {
      /* Optional diagnostics cannot replay a completed model call. */
    }
  }
}

function textContent(message: BaseMessage): string {
  if (typeof message.content === "string") return message.content;
  if (
    message.content.every(
      (block) =>
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string",
    )
  )
    return message.content
      .map((block) => (block as { text: string }).text)
      .join("");
  throw new TypeError("Unsupported model message content");
}
export function platformMessage(message: BaseMessage): LlmMessage {
  const content = textContent(message),
    type = message._getType();
  if (type === "human") return { role: "user", content };
  if (type === "system") return { role: "system", content };
  if (type === "tool") {
    const id = (message as BaseMessage & { tool_call_id?: string })
      .tool_call_id;
    if (!id) throw new TypeError("Missing native tool call ID");
    return {
      role: "tool",
      content,
      toolCallId: id,
      ...(message.name ? { name: message.name } : {}),
    };
  }
  if (type === "ai") {
    const ai = message as AIMessage;
    if (ai.invalid_tool_calls?.length)
      throw new TypeError("Invalid native tool call");
    const calls = ai.tool_calls?.map((call) => {
      assertSerializable(call.args);
      if (!call.id || !call.name || !call.args || Array.isArray(call.args))
        throw new TypeError("Invalid native tool call");
      return { id: call.id, name: call.name, arguments: call.args };
    });
    return {
      role: "assistant",
      content,
      ...(calls?.length ? { toolCalls: calls } : {}),
    };
  }
  throw new TypeError("Unsupported model message role");
}
function usage(result: ModelResult) {
  return result.inputTokens !== null &&
    result.outputTokens !== null &&
    result.totalTokens !== null
    ? {
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        total_tokens: result.totalTokens,
      }
    : undefined;
}
function modelMessage(result: ModelResult): AIMessage {
  return new AIMessage({
    content: result.content,
    tool_calls: result.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      args: call.arguments,
      type: "tool_call" as const,
    })),
    usage_metadata: usage(result),
    response_metadata: {
      finish_reason: result.finishReason,
      model_name: result.model,
    },
  });
}
