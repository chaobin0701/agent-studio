import { AgentManagementService } from "../agent-management/agent-management.service";
import { runtimeScope } from "../agent-management/runtime-scope";
import { AgentExecutionService } from "../ai/runtime/agent-execution.service";
import type { AgentInput, AgentCallbacks } from "../ai/agent/agent-input";
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AgentRunLimitError } from "../ai/agent/execution-contract";
import { AgentProtocolError } from "../ai/agent/model-response";
import type { PreviousTurnDto } from "./chat.dto";
import type {
  ChatRun,
  ChatStreamCallbacks,
  CommentaryEvent,
  PublicProgressEvent,
  ToolStep,
} from "./chat.service";
import {
  LlmService,
  ModelFailure,
  ModelStreamProtocolError,
  type RetryStatusEvent,
} from "./llm.service";
import { FileOutputError } from "../artifacts/file-output";
import { contextEstimate } from "./context-governor";
import type { ChatAgentContext } from "./chat.service";
import { ContextMemoryService } from "./context-memory.service";

export const AGENT_REQUEST_TIMEOUT_MS = 180_000;

@Injectable()
export class ChatOrchestratorService {
  constructor(
    private readonly execution: AgentExecutionService,
    private readonly llm: LlmService,
    private readonly management: AgentManagementService,
    @Optional() private readonly contextMemory?: ContextMemoryService,
  ) {}

