import { BadRequestException, Injectable } from "@nestjs/common";
import { IntegrationService } from "../integrations/integration.service";
import type {
  IntegrationIdentity,
  PublicAgentResult,
} from "../integrations/integration.types";
import { DatabaseService } from "../database.service";
import { ChatApplicationService } from "./chat-application.service";
import type { ChatAnswer, ChatStreamCallbacks } from "./chat.service";
import { withModelCallAccounting } from "./model-call-accounting";
import {
  normalizeRequestContext,
  type RequestContext,
} from "./request-context";
import { AgentManagementService } from "../agent-management/agent-management.service";
import {
  invocationScope,
  type CompositionSnapshot,
} from "../agent-management/runtime-scope";

type Admission = Awaited<ReturnType<IntegrationService["admit"]>>;

@Injectable()
export class IntegrationChatGateway {
  constructor(
    private readonly access: IntegrationService,
    private readonly application: ChatApplicationService,
    private readonly db: DatabaseService,
    private readonly management: AgentManagementService,
  ) {}

  async prepare(
    identity: IntegrationIdentity,
    ownerId: string,
    conversationId: string | undefined,
    question: string,
    key?: string,
    context?: RequestContext,
  ) {
    if (question.trim().length < 2)
      throw new BadRequestException("请输入至少两个字符的问题");
    const normalizedContext = normalizeRequestContext(context, question);
    const compositionSnapshot = await this.management.snapshot(
      identity.app.agentId,
      identity.app.environment,
    );
    const admission = await this.access.admit(
      identity,
      ownerId,
      conversationId,
      question,
      key,
      normalizedContext,
    );
    return {
      identity,
      ownerId,
      question,
      context: normalizedContext,
      admission,
      compositionSnapshot,
    };
  }

  async execute(
    prepared: {
      identity: IntegrationIdentity;
      ownerId: string;
      question: string;
      context?: RequestContext;
      admission: Admission;
      compositionSnapshot?: CompositionSnapshot;
    },
    requestId: string,
    callbacks?: ChatStreamCallbacks,
  ): Promise<
    PublicAgentResult & Pick<ChatAnswer, "progressEvents" | "toolSteps">
  > {
    const { admission, identity, ownerId, question, context } = prepared;
    if (admission.cached)
      return admission.cached as PublicAgentResult &
        Pick<ChatAnswer, "progressEvents" | "toolSteps">;
    try {
      const answer = await invocationScope.run(
        {
          agentId: identity.app.agentId,
          environment: identity.app.environment,
          snapshot: prepared.compositionSnapshot,
        },
        () =>
          withModelCallAccounting(
            this.access.tokens.accounting(identity.app.id, admission.callId),
            () =>
              this.application.ask(
                {
                  channel: identity.kind === "api" ? "api" : "browser",
                  conversationId: admission.conversationId,
                  ownerId,
                  question,
                  context,
                  clientRequestId: admission.clientRequestId,
                  requestId,
                },
                callbacks,
              ),
          ),
      );
      // Exact run/message linkage, never "last question": repeated questions still identify the right trace.
      const metadata = await this.db.query<{
        runId: string;
        traceId: string | null;
        tokens: number;
      }>(
        `SELECT r.id AS "runId", t.id AS "traceId", COALESCE(t.total_tokens,0)::int AS tokens
        FROM conversation_runs r LEFT JOIN chat_traces t ON t.user_message_id=r.user_message_id AND t.kind='answer'
        WHERE r.conversation_id=$1 AND r.client_request_id=$2`,
        [admission.conversationId, admission.clientRequestId],
      );
      const row = metadata.rows[0];
      const result: PublicAgentResult = {
        conversationId: admission.conversationId,
        runId: row?.runId ?? null,
        traceId: row?.traceId ?? null,
        status: "completed",
        answer: answer.answer,
        refused: answer.refused,
        citations: answer.citations,
        progressEvents: answer.progressEvents,
        ...(answer.artifacts?.length ? { artifacts: answer.artifacts } : {}),
        ...(answer.references?.length ? { references: answer.references } : {}),
        ...(answer.structured !== undefined
          ? { structured: answer.structured }
          : {}),
      };
      const completed = await this.access.finish(
        admission.callId,
        result,
        row?.tokens ?? 0,
      );
      return {
        ...(completed ?? result),
        progressEvents: answer.progressEvents,
        toolSteps: answer.toolSteps,
      };
    } catch (error) {
      await this.access.finish(admission.callId, null);
      throw error;
    }
  }

  publicResult(result: PublicAgentResult): PublicAgentResult {
    const {
      conversationId,
      runId,
      traceId,
      status,
      answer,
      refused,
      citations,
      usage,
      context,
      progressEvents,
      artifacts,
      references,
      structured,
    } = result;
    return {
      conversationId,
      runId,
      traceId,
      status,
      answer,
      refused,
      citations,
      ...(usage ? { usage } : {}),
      ...(context ? { context } : {}),
      ...(progressEvents ? { progressEvents } : {}),
      ...(artifacts?.length ? { artifacts } : {}),
      ...(references?.length ? { references } : {}),
      ...(structured !== undefined ? { structured } : {}),
    };
  }
}
