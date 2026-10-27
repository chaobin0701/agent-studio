import { uiBlocks } from "../tool-management/ui-tool";
import { currentWorkspaceId } from "../workspaces/workspace-context";
import { ExecutionTracingService } from "../observability/tracing.module";
import {
  annotateExecution,
  safeTraceMetadata,
} from "../observability/execution-tracer";
import { agentMemoryScope } from "../agent-management/runtime-scope";
import { AgentManagementService } from "../agent-management/agent-management.service";
import { ExecutionArtifactService } from "../artifacts/execution-artifact.service";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { DatabaseService } from "../database.service";
import {
  ChatService,
  ChatAnswer,
  ChatRun,
  ChatStreamCallbacks,
  CommentaryEvent,
  ProcessEvent,
  ToolStep,
} from "./chat.service";
import { LlmService, ModelFailure } from "./llm.service";
import { ConversationSnapshot } from "./conversation-snapshot";
import { flattenTranscript } from "./agent-transcript";
import {
  ContextGovernor,
  contextEstimate,
  memoryLimitsForContextWindow,
} from "./context-governor";
import { DEFAULT_SUMMARY_INSTRUCTIONS } from "../config/agent-config";
import { AppConfigService } from "../config/config.service";
import {
  DEFAULT_AGENT_CONFIGURATION,
  type AgentConfiguration,
  type AgentConfigurationSnapshot,
} from "../config/agent-config";
import { AgentSettingsService } from "../config/agent-settings.service";
import {
  INTERNAL_APP_ID,
  type IntegrationRequest,
} from "../integrations/integration.types";
import { IntegrationService } from "../integrations/integration.service";
import {
  contextFingerprint,
  messageContext,
  normalizeRequestContext,
  type RequestContext,
  type MessageContext,
} from "./request-context";
import {
  legacyContextBlocks,
  readContextBlocks,
} from "../ai/context/context-contribution";
import {
  PromptRuntimeService,
  type PromptRuntimeSnapshot,
} from "../prompts/prompt-runtime.service";
import { InteractionService } from "../interactions/interaction.service";
import { InteractionSuspension, type JsonObject,type PublicInteraction } from "../interactions/contracts";
import { DEFAULT_RECORDING_POLICY, RecordingPolicyService } from "../system-mcp/recording-policy.service";

const COOKIE_NAME = "agent_studio_visitor";
const COOKIE_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const RUN_TIMEOUT_SQL = "interval '5 minutes'";
const CLIENT_TYPES = new Set(["browser", "mobile", "wechat", "feishu", "api"]);

type SessionRow = { id: string };
type ConversationRow = {
  id: string;
  title: string;
  summary: string;
  summaryThroughMessageId: number | null;
  createdAt: string;
  updatedAt: string;
};
type MessageRow = {
  interactions?:PublicInteraction[];
  contextUsage?: import("./context-governor").ModelContextUsage;
  structured?: ChatAnswer["structured"];
  artifacts?: ChatAnswer["artifacts"];
  id: number;
  role: "user" | "assistant";
  content: string;
  refused: boolean | null;
  citations: ChatAnswer["citations"];
  toolSteps: ToolStep[];
  progressEvents: ProcessEvent[];
  context?: MessageContext;
  createdAt: string;
};
type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "expired";
type RunRow = {
  id: string;
  conversationId: string;
  clientRequestId: string;
  question: string;
  status: RunStatus;
  expiresAt: string | Date;
  userMessageId: number | null;
  assistantMessageId: number | null;
  context?: RequestContext;
  integrationCallId?:string|null;
};