  async askDetailed(
    ...args: Parameters<ChatOrchestratorService["askOnAgent"]>
  ): Promise<ChatRun> {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("Agent request deadline exceeded")),
      AGENT_REQUEST_TIMEOUT_MS,
    );
    timer.unref();
    const parentSignal = args[8]?.signal;
    args[8] = {
      ...args[8],
      signal: parentSignal
        ? AbortSignal.any([parentSignal, deadline.signal])
        : deadline.signal,
    };
    const originalContext = args[3];
    let context: Record<string, unknown> | undefined;
    args[3] = (value) => {
      context = value;
      value.executionLimits = {
        maxDurationMs: AGENT_REQUEST_TIMEOUT_MS,
        maxModelAttemptsPerDecision: 4,
      };
      originalContext?.(value);
    };
    try {
      return await this.askOnComposition(...args);
    } catch (error) {
      if (
        deadline.signal.aborted &&
        args[8].signal?.reason === deadline.signal.reason
      ) {
        if (context)
          context.errorSummary = {
            phase: "agent_loop",
            errorCode: "agent_timeout",
            errorKind: "timeout",
          };
        throw new ServiceUnavailableException({
          code: "agent_timeout",
          message: "本次任务处理超时，请缩小问题范围后重试。",
        });
      }
      if (parentSignal?.aborted) {
        if (context && !context.errorSummary)
          context.errorSummary = {
            phase: "agent_loop",
            errorCode: "run_cancelled",
            errorKind: "cancelled",
          };
        throw new BadGatewayException({
          code: "run_cancelled",
          message: "本次请求已取消。",
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async askOnComposition(
    ...args: Parameters<ChatOrchestratorService["askOnAgent"]>
  ): Promise<ChatRun> {
    // Every entry must resolve a published Agent. No static configuration or
    // legacy execution fallback, including when platform wiring is incomplete.
    if (!this.management || !this.execution)
      throw new ServiceUnavailableException({
        code: "agent_configuration_unavailable",
        message: "Agent 执行服务未就绪，请联系管理员。",
      });
    const composition =
      args[8]?.compositionSnapshot ?? (await this.management.snapshot());
    const entry = composition.agents.get(composition.entryVersionId);
    if (!entry || entry.version.status !== "published")
      throw new ServiceUnavailableException({
        code: "agent_configuration_unavailable",
        message: "Agent 生效版本不可用，请联系管理员。",
      });
    args[8] = {
      ...args[8],
      compositionSnapshot: composition,
      configurationSnapshot: entry.configurationSnapshot,
      promptSnapshot: entry.promptSnapshot,
    };
    // Scope preparation (memory, Skill catalog) to the fixed entry snapshot.
    // The execution service owns all child calls and shared run accounting.
    return runtimeScope.run(entry, () =>
      this.llm.withPinnedModelPlan(entry.modelPlan, () =>
        this.askOnAgent(...args),
      ),
    );
  }

  private async askOnAgent(
    question: string,
    history: PreviousTurnDto[],
    summary: string,
    onContext?: (context: Record<string, unknown>) => void,
    _onStep?: (step: ToolStep) => void,
    onCommentary?: (event: CommentaryEvent) => void,
    requestedSkillId?: string,
    callbacks?: ChatStreamCallbacks,
    agentContext?: ChatAgentContext,
  ): Promise<ChatRun> {
    const runStarted = Date.now();
    let runContext: Record<string, unknown> | undefined;
    const receiveContext = (context: Record<string, unknown>) => {
      runContext = context;
      context.runStartedAt = runStarted;
      onContext?.(context);
    };
    const composition = agentContext!.compositionSnapshot!;
    const entry = composition.agents.get(composition.entryVersionId);
    if (!entry) throw new ServiceUnavailableException("Agent 发布快照不可用");
    const configurationSnapshot = entry.configurationSnapshot;
    const promptSnapshot = entry.promptSnapshot;
    const agentConfig = configurationSnapshot.configuration;
    const progressEvents: Array<PublicProgressEvent | CommentaryEvent> = [];
    const emitProgress = (event: PublicProgressEvent) => {
      progressEvents.push(event);
      callbacks?.onProgress?.(event);
    };
    const emitCommentary = (event: CommentaryEvent) => {
      progressEvents.push(event);
      callbacks?.onCommentary?.(event);
      onCommentary?.(event);
    };
    const emitCommentaryDelta = (event: CommentaryEvent) =>
      callbacks?.onCommentaryDelta?.(event);
    const emitRetryStatus = (event: RetryStatusEvent) =>
      callbacks?.onRetryStatus?.(event);
    // Ordinary turns have no current/default Skill and no keyword routing.
    // Retain explicit internal requests for real specialist guides only.
    if (
      requestedSkillId &&
      (!entry.skills.has(requestedSkillId) ||
        !agentConfig.enabledSkills.includes(requestedSkillId))
    )
      throw new BadRequestException("Unknown or unavailable skill");
    const initialSkills = requestedSkillId
      ? [entry.skills.get(requestedSkillId)!]
      : [];
    const restoredContext =
      agentContext?.conversationId && this.contextMemory
        ? await this.contextMemory.restore(
            agentContext.conversationId,
            agentContext.contextBlocks ?? [],
            configurationSnapshot.configuration,
          )
        : undefined;
    let deliveredAnswer = "";
    let answerStarted: number | undefined;
    const answerOperationId = `${runStarted}-answer`;
    const deliverAnswer = callbacks?.onAnswerDelta
      ? (text: string) => {
          agentContext?.signal?.throwIfAborted();
          if (answerStarted === undefined) {
            answerStarted = Date.now();
            callbacks.onAnswerStarted?.({ citations: [] });
            emitProgress({
              type: "progress",
              id: `${answerOperationId}-start`,
              operationId: answerOperationId,
              stage: "answer",
              status: "running",
              text: "正在生成回答…",
            });
            if (runContext)
              (
                (runContext.timing ??= {}) as Record<string, unknown>
              ).answerTtftMs = answerStarted - runStarted;
          }
          callbacks.onAnswerDelta!(text);
          deliveredAnswer += text;
          if (runContext) {
            runContext.answerDelivery = { mode: "live", source: "agent_loop" };
            runContext.answerStreamStatus = "generating";
            runContext.partialAnswer = deliveredAnswer;
          }
          agentContext?.signal?.throwIfAborted();
        }
      : undefined;
    const resetAnswer = (text: string) => {
      callbacks?.onAnswerReset?.(text);
      deliveredAnswer = text;
      if (runContext) runContext.partialAnswer = text;
    };
    const input: AgentInput = {
      interactionHost:agentContext?.interactionHost,
      question,
      signal: agentContext?.signal,
      configurationSnapshot,
      promptSnapshot,
      summary,
      recentHistory: history,
      availableSkills: [...entry.skills.values()].map(
        ({ systemInstructions: _body, resources: _resources, ...summary }) =>
          summary,
      ),
      initialSkills,
      conversationId: agentContext?.conversationId,
      traceId: agentContext?.traceId,
      runId: agentContext?.runId,
      priorTranscript: agentContext?.priorTranscript,
      requestContext: agentContext?.requestContext,
      restoredContext,
      initialContextBlocks: agentContext?.currentContextBlocks,
      validateContextResource: this.contextMemory
        ? (resource, signal) =>
            this.contextMemory!.validateResource(
              resource,
              configurationSnapshot.configuration,
              signal,
            )
        : undefined,
    };
    const agentCallbacks: AgentCallbacks = {
      onContext: receiveContext,
      onProgress: emitProgress,
      onCommentary: emitCommentary,
      onCommentaryDelta: emitCommentaryDelta,
      onRetryStatus: emitRetryStatus,
      onAnswerDelta: deliverAnswer,
      onAnswerReset: resetAnswer,
    };
    const operation = this.execution.run(composition, input, agentCallbacks);
    const result = await operation.catch((error) => {
      if (runContext && answerStarted !== undefined) {
        runContext.answerStreamStatus = "interrupted";
        runContext.partialAnswer = deliveredAnswer;
        runContext.answerDelivery = { mode: "live", source: "agent_loop" };
      }
      if (runContext)
        ((runContext.timing ??= {}) as Record<string, unknown>).totalMs =
          Date.now() - runStarted;
      // The runtime has no HTTP concerns; the chat adapter maps a domain error.
      if (error instanceof FileOutputError)
        throw new BadGatewayException({
          code: error.code,
          message:
            "文件产物未获授权、无效或超过执行上限，请调整任务或联系管理员。",
        });
      if (
        error instanceof ModelStreamProtocolError ||
        (error instanceof ModelFailure &&
          ["output_truncated", "content_filtered"].includes(error.errorCode))
      )
        throw new BadGatewayException({
          code: new AgentProtocolError(
            error instanceof ModelStreamProtocolError
              ? error.reason
              : error.errorCode,
          ).code,
          message:
            (error instanceof ModelStreamProtocolError
              ? error.reason
              : error.errorCode) === "output_truncated"
              ? "模型输出达到长度上限，本轮未完成，请调整输出上限后重试。"
              : "模型响应未完成，请调整问题或联系管理员。",
        });
      if (error instanceof AgentProtocolError)
        throw new BadGatewayException({
          code: error.code,
          message:
            error.code === "model_output_truncated"
              ? "模型输出达到长度上限，本轮未完成，请缩小问题范围或联系管理员调整输出上限。"
              : error.code === "model_content_filtered"
                ? "模型服务未能完成本次回答，请调整问题后重试。"
                : "模型响应格式异常，请稍后重试。",
        });
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "collaboration_failed"
      )
        throw new BadGatewayException({
          code: "collaboration_failed",
          message: "专项 Agent 未能完成任务，请稍后重试。",
        });
      if (error instanceof AgentRunLimitError)
        throw new BadGatewayException({
          code: error.code,
          message: "本次任务已达到执行上限，请缩小问题范围后重试。",
        });
      throw error;
    });
    result.contextSnapshot.agentConfigurationRevision =
      configurationSnapshot.revision;
    result.contextSnapshot.agentConfigurationVersion =
      configurationSnapshot.configurationVersion;
    agentContext?.signal?.throwIfAborted();
    result.contextSnapshot.answerDelivery = {
      mode: callbacks?.onAnswerDelta ? "live" : "validated",
      source: "agent_loop",
    };
    if (deliverAnswer) {
      try {
        // Non-streaming provider adapters still deliver once. Normal live streams
        // are never replayed after the model finishes. done carries final citations.
        if (answerStarted === undefined) deliverAnswer(result.result.answer);
        else if (deliveredAnswer !== result.result.answer)
          resetAnswer(result.result.answer);
        agentContext?.signal?.throwIfAborted();
        const timing = (result.contextSnapshot.timing ??= {}) as Record<
          string,
          unknown
        >;
        timing.answerDeliveryMs = Date.now() - (answerStarted ?? Date.now());
        result.contextSnapshot.answerStreamStatus = "completed";
        delete result.contextSnapshot.partialAnswer;
        emitProgress({
          type: "progress",
          id: `${answerOperationId}-complete`,
          operationId: answerOperationId,
          stage: "answer",
          status: "completed",
          text: "回答生成完成",
          durationMs: Number(timing.answerDeliveryMs),
        });
      } catch (error) {
        result.contextSnapshot.answerStreamStatus = "interrupted";
        result.contextSnapshot.partialAnswer = deliveredAnswer;
        result.contextSnapshot.errorSummary = {
          phase: "delivery",
          errorCode: agentContext?.signal?.aborted
            ? "run_cancelled"
            : "answer_delivery_failed",
          errorKind: "stream_interrupted",
        };
        throw error;
      }
    }
    result.result = {
      ...result.result,
      progressEvents: [
        ...(result.result.progressEvents ?? []),
        ...progressEvents,
      ],
    };
    const estimate = contextEstimate(
      result.contextSnapshot.contextBudget as Parameters<
        typeof contextEstimate
      >[0],
    );
    if (estimate) result.result = { ...result.result, context: estimate };
    (
      (result.contextSnapshot.timing ??= {}) as Record<string, unknown>
    ).totalMs = Date.now() - runStarted;
    return {
      traceId: agentContext?.traceId,
      result: result.result,
      contextSnapshot: result.contextSnapshot,
      rawModelOutput: result.rawModelOutput,
      fileOutputs: result.fileOutputs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
    };
  }
}