function clientType(request: Request): string {
  const requested = request.headers["x-client-channel"];
  const value = (Array.isArray(requested) ? requested[0] : requested)
    ?.trim()
    .toLowerCase();
  if (value && CLIENT_TYPES.has(value)) return value;
  return /android|iphone|ipad|mobile/u.test(request.headers["user-agent"] ?? "")
    ? "mobile"
    : "browser";
}

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly chat: ChatService,
    private readonly llm: LlmService,
    @Optional() private readonly contextGovernor?: ContextGovernor,
    @Optional() private readonly config?: AppConfigService,
    @Optional() private readonly settings?: AgentSettingsService,
    @Optional() private readonly access?: IntegrationService,
    @Optional() private readonly promptRuntime?: PromptRuntimeService,
    @Optional() private readonly agentManagement?: AgentManagementService,
    @Optional() private readonly tracing?: ExecutionTracingService,
    @Optional() private readonly artifacts?: ExecutionArtifactService,
    @Optional() private readonly interactions?:InteractionService,
    @Optional() private readonly recordingPolicy?: RecordingPolicyService,
  ) {}

  async session(request: Request, response: Response): Promise<string> {
    const identity = (request as IntegrationRequest).integration;
    if (identity?.ownerId) return identity.ownerId;
    const raw = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`))
      ?.slice(COOKIE_NAME.length + 1);
    if (raw && /^[a-f0-9]{64}$/i.test(raw)) {
      const hash = createHash("sha256").update(raw).digest("hex");
      const existing = await this.database.query<SessionRow>(
        "SELECT id FROM visitor_sessions WHERE token_hash = $1 AND application_id = $2 AND external_user_id IS NULL AND credential_expires_at > now()",
        [hash, INTERNAL_APP_ID],
      );
      if (existing.rows[0]) return existing.rows[0].id;
    }
    const token = randomBytes(32).toString("hex");
    this.access?.checkVisitorBootstrap(
      request.ip || request.socket?.remoteAddress || "unknown",
    );
    const id = randomUUID();
    await this.database.query(
      "INSERT INTO visitor_sessions (id, token_hash, client_type) VALUES ($1, $2, $3)",
      [
        id,
        createHash("sha256").update(token).digest("hex"),
        clientType(request),
      ],
    );
    response.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.secure,
      path: "/api/chat",
      maxAge: COOKIE_AGE_MS,
    });
    return id;
  }

  async list(ownerId: string) {
    await this.expireRuns(ownerId);
    const result = await this.database.query<ConversationRow>(
      `SELECT id, title, summary, summary_through_message_id AS "summaryThroughMessageId",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM conversations WHERE visitor_session_id = $1 ORDER BY updated_at DESC LIMIT 100`,
      [ownerId],
    );
    return result.rows;
  }

  async create(ownerId: string) {
    const result = await this.database.query<ConversationRow>(
      `INSERT INTO conversations (id, visitor_session_id) VALUES ($1, $2)
       RETURNING id, title, summary, summary_through_message_id AS "summaryThroughMessageId",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [randomUUID(), ownerId],
    );
    return result.rows[0];
  }

  async get(ownerId: string, id: string) {
    const result = await this.database.query<ConversationRow>(
      `SELECT id, title, summary, summary_through_message_id AS "summaryThroughMessageId",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM conversations WHERE id = $1 AND visitor_session_id = $2`,
      [id, ownerId],
    );
    if (!result.rows[0]) throw new NotFoundException("Conversation not found");
    return result.rows[0];
  }

  async snapshot(
    ownerId: string,
    id: string,
    configuration?: AgentConfiguration,
    boundaryId = 0,
  ): Promise<ConversationSnapshot> {
    const limits = memoryLimitsForContextWindow(
      Number.isFinite(this.llm.contextWindowTokens)
        ? this.llm.contextWindowTokens
        : 32_000,
    );
    const conversation = await this.get(ownerId, id);
    const recent = await this.database.query<MessageRow>(
      `SELECT id::int, role, content, refused, citations, tool_steps AS "toolSteps", progress_events AS "progressEvents", created_at AS "createdAt"
       FROM conversation_messages WHERE conversation_id = $1 AND id > $3 ORDER BY id DESC LIMIT $2`,
      [id, limits.snapshotMessages, boundaryId],
    );
    const recentMessages = recent.rows.reverse();
    const transcriptRows = await this.database.query<{
      id?: string;
      agentTranscript: unknown;
      contextSnapshot?: Record<string, unknown>;
    }>(
      `SELECT id,CASE WHEN context_snapshot ? 'runtimeContextBlocks'
         THEN jsonb_build_object('runtimeContextBlocks',context_snapshot->'runtimeContextBlocks')
         ELSE jsonb_build_object('agentTranscript',context_snapshot->'agentTranscript') END AS "contextSnapshot",
         context_snapshot->'agentTranscript' AS "agentTranscript"
       FROM chat_traces
       WHERE conversation_id = $1 AND kind = 'answer' AND context_snapshot ? 'agentTranscript' AND user_message_id > $3
       ORDER BY created_at DESC LIMIT $2`,
      [id, limits.transcriptMaxTraces, boundaryId],
    );
    const agentTranscript = flattenTranscript(
      transcriptRows.rows.map((row) => row.agentTranscript),
    ).slice(-limits.transcriptMaxMessages);
    const history: { question: string; answer: string }[] = [];
    for (let index = 0; index + 1 < recentMessages.length; index += 2) {
      const user = recentMessages[index];
      const assistant = recentMessages[index + 1];
      if (
        user.role === "user" &&
        assistant.role === "assistant" &&
        !assistant.refused
      ) {
        history.push({ question: user.content, answer: assistant.content });
      }
    }
    return {
      conversationId: conversation.id,
      summary: conversation.summary,
      summaryThroughMessageId: conversation.summaryThroughMessageId,
      recentMessages: recentMessages.map(
        ({ id: messageId, role, content, refused }) => ({
          id: messageId,
          role,
          content,
          refused,
        }),
      ),
      history,
      agentTranscript,
      contextBlocks: transcriptRows.rows
        .flatMap((row) => {
          const snapshot = row.contextSnapshot ?? {};
          return (
            "runtimeContextBlocks" in snapshot
              ? readContextBlocks(snapshot.runtimeContextBlocks, id)
              : legacyContextBlocks(snapshot, id, row.id)
          ).reverse();
        })
        .slice(0, 100),
    };
  }

  async messages(ownerId: string, id: string) {
    await this.expireRuns(ownerId, id);
    await this.get(ownerId, id);
    const result = await this.database.query<MessageRow>(
      `SELECT id::int, role, content, refused, citations, structured, artifacts, tool_steps AS "toolSteps", progress_events AS "progressEvents", request_context AS context, created_at AS "createdAt"
       FROM conversation_messages WHERE conversation_id = $1 ORDER BY id ASC`,
      [id],
    );
    // UI identity belongs to the conversation run, even without an integration call.
    const linked = (await this.database.query<{
      messageId: number;
      callId: string | null;
      runId: string;
      contextUsage?: import("./context-governor").ModelContextUsage;
    }>(
      `SELECT r.assistant_message_id::int AS "messageId", r.integration_call_id AS "callId",
              r.id AS "runId", c.response->'contextUsage' AS "contextUsage"
       FROM conversation_runs r LEFT JOIN integration_calls c ON c.id = r.integration_call_id
       WHERE r.conversation_id = $1 AND r.assistant_message_id IS NOT NULL`,
      [id],
    )).rows;
    const callIds = linked.flatMap(row => row.callId ? [row.callId] : []);
    const cards = this.interactions ? await this.interactions.listMany(callIds) : new Map<string, PublicInteraction[]>();
    const byMessage = new Map(linked.map(row => [row.messageId, row]));
    return result.rows.map(row => {
      const run = byMessage.get(row.id);
      return {
        ...row,
        uiBlocks: uiBlocks(row.artifacts, run?.runId ?? ""),
        ...(this.interactions ? { interactions: run?.callId ? cards.get(run.callId) ?? [] : [] } : {}),
        ...(run?.contextUsage ? { contextUsage: run.contextUsage } : {}),
      };
    });
  }

  async context(ownerId: string, id: string) {
    await this.get(ownerId, id);
    const result = await this.database.query<{
      contextSnapshot: Record<string, unknown> | null;
    }>(
      `SELECT context_snapshot AS "contextSnapshot" FROM chat_traces
       WHERE conversation_id = $1 AND kind = 'answer' ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    const budget = result.rows[0]?.contextSnapshot?.contextBudget;
    return (
      contextEstimate(
        budget && typeof budget === "object"
          ? (budget as Parameters<typeof contextEstimate>[0])
          : undefined,
      ) ?? null
    );
  }

  async runs(ownerId: string, id: string, limit = 20) {
    await this.expireRuns(ownerId, id);
    await this.get(ownerId, id);
    const result = await this.database.query<RunRow>(
      `SELECT r.id,r.client_request_id AS "clientRequestId",r.question,r.request_context AS context,
              CASE WHEN r.status='expired' OR (c.status IN ('running','waiting') AND c.expires_at<=now()) THEN 'expired' WHEN c.status='waiting' THEN 'waiting' WHEN c.status IN ('failed','expired') THEN c.status ELSE r.status END AS status,
              r.expires_at AS "expiresAt",r.started_at AS "startedAt",r.finished_at AS "finishedAt",
              r.error_code AS "errorCode",r.created_at AS "createdAt",r.integration_call_id AS "integrationCallId",r.assistant_message_id::int AS "assistantMessageId"
       FROM conversation_runs r LEFT JOIN integration_calls c ON c.id=r.integration_call_id WHERE r.conversation_id = $1
       ORDER BY r.created_at DESC LIMIT $2`,
      [id, Math.max(1, Math.min(limit, 50))],
    );
    const cards=await this.interactions?.listMany(result.rows.flatMap(row=>row.integrationCallId?[row.integrationCallId]:[]));
    return result.rows.map(row=>({...row,interactions:row.integrationCallId?cards?.get(row.integrationCallId)??[]:[]}));
  }

  async remove(ownerId: string, id: string): Promise<void> {
    const calls=(await this.database.query<{id:string}>("SELECT r.integration_call_id AS id FROM conversation_runs r JOIN conversations c ON c.id=r.conversation_id WHERE c.id=$1 AND c.visitor_session_id=$2 AND r.status IN ('running','waiting') AND r.integration_call_id IS NOT NULL",[id,ownerId])).rows;
    const result = await this.database.query(
      "DELETE FROM conversations WHERE id = $1 AND visitor_session_id = $2",
      [id, ownerId],
    );
    if (!result.rowCount) throw new NotFoundException("Conversation not found");
    for(const call of calls){await this.interactions?.cancel(call.id);await this.access?.finish(call.id,null);}
  }

  async ask(
    ownerId: string,
    id: string,
    question: string,
    onStep?: (step: ToolStep) => void,
    onCommentary?: (event: CommentaryEvent) => void,
    idempotencyKey?: string,
    requestedSkillId?: string,
    callbacks?: ChatStreamCallbacks,
    context?: RequestContext,
  ): Promise<ChatAnswer> {
    const task = () =>
      this.askWithPlan(
        ownerId,
        id,
        question,
        onStep,
        onCommentary,
        idempotencyKey,
        requestedSkillId,
        callbacks,
        context,
      );
    const execute = () =>
      this.llm.withModelPlan ? this.llm.withModelPlan(task) : task();
    // One metadata-only parent includes preparation and background summary work.
    // It does not add a model call or change response/cancellation ownership.
    return this.tracing
      ? this.tracing.span(
          "agent_request",
          "chain",
          { conversationId: id, workspaceId: currentWorkspaceId() },
          async () => execute(),
        )
      : execute();
  }

  private async askWithPlan(
    ownerId: string,
    id: string,
    question: string,
    onStep?: (step: ToolStep) => void,
    onCommentary?: (event: CommentaryEvent) => void,
    idempotencyKey?: string,
    requestedSkillId?: string,
    callbacks?: ChatStreamCallbacks,
    context?: RequestContext,
  ): Promise<ChatAnswer> {
    const requestContext = normalizeRequestContext(context, question);
    const clientRequestId = this.normalizeIdempotencyKey(idempotencyKey);
    const resuming=Boolean(callbacks?.interactionHost?.resume);
    await this.expireRuns(ownerId, id);
    let previousRun: RunRow | null = null;
    if (clientRequestId) {
      const existing = await this.database.query<RunRow>(
        `SELECT id, conversation_id AS "conversationId", client_request_id AS "clientRequestId", question, request_context AS context, status,
                expires_at AS "expiresAt", user_message_id AS "userMessageId", assistant_message_id AS "assistantMessageId"
         FROM conversation_runs WHERE conversation_id = $1 AND client_request_id = $2`,
        [id, clientRequestId],
      );
      previousRun = existing.rows[0] ?? null;
      if (
        previousRun &&
        (previousRun.question !== question ||
          contextFingerprint(previousRun.context) !==
            contextFingerprint(requestContext))
      ) {
        throw new ConflictException(
          "Idempotency-Key was already used for a different question",
        );
      }
      if (previousRun?.status === "completed")
        return this.resultForRun(previousRun);
      if (
        previousRun &&
        (previousRun.status === "queued" || previousRun.status === "running" || (previousRun.status==="waiting"&&!resuming))
      ) {
        throw new ConflictException("Request is already being processed");
      }
      if (
        previousRun &&
        (previousRun.status === "failed" ||
          previousRun.status === "interrupted")
      ) {
        throw new ConflictException(
          "Previous request failed; retry with a new Idempotency-Key",
        );
      }
    }
    if(resuming && previousRun?.status!=="waiting") throw new ConflictException("原会话任务不处于可恢复的等待状态");
    const lock = await this.database.query(
      `UPDATE conversations SET busy_until = now() + ${RUN_TIMEOUT_SQL}
       WHERE id = $1 AND visitor_session_id = $2 AND (busy_until IS NULL OR busy_until < now())
         AND NOT EXISTS(SELECT 1 FROM conversation_runs r WHERE r.conversation_id=$1 AND r.status='waiting' AND r.expires_at>now() AND ($3::uuid IS NULL OR r.id<>$3))
       RETURNING id, busy_until::text AS "busyUntil"`,
      [id, ownerId,resuming?previousRun!.id:null],
    );
    if (!lock.rowCount) {
      await this.get(ownerId, id);
      if (clientRequestId) {
        const completed = await this.database.query<RunRow>(
          `SELECT id, conversation_id AS "conversationId", client_request_id AS "clientRequestId", question, request_context AS context, status,
                  expires_at AS "expiresAt", user_message_id AS "userMessageId", assistant_message_id AS "assistantMessageId"
           FROM conversation_runs WHERE conversation_id = $1 AND client_request_id = $2`,
          [id, clientRequestId],
        );
        if (
          completed.rows[0]?.status === "completed" &&
          completed.rows[0].question === question &&
          contextFingerprint(completed.rows[0].context) ===
            contextFingerprint(requestContext)
        )
          return this.resultForRun(completed.rows[0]);
      }
      throw new ConflictException(
        "Conversation is already answering a question",
      );
    }
    const busyUntil = lock.rows[0]?.busyUntil as string | undefined;
    let runId: string | null = null;
    try {
      if (clientRequestId) {
        if (resuming && previousRun?.status==="waiting") {
          const resumed=await this.database.query<{id:string}>(`UPDATE conversation_runs SET status='running',finished_at=NULL,expires_at=now()+${RUN_TIMEOUT_SQL},error_code=NULL WHERE id=$1 AND status='waiting' AND integration_call_id=$2 RETURNING id`,[previousRun.id,callbacks?.integrationCallId]);
          if(!resumed.rowCount) throw new ConflictException("原任务状态已变化，请刷新会话");
          runId=resumed.rows[0].id;
        } else if (previousRun?.status === "expired") {
          const resumed = await this.database.query<{ id: string }>(
            `UPDATE conversation_runs
             SET status = 'running', started_at = now(), finished_at = NULL,
                 expires_at = now() + ${RUN_TIMEOUT_SQL}, error_code = NULL
             WHERE id = $1 AND status = 'expired' RETURNING id`,
            [previousRun.id],
          );
          if (!resumed.rows[0])
            throw new ConflictException("Request is already being processed");
          runId = resumed.rows[0].id;
        } else {
          const created = await this.database.query<{ id: string }>(
            `INSERT INTO conversation_runs
              (id, conversation_id, client_request_id, question, status, started_at, expires_at, request_context,integration_call_id)
             VALUES ($1, $2, $3, $4, 'running', now(), now() + ${RUN_TIMEOUT_SQL}, $5::jsonb,$6) RETURNING id`,
            [
              randomUUID(),
              id,
              clientRequestId,
              question,
              JSON.stringify(requestContext),
              callbacks?.integrationCallId??null,
            ],
          );
          runId = created.rows[0].id;
        }
      }
    } catch (error) {
      await this.releaseBusy(ownerId, id, busyUntil);
      if ((error as { code?: string }).code === "23505" && clientRequestId) {
        const duplicate = await this.database.query<RunRow>(
          `SELECT id, conversation_id AS "conversationId", client_request_id AS "clientRequestId", question, request_context AS context, status,
                  expires_at AS "expiresAt", user_message_id AS "userMessageId", assistant_message_id AS "assistantMessageId"
           FROM conversation_runs WHERE conversation_id = $1 AND client_request_id = $2`,
          [id, clientRequestId],
        );
        if (
          duplicate.rows[0]?.question !== question ||
          contextFingerprint(duplicate.rows[0]?.context) !==
            contextFingerprint(requestContext)
        )
          throw new ConflictException(
            "Idempotency-Key was already used for a different request",
          );
        if (duplicate.rows[0]?.status === "completed")
          return this.resultForRun(duplicate.rows[0]);
      }
      throw error;
    }
    const started = Date.now();
    const traceId = callbacks?.executionTraceId??randomUUID();
    annotateExecution({ localRunId: runId, localTraceId: traceId });
    let snapshot: ConversationSnapshot | null = null;
    let contextSnapshot: Record<string, unknown> | null = null;
    try {
      const compositionSnapshot = await this.agentManagement?.snapshot();
      const entryAgent = compositionSnapshot?.agents.get(
        compositionSnapshot.entryVersionId,
      );
      annotateExecution({
        agentId: entryAgent?.version.resourceId,
        agentVersionId: entryAgent?.version.id,
        promptVersionId: entryAgent?.spec.promptVersionId,
        modelPlanVersionId: entryAgent?.modelPlan?.id,
        embeddingPlanVersionId: entryAgent?.embeddingPlan?.id,
      });
      const configurationSnapshot =
        entryAgent?.configurationSnapshot ?? (await this.settings?.snapshot());
      const promptSnapshot =
        entryAgent?.promptSnapshot ??
        (this.promptRuntime ? await this.promptRuntime.snapshot() : undefined);
      const boundary =
        compositionSnapshot && this.agentManagement
          ? await this.agentManagement.prepareMemory(id, compositionSnapshot)
          : 0;
      const readSnapshot = () =>
        this.snapshot(
          ownerId,
          id,
          configurationSnapshot?.configuration,
          boundary,
        );
      const savedSnapshot=callbacks?.interactionHost?.continuation?.execution?.legacyChatSnapshot;
      snapshot = resuming && savedSnapshot
        ? savedSnapshot as unknown as ConversationSnapshot
        : await (entryAgent ? this.llm.withPinnedModelPlan(entryAgent.modelPlan, readSnapshot) : readSnapshot());
      if(resuming && (!snapshot || snapshot.conversationId!==id))throw new ConflictException("原会话上下文不可用，不能重新执行任务");
      const run = await this.chat.askDetailed(
        question,
        snapshot.history,
        snapshot.summary,
        (context) => {
          contextSnapshot = context;
        },
        onStep,
        onCommentary,
        requestedSkillId,
        callbacks,
        {
          signal: callbacks?.signal,
          conversationId: id,
          traceId,
          runId: runId ?? undefined,
          priorTranscript: snapshot.agentTranscript,
          compositionSnapshot,
          configurationSnapshot,
          promptSnapshot,
          requestContext,
          contextBlocks: snapshot.contextBlocks,
          interactionHost:callbacks?.interactionHost,
        },
      );
      await this.saveResult(
        id,
        question,
        run,
        Date.now() - started,
        runId,
        callbacks?.signal,
      );
      const summarize = () =>
        this.updateSummary(
          id,
          snapshot!.summary,
          configurationSnapshot,
          promptSnapshot,
          compositionSnapshot
            ? agentMemoryScope(compositionSnapshot)
            : undefined,
        );
      void (
        entryAgent
          ? this.llm.withPinnedModelPlan(entryAgent.modelPlan, summarize)
          : summarize()
      ).catch(() => this.logger.warn("Conversation summary update failed"));
      return run.result;
    } catch (error) {
      if(error instanceof InteractionSuspension && runId) {
        await this.database.query("UPDATE conversation_runs SET status='waiting',expires_at=now()+interval '24 hours',finished_at=NULL WHERE id=$1 AND status='running'",[runId]);
        throw new InteractionSuspension(error.request,error.interruptId,{...error.continuation,execution:{...error.continuation.execution,legacyChatSnapshot:JSON.parse(JSON.stringify(snapshot)) as JsonObject}});
      }
      const failureBody =
        error instanceof HttpException ? error.getResponse() : null;
      const errorRecord =
        error && typeof error === "object"
          ? (error as Record<string, unknown>)
          : null;
      const nativeContext = contextSnapshot as Record<string, unknown> | null;
      const nativeFailure =
        nativeContext?.executionEngine === "deepagents" &&
        nativeContext.errorSummary &&
        typeof nativeContext.errorSummary === "object"
          ? safeTraceMetadata(
              nativeContext.errorSummary as Record<string, unknown>,
            ).errorCode
          : undefined;
      const retryErrorCode =
        errorRecord?.retryExhausted === true
          ? "model_retry_exhausted"
          : errorRecord?.errorCode === "provider_quota_exhausted"
            ? "provider_quota_exhausted"
            : null;
      const errorCode =
        error instanceof HttpException &&
        (error.getStatus() === 429 ||
          error.getStatus() === 502 ||
          error.getStatus() === 503) &&
        typeof failureBody === "object" &&
        failureBody &&
        "code" in failureBody
          ? String(failureBody.code)
          : typeof nativeFailure === "string"
            ? nativeFailure
            : (retryErrorCode ?? "answer_failed");
      annotateExecution({ status: "failed", errorCode });
      // A protocol failure or retry-exhausted run may occur after one or more paid
      // model responses. Keep known usage in the failed trace instead of losing it.
      const failureContext = contextSnapshot as Record<string, unknown> | null;
      let modelCalls: Array<{
        ok?: boolean;
        response?: Record<string, unknown>;
      }> = Array.isArray(failureContext?.modelCalls)
        ? failureContext.modelCalls
        : [];
      if (failureContext?.executionEngine === "deepagents") {
        // Each member reports only its own models; do not count both its context
        // and aggregated task usage, nor add the same failed attempt twice.
        for (const task of Array.isArray(failureContext.specialistTasks)
          ? failureContext.specialistTasks.slice(0, 10)
          : []) {
          const member =
            task && typeof task === "object" ? task.context : undefined;
          if (member && Array.isArray(member.modelCalls))
            modelCalls = [...modelCalls, ...member.modelCalls];
        }
      }
      const errorUsage =
        errorRecord?.usage && typeof errorRecord.usage === "object"
          ? (errorRecord.usage as Record<string, unknown>)
          : null;
      const knownTokens = (
        field: "inputTokens" | "outputTokens" | "totalTokens",
      ): number | null => {
        const callValues = modelCalls
          .map((call) => call?.response?.[field])
          .filter(
            (value): value is number =>
              typeof value === "number" &&
              Number.isSafeInteger(value) &&
              value >= 0,
          );
        const directUsage =
          typeof errorUsage?.[field] === "number" &&
          Number.isSafeInteger(errorUsage[field]) &&
          (errorUsage[field] as number) >= 0
            ? (errorUsage[field] as number)
            : null;
        if (callValues.length > 0)
          return (
            callValues.reduce((sum, value) => sum + value, 0) +
            (failureContext?.executionEngine === "deepagents" &&
            modelCalls.some((call) => call.ok === false)
              ? 0
              : (directUsage ?? 0))
          );
        return directUsage;
      };
      const snapshotToPersist: Record<string, unknown> = contextSnapshot ?? {
        requestContext,
        summary: snapshot?.summary ?? "",
        recentMessages:
          snapshot?.recentMessages.map(({ role, content }) => ({
            role,
            content,
          })) ?? [],
      };
      if (!snapshotToPersist.errorSummary && errorRecord) {
        snapshotToPersist.errorSummary = {
          errorCode,
          errorKind:
            typeof errorRecord.errorKind === "string"
              ? errorRecord.errorKind
              : "server",
          totalAttempts:
            typeof errorRecord.attempts === "number" ? errorRecord.attempts : 1,
          retryExhausted: Boolean(errorRecord.retryExhausted),
          attemptsTrail: Array.isArray(errorRecord.attemptsTrail)
            ? errorRecord.attemptsTrail
            : [],
        };
      }
      if (runId) {
        await this.database
          .query(
            `UPDATE conversation_runs SET status = 'failed', finished_at = now(), error_code = $2 WHERE id = $1 AND status = 'running'`,
            [runId, errorCode],
          )
          .catch(() =>
            this.logger.warn("Failed to persist conversation run failure"),
          );
      }
      await this.recordTrace({
        id: traceId,
        conversationId: id,
        userMessageId: null,
        question,
        contextSnapshot: snapshotToPersist,
        model: this.llm.model,
        rawModelOutput: null,
        finalAnswer: null,
        refused: null,
        status: "failed",
        errorCode,
        inputTokens:
          error instanceof ModelFailure &&
          failureContext?.executionEngine !== "deepagents"
            ? error.usage.inputTokens
            : knownTokens("inputTokens"),
        outputTokens:
          error instanceof ModelFailure &&
          failureContext?.executionEngine !== "deepagents"
            ? error.usage.outputTokens
            : knownTokens("outputTokens"),
        totalTokens:
          error instanceof ModelFailure &&
          failureContext?.executionEngine !== "deepagents"
            ? error.usage.totalTokens
            : knownTokens("totalTokens"),
        durationMs: Date.now() - started,
      }).catch(() => this.logger.warn("Failed to persist chat failure trace"));
      throw error;
    } finally {
      await this.releaseBusy(ownerId, id, busyUntil);
    }
  }

  private async saveResult(
    conversationId: string,
    question: string,
    run: ChatRun,
    durationMs: number,
    runId: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const policy = await this.recordingPolicy?.current() ?? DEFAULT_RECORDING_POLICY;
    if (
      run.fileOutputs?.length ||
      run.result.artifacts?.some((file) => file.kind === "execution_file")
    ) {
      if (!this.artifacts) throw new ConflictException("文件产物存储不可用");
      this.artifacts.assertSelection(
        run.result.artifacts ?? [],
        run.fileOutputs ?? [],
      );
    }
    await this.database.transaction(async (client) => {
      if (runId) {
        const activeRun = await client.query<{ id: string }>(
          `SELECT id FROM conversation_runs
           WHERE id = $1 AND conversation_id = $2 AND status = 'running'
           FOR UPDATE`,
          [runId, conversationId],
        );
        if (!activeRun.rowCount) {
          throw new ConflictException(
            "Conversation request expired before the answer was saved",
          );
        }
      }
      const user = await client.query<{ id: number }>(
        `INSERT INTO conversation_messages (conversation_id, role, content, request_context)
         VALUES ($1, 'user', $2, $3::jsonb) RETURNING id::int`,
        [
          conversationId,
          question,
          JSON.stringify(
            messageContext(
              run.contextSnapshot.requestContext,
            ),
          ),
        ],
      );
      const assistant = await client.query<{ id: number }>(
        `INSERT INTO conversation_messages (conversation_id, role, content, refused, citations, structured, tool_steps, progress_events, artifacts)
         VALUES ($1, 'assistant', $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb) RETURNING id::int`,
        [
          conversationId,
          run.result.answer,
          run.result.refused,
          JSON.stringify(run.result.citations),
          run.result.structured === undefined ? null : JSON.stringify(run.result.structured),
          JSON.stringify(run.result.toolSteps ?? []),
          JSON.stringify(run.result.progressEvents ?? []),
          JSON.stringify(run.result.artifacts ?? []),
        ],
      );
      await client.query(
        `UPDATE conversations SET title = CASE WHEN title = '新对话' THEN left($2, 120) ELSE title END,
                updated_at = now() WHERE id = $1`,
        [conversationId, question],
      );
      if (policy.traceEnabled) await client.query(
        `INSERT INTO chat_traces
          (id, conversation_id, user_message_id, question, context_snapshot, model, raw_model_output,
           final_answer, refused, status, input_tokens, output_tokens, total_tokens, duration_ms)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, 'completed', $10, $11, $12, $13)`,
        [
          run.traceId ?? randomUUID(),
          conversationId,
          user.rows[0].id,
          policy.conversationContentEnabled ? question : "",
          JSON.stringify(policy.conversationContentEnabled ? run.contextSnapshot : safeTraceMetadata(run.contextSnapshot as any)),
          run.rawModelOutput ? this.llm.model : null,
          policy.conversationContentEnabled ? run.rawModelOutput : null,
          policy.conversationContentEnabled ? run.result.answer : null,
          run.result.refused,
          policy.usageEnabled ? run.inputTokens : null,
          policy.usageEnabled ? run.outputTokens : null,
          policy.usageEnabled ? run.totalTokens : null,
          durationMs,
        ],
      );
      // Files, answer and Trace commit while the Run is locked/running.
      if (run.fileOutputs?.length) {
        if (!run.traceId) throw new ConflictException("文件产物缺少执行标识");
        const owner = (
          await client.query<{
            applicationId: string;
            visitorSessionId: string;
          }>(
            `SELECT application_id AS "applicationId",visitor_session_id AS "visitorSessionId" FROM conversations WHERE id=$1 FOR SHARE`,
            [conversationId],
          )
        ).rows[0];
        if (!owner) throw new NotFoundException("会话不存在");
        const composition = run.contextSnapshot.agentComposition as
          | { entryVersionId: number }
          | undefined;
        if (!composition) throw new ConflictException("文件产物缺少发布版本");
        await this.artifacts!.save(
          client,
          {
            source: "chat",
            traceId: run.traceId,
            runId,
            entryVersionId: composition.entryVersionId,
            ...owner,
            conversationId,
          },
          run.fileOutputs,
          run.result.artifacts ?? [],
        );
      }
      if (runId) {
        await client.query(
          `UPDATE conversation_runs
           SET status = 'completed', finished_at = now(), user_message_id = $2, assistant_message_id = $3, error_code = NULL
           WHERE id = $1`,
          [runId, user.rows[0].id, assistant.rows[0].id],
        );
      }
      signal?.throwIfAborted();
    });
  }

  private normalizeIdempotencyKey(value?: string): string | null {
    if (value === undefined) return null;
    const normalized = value.trim();
    if (
      !normalized ||
      normalized.length > 120 ||
      !/^[A-Za-z0-9._:-]+$/.test(normalized)
    ) {
      throw new BadRequestException("Invalid Idempotency-Key");
    }
    return normalized;
  }

  private async expireRuns(
    ownerId: string,
    conversationId?: string,
  ): Promise<void> {
    const filter = conversationId ? "AND r.conversation_id = $2" : "";
    const values = conversationId ? [ownerId, conversationId] : [ownerId];
    await this.database.query(
      `UPDATE conversation_runs r SET status = 'expired', finished_at = now(), error_code = 'request_expired'
       FROM conversations c
       WHERE r.conversation_id = c.id AND c.visitor_session_id = $1
         ${filter} AND r.status IN ('queued', 'running','waiting') AND r.expires_at <= now()`,
      values,
    );
    if (conversationId) {
      await this.database.query(
        "UPDATE conversations SET busy_until = NULL WHERE id = $1 AND visitor_session_id = $2 AND busy_until < now()",
        [conversationId, ownerId],
      );
    }
  }

  private async releaseBusy(
    ownerId: string,
    conversationId: string,
    busyUntil: string | undefined,
  ): Promise<void> {
    if (busyUntil === undefined) return;
    await this.database.query(
      "UPDATE conversations SET busy_until = NULL WHERE id = $1 AND visitor_session_id = $2 AND busy_until = $3",
      [conversationId, ownerId, busyUntil],
    );
  }

  private async resultForRun(run: RunRow): Promise<ChatAnswer> {
    if (!run.assistantMessageId)
      throw new ConflictException(
        "Saved request result is unavailable; retry with a new Idempotency-Key",
      );
    const result = await this.database.query<MessageRow>(
      `SELECT content, refused, citations, structured, artifacts, tool_steps AS "toolSteps", progress_events AS "progressEvents"
       FROM conversation_messages WHERE id = $1 AND conversation_id = $2`,
      [run.assistantMessageId, run.conversationId],
    );
    const message = result.rows[0];
    if (!message)
      throw new ConflictException(
        "Saved request result is unavailable; retry with a new Idempotency-Key",
      );
    return {
      answer: message.content,
      refused: Boolean(message.refused),
      citations: message.citations ?? [],
      ...(message.structured !== undefined && message.structured !== null ? { structured: message.structured } : {}),
      toolSteps: message.toolSteps ?? [],
      progressEvents: message.progressEvents ?? [],
      ...(message.artifacts?.length ? { artifacts: message.artifacts } : {}),
    };
  }

  private async recordTrace(trace: {
    id: string;
    conversationId: string;
    userMessageId: number | null;
    question: string;
    contextSnapshot: Record<string, unknown>;
    model: string | null;
    rawModelOutput: string | null;
    finalAnswer: string | null;
    refused: boolean | null;
    status: "failed";
    errorCode: string;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    durationMs: number;
  }): Promise<void> {
    const policy = await this.recordingPolicy?.current() ?? DEFAULT_RECORDING_POLICY;
    if (!policy.traceEnabled) return;
    await this.database.query(
      `INSERT INTO chat_traces
        (id, conversation_id, user_message_id, question, context_snapshot, model, raw_model_output,
         final_answer, refused, status, error_code, input_tokens, output_tokens, total_tokens, duration_ms)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        trace.id,
        trace.conversationId,
        trace.userMessageId,
        policy.conversationContentEnabled ? trace.question : "",
        JSON.stringify(policy.conversationContentEnabled ? trace.contextSnapshot : safeTraceMetadata(trace.contextSnapshot as any)),
        trace.model,
        policy.conversationContentEnabled ? trace.rawModelOutput : null,
        policy.conversationContentEnabled ? trace.finalAnswer : null,
        trace.refused,
        trace.status,
        trace.errorCode,
        policy.usageEnabled ? trace.inputTokens : null,
        policy.usageEnabled ? trace.outputTokens : null,
        policy.usageEnabled ? trace.totalTokens : null,
        trace.durationMs,
      ],
    );
  }

  private async updateSummary(
    conversationId: string,
    oldSummary: string,
    configurationSnapshot?: AgentConfigurationSnapshot,
    promptSnapshot?: PromptRuntimeSnapshot,
    expectedScope?: string,
  ): Promise<void> {
    const recordPolicy = await this.recordingPolicy?.current() ?? DEFAULT_RECORDING_POLICY;
    const snapshot = configurationSnapshot ?? (await this.settings?.snapshot());
    const limits = memoryLimitsForContextWindow(
      Number.isFinite(this.llm.contextWindowTokens)
        ? this.llm.contextWindowTokens
        : 32_000,
    );
    // Summary behavior is owned by code and cannot change through Prompt management.
    const summaryPrompt = DEFAULT_SUMMARY_INSTRUCTIONS;
    const conversation = await this.database.query<{
      summaryThroughMessageId: number | null;
      agentMemoryScope?: string;
    }>(
      'SELECT summary_through_message_id::int AS "summaryThroughMessageId",agent_memory_scope AS "agentMemoryScope" FROM conversations WHERE id = $1',
      [conversationId],
    );
    if (
      !conversation.rows[0] ||
      (expectedScope && conversation.rows[0].agentMemoryScope !== expectedScope)
    )
      return;
    const afterId = conversation.rows[0].summaryThroughMessageId ?? 0;
    const messages = await this.database.query<MessageRow>(
      `SELECT id::int, role, content, refused, citations, tool_steps AS "toolSteps", progress_events AS "progressEvents", created_at AS "createdAt"
       FROM conversation_messages WHERE conversation_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
      [conversationId, afterId, limits.summaryBatchMaxMessages],
    );
    if (messages.rows.length < limits.summaryTriggerMessages) return;
    const toSummarize = messages.rows.slice(0, -limits.summaryKeepMessages);
    const contextSnapshot = {
      previousSummary: oldSummary,
      messages: toSummarize.map(({ role, content }) => ({ role, content })),
      agentConfigurationRevision: snapshot?.revision,
      agentConfigurationVersion: snapshot?.configurationVersion,
    };
    const summaryUserPrompt = JSON.stringify(contextSnapshot);
    const contextBudget = this.contextGovernor?.inspect({
      systemPrompt: summaryPrompt,
      userPrompt: summaryUserPrompt,
      purpose: "summary",
      rawMessageCount: toSummarize.length + 1,
      includedMessageCount: toSummarize.length + 1,
    });
    const started = Date.now();
    const summaryTraceId = randomUUID();
    let phoenix: ReturnType<ExecutionTracingService["link"]> | undefined;
    const operation = async () => {
      try {
        const result = await this.llm.completeDetailed(
          summaryPrompt,
          summaryUserPrompt,
          this.llm.model,
          "summary",
        );
        const traceContext = {
          ...contextSnapshot,
          ...(phoenix ? { phoenix } : {}),
          ...(contextBudget ? { contextBudget } : {}),
          ...(promptSnapshot && this.promptRuntime
            ? { promptVersions: this.promptRuntime.metadata(promptSnapshot) }
            : {}),
          modelCalls: [
            {
              id: "summary-1",
              purpose: "summary" as const,
              model: result.model,
              request: {
                messages: [
                  { role: "system", content: summaryPrompt },
                  { role: "user", content: JSON.stringify(contextSnapshot) },
                ],
                temperature: 0.1,
                maxTokens: 800,
              },
              response: {
                content: result.content,
                finishReason: result.finishReason,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                totalTokens: result.totalTokens,
              },
              durationMs: Date.now() - started,
              attempts: result.attempts,
            },
          ],
          promptVersion: "conversation-summary-v1",
        };
        await this.database.transaction(async (client) => {
          const update = await client.query(
            `UPDATE conversations SET summary = $2, summary_through_message_id = $3
           WHERE id = $1 AND coalesce(summary_through_message_id, 0) = $4 AND ($5::text IS NULL OR agent_memory_scope=$5)`,
            [
              conversationId,
              result.content.slice(0, limits.summaryMaxChars),
              toSummarize.at(-1)!.id,
              afterId,
              expectedScope ?? null,
            ],
          );
          if (!update.rowCount) return;
          if (recordPolicy.traceEnabled) await client.query(
            `INSERT INTO chat_traces
            (id, kind, conversation_id, question, context_snapshot, model, raw_model_output,
             final_answer, status, input_tokens, output_tokens, total_tokens, duration_ms)
           VALUES ($1, 'summary', $2, '（会话摘要）', $3::jsonb, $4, $5, $6, 'completed', $7, $8, $9, $10)`,
            [
              summaryTraceId,
              conversationId,
              JSON.stringify(recordPolicy.conversationContentEnabled ? traceContext : safeTraceMetadata(traceContext as any)),
              result.model,
              recordPolicy.conversationContentEnabled ? result.content : null,
              recordPolicy.conversationContentEnabled ? result.content.slice(0, limits.summaryMaxChars) : null,
              recordPolicy.usageEnabled ? result.inputTokens : null,
              recordPolicy.usageEnabled ? result.outputTokens : null,
              recordPolicy.usageEnabled ? result.totalTokens : null,
              Date.now() - started,
            ],
          );
        });
      } catch (error) {
        annotateExecution({ status: "failed", errorCode: "summary_failed" });
        if (recordPolicy.traceEnabled) await this.database
          .query(
            `INSERT INTO chat_traces
          (id, kind, conversation_id, question, context_snapshot, model, status, error_code,
           input_tokens, output_tokens, total_tokens, duration_ms)
         VALUES ($1, 'summary', $2, '（会话摘要）', $3::jsonb, $4, 'failed', 'summary_failed', $5, $6, $7, $8)`,
            [
              summaryTraceId,
              conversationId,
              JSON.stringify(recordPolicy.conversationContentEnabled ? {
                ...contextSnapshot,
                ...(phoenix ? { phoenix } : {}),
                ...(promptSnapshot && this.promptRuntime
                  ? {
                      promptVersions:
                        this.promptRuntime.metadata(promptSnapshot),
                    }
                  : {}),
              } : safeTraceMetadata(contextSnapshot as any)),
              this.llm.model,
              recordPolicy.usageEnabled && error instanceof ModelFailure ? error.usage.inputTokens : null,
              recordPolicy.usageEnabled && error instanceof ModelFailure ? error.usage.outputTokens : null,
              recordPolicy.usageEnabled && error instanceof ModelFailure ? error.usage.totalTokens : null,
              Date.now() - started,
            ],
          )
          .catch(() => this.logger.warn("Failed to persist summary trace"));
        throw error;
      }
    };
    if (this.tracing)
      return this.tracing.span(
        "conversation_summary",
        "chain",
        {
          conversationId,
          localTraceId: summaryTraceId,
          purpose: "summary",
          promptVersionId: null,
          codePromptVersion: createHash("sha256")
            .update(summaryPrompt)
            .digest("hex"),
        },
        async (span) => {
          phoenix = this.tracing!.link(span);
          await operation();
        },
      );
    return operation();
  }
}
