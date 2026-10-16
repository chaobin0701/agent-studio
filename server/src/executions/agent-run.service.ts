import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  preflightOutput,
  outputFailureIssues,
} from "../ai/agent/output-contract";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database.service";
import { AgentManagementService } from "../agent-management/agent-management.service";
import {
  compositionMetadata,
  agentMemoryScope,
  type CompositionSnapshot,
} from "../agent-management/runtime-scope";
import { AgentExecutionService } from "../ai/runtime/agent-execution.service";
import type { PlatformAgentCallbacks } from "../ai/runtime/platform-input";
import type { SearchHit } from "../documents/fuse-search-results";
import { IntegrationService } from "../integrations/integration.service";
import type {
  IntegrationIdentity,
  IntegrationApp,
} from "../integrations/integration.types";
import { credentialHash } from "../integrations/integration.service";
import { currentWorkspaceId } from "../workspaces/workspace-context";
import { publicIntegrationError } from "../integrations/quota-error";
import { withModelCallAccounting } from "../chat/model-call-accounting";
import { ExecutionTracingService } from "../observability/tracing.module";
import { annotateExecution } from "../observability/execution-tracer";
import { ExecutionArtifactService } from "../artifacts/execution-artifact.service";
import type { PendingFileOutput } from "../artifacts/file-output";
import {
  pinnedTaskInput,
  runFingerprint,
  type PublicRunResult,
  type RunRequest,
} from "./run-request";

type RunIdentity =
  | { app: IntegrationApp; adminActorId?: never }
  | { app: null; adminActorId: number };
export type ChatbotExecutionPrincipal =
  | { adminId: number }
  | { identity: IntegrationIdentity; owner: string };
export type PreparedRun = {
  identity: RunIdentity;
  entryPoint?: "agent_preview" | "chatbot";
  input: RunRequest;
  composition: CompositionSnapshot;
  admission: Awaited<ReturnType<IntegrationService["admitRun"]>>;
  /** Trusted conversational inputs; deliberately excluded from task/Trace state. */
  chatContext?: Pick<
    Parameters<AgentExecutionService["runTask"]>[2],
    "contextFiles" | "validateContextFile" | "images"
  >;
};

/** Admission/persistence edge. No conversations, planner loop or recursive child runner. */
@Injectable()
export class AgentRunService {
  private readonly logger = new Logger(AgentRunService.name);
  constructor(
    private readonly database: DatabaseService,
    private readonly management: AgentManagementService,
    private readonly execution: AgentExecutionService,
    private readonly access: IntegrationService,
    private readonly tracing: ExecutionTracingService,
    @Optional() private readonly artifacts?: ExecutionArtifactService,
  ) {}

  assertAgent(identity: IntegrationIdentity, agentId: number) {
    if (identity.kind !== "api" || identity.app.agentId !== agentId)
      throw new ForbiddenException("此平台接入应用没有调用该 Agent 的权限");
  }

  async prepare(
    identity: IntegrationIdentity,
    agentId: number,
    input: RunRequest,
    key?: string,
  ): Promise<PreparedRun> {
    this.assertAgent(identity, agentId);
    this.access.assertScope(identity, "chat:write");
    const owner = await this.access.platformOwner(identity, input.userId);
    const composition = await this.management.snapshot(agentId);
    const entry = composition.agents.get(composition.entryVersionId)!;
    await this.attachments(input, composition); // Reject unavailable references before SSE headers/admission.
    const admission = await this.access.admitRun<PublicRunResult>(
      identity,
      owner,
      runFingerprint(agentId, input),
      key,
      undefined,
      () =>
        preflightOutput(
          entry.spec.output,
          entry.version.id,
          input.outputSchema,
        ),
    );
    return { identity, input, composition, admission };
  }

  /** Trusted administrative admission only; actual execution below is shared
   * with the formal API, including members, artifacts and ledger persistence. */
  async prepareAdministrative(
    app: IntegrationApp,
    actor: number,
    input: RunRequest,
    composition: CompositionSnapshot,
    key: string,
  ): Promise<PreparedRun> {
    if (
      app.agentId !== composition.agentId ||
      composition.workspaceId !== currentWorkspaceId()
    )
      throw new ForbiddenException("测试上下文与应用或工作区不一致");
    const entry = composition.agents.get(composition.entryVersionId)!;
    preflightOutput(entry.spec.output, entry.version.id, input.outputSchema);
    await this.attachments(input, composition);
    const fingerprint = credentialHash(
      JSON.stringify([
        "agent-preview-v1",
        runFingerprint(composition.agentId, input),
        agentMemoryScope(composition),
      ]),
    );
    const admission = await this.access.admitManagedExecution<PublicRunResult>(
      app.id,
      actor,
      composition.agentId,
      fingerprint,
      key,
      "agent_preview",
    );
    return {
      identity: { app },
      input,
      composition,
      admission,
      entryPoint: "agent_preview",
    };
  }

  /** Conversational persistence is owned by the Chatbot edge. Execution stays here. */
  async prepareChatbot(
    principal: ChatbotExecutionPrincipal,
    input: RunRequest,
    composition: CompositionSnapshot,
    key: string,
    transaction: PoolClient,
  ): Promise<PreparedRun> {
    if (
      composition.workspaceId !== currentWorkspaceId() ||
      composition.previewDraft
    )
      throw new ForbiddenException("对话只能使用当前工作区已发布的 Agent");
    const entry = composition.agents.get(composition.entryVersionId)!;
    preflightOutput(entry.spec.output, entry.version.id, input.outputSchema);
    await this.attachments(input, composition);
    const fingerprint = credentialHash(
      JSON.stringify([
        "chatbot-run-v1",
        runFingerprint(composition.agentId, input),
        agentMemoryScope(composition),
      ]),
    );
    if ("adminId" in principal) {
      const admission = await this.access.admitAdministrator<PublicRunResult>(
        principal.adminId,
        composition.agentId,
        composition.entryVersionId,
        fingerprint,
        key,
        transaction,
      );
      return {
        identity: { app: null, adminActorId: principal.adminId },
        input,
        composition,
        admission,
        entryPoint: "chatbot",
      };
    }
    if (principal.identity.app.agentId !== composition.agentId)
      throw new ForbiddenException("此应用没有调用该 Agent 的权限");
    this.access.assertScope(principal.identity, "chat:write");
    const admission = await this.access.admitRun<PublicRunResult>(
      principal.identity,
      principal.owner,
      fingerprint,
      key,
      transaction,
    );
    return {
      identity: { app: principal.identity.app },
      input,
      composition,
      admission,
      entryPoint: "chatbot",
    };
  }

  async execute(
    prepared: PreparedRun,
    signal?: AbortSignal,
    callbacks: PlatformAgentCallbacks = {},
  ): Promise<PublicRunResult> {
    if (prepared.admission.cached)
      return this.publicResult(prepared.admission.cached as PublicRunResult);
    const { identity, input, composition, admission } = prepared;
    const runId = admission.callId,
      traceId = randomUUID(),
      started = Date.now();
    const task = pinnedTaskInput(composition, input, runId, traceId);
    if (prepared.chatContext)
      task.versions.conversationAttachmentIds = [
        ...(prepared.chatContext.contextFiles ?? []).map(
          (f) => f.reference!.id,
        ),
        ...(prepared.chatContext.images ?? []).map((image) => image.id),
      ];
    let phase = "execution";
    let snapshot: Record<string, unknown> = {
      entryPoint: prepared.entryPoint ?? "generic_run",
      executionInput: task,
      agentComposition: compositionMetadata(composition),
    };
    try {
      const assigned = await this.database.query(
        "UPDATE integration_calls SET trace_id=$2 WHERE id=$1 AND status='running' AND expires_at>now() RETURNING id",
        [runId, traceId],
      );
      if (!assigned.rowCount)
        throw new ConflictException("当前执行已结束，请使用新的请求 ID");
      return await this.tracing.span(
        "agent_request",
        "chain",
        task.versions,
        async (span) => {
          const parentLink = this.tracing.link(span);
          snapshot.phoenix = parentLink;
          try {
            signal?.throwIfAborted();
            const evidence = await this.attachments(input, composition);
            const result = await withModelCallAccounting(
              this.access.tokens.accounting(
                identity.app?.id ?? null,
                admission.callId,
              ),
              () =>
                this.execution.runTask(
                  composition,
                  task,
                  {
                    runId,
                    traceId,
                    signal,
                    evidence,
                    ...prepared.chatContext,
                    validateDocument: async (reference, currentSignal) => {
                      currentSignal.throwIfAborted();
                      await this.attachments(
                        {
                          ...input,
                          attachments: [{ kind: "document", id: reference.id }],
                        },
                        composition,
                      );
                      currentSignal.throwIfAborted();
                    },
                  },
                  {
                    ...callbacks,
                    onContext: (value) => {
                      snapshot = value;
                      value.phoenix ??= parentLink;
                      value.entryPoint = prepared.entryPoint ?? "generic_run";
                      value.executionInput = task;
                      callbacks.onContext?.(value);
                    },
                  },
                ),
            );
            signal?.throwIfAborted();
            if (!result.output)
              throw new Error(
                "Generic execution did not produce a final output",
              );
            const { usage: _graphUsage, ...output } = result.output;
            const response: PublicRunResult = {
              ...output,
              runId,
              traceId,
              agentId: composition.agentId,
              agentVersionId: composition.entryVersionId,
            };
            phase = "persistence";
            await this.persist(
              identity,
              traceId,
              task.task ?? task.messages.at(-1)!.content,
              result.contextSnapshot,
              "completed",
              started,
              response,
              result.rawModelOutput,
              undefined,
              result.fileOutputs,
              signal,
            );
            phase = "accounting";
            return (await this.access.finish(admission.callId, response))!;
          } catch (error) {
            annotateExecution({
              status: "failed",
              errorCode: this.errorCode(error, signal),
            });
            throw error;
          }
        },
      );
    } catch (error) {
      const normalized = publicIntegrationError(error);
      const code = this.errorCode(error, signal);
      await this.persist(
        identity,
        traceId,
        task.task ?? task.messages.at(-1)!.content,
        {
          ...snapshot,
          errorSummary: {
            ...(snapshot.errorSummary as Record<string, unknown> | undefined),
            phase,
            errorCode: code,
            outputIssues: outputFailureIssues(error),
          },
        },
        "failed",
        started,
        undefined,
        undefined,
        code,
      ).catch(() =>
        this.logger.warn("Failed to persist generic execution trace"),
      );
      await this.artifacts
        ?.discardFailed(traceId)
        .catch(() =>
          this.logger.warn("Failed to retract execution file outputs"),
        );
      await this.access.finish(admission.callId, null);
      throw new HttpException({ ...normalized, code }, normalized.status);
    }
  }

  async cancelAdmission(prepared: PreparedRun) {
    if (prepared.admission.callId)
      await this.access.finish(prepared.admission.callId, null);
  }

  private errorCode(error: unknown, signal?: AbortSignal): string {
    if (signal?.aborted) return "run_cancelled";
    const raw =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    if (
      typeof raw === "string" &&
      [
        "output_validation_failed",
        "output_schema_invalid",
        "output_contract_conflict",
        "agent_budget_exceeded",
        "agent_timeout",
        "run_cancelled",
        "model_protocol_error",
        "model_output_truncated",
        "model_content_filtered",
        "collaboration_failed",
        "artifact_outputs_disabled",
        "artifact_output_invalid",
        "artifact_limit_exceeded",
      ].includes(raw)
    )
      return raw;
    return publicIntegrationError(error).code ?? "execution_failed";
  }

  async get(
    identity: IntegrationIdentity,
    agentId: number,
    runId: string,
    userId?: string,
  ) {
    this.assertAgent(identity, agentId);
    this.access.assertScope(identity, "conversations:read");
    this.access.checkInspectionRate(identity);
    const owner = await this.access.platformOwner(identity, userId);
    const row = (
      await this.database.query<{
        runId: string;
        traceId: string | null;
        status: string;
        response: PublicRunResult | null;
        errorCode: string | null;
      }>(
        `SELECT c.run_id AS "runId",c.trace_id AS "traceId",CASE WHEN c.status='running' AND c.expires_at<=now() THEN 'expired' ELSE c.status END AS status,c.response,t.error_code AS "errorCode"
       FROM integration_calls c LEFT JOIN chat_traces t ON t.id=c.trace_id WHERE c.app_id=$1 AND c.visitor_session_id=$2 AND c.run_id=$3 AND c.conversation_id IS NULL`,
        [identity.app.id, owner, runId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("执行记录不存在");
    return row.response
      ? this.publicResult(row.response)
      : {
          runId: row.runId,
          traceId: row.traceId,
          status: row.status,
          ...(row.errorCode ? { errorCode: row.errorCode } : {}),
        };
  }

  publicResult(value: PublicRunResult): PublicRunResult {
    const {
      runId,
      traceId,
      agentId,
      agentVersionId,
      status,
      answer,
      structured,
      artifacts,
      references,
      usage,
    } = value;
    return {
      runId,
      traceId,
      agentId,
      agentVersionId,
      status,
      answer,
      artifacts,
      references,
      ...(structured !== undefined ? { structured } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  private async persist(
    identity: RunIdentity,
    traceId: string,
    question: string,
    context: Record<string, unknown>,
    status: "completed" | "failed",
    started: number,
    result?: PublicRunResult,
    rawModelOutput?: string | null,
    code?: string,
    files: readonly PendingFileOutput[] = [],
    signal?: AbortSignal,
  ) {
    const localRunId = (
      context.executionInput as
        | { versions?: { localRunId?: string } }
        | undefined
    )?.versions?.localRunId;
    const usage = localRunId
      ? await this.access.tokens.callUsage(localRunId)
      : undefined;
    if (
      result?.artifacts.some((file) => file.kind === "execution_file") ||
      files.length
    ) {
      if (!this.artifacts) throw new ConflictException("文件产物存储不可用");
      this.artifacts.assertSelection(result?.artifacts ?? [], files);
    }
    const write = (client: Pick<DatabaseService, "query">) =>
      client.query(
        `INSERT INTO chat_traces(id,application_id,question,context_snapshot,status,final_answer,refused,raw_model_output,error_code,duration_ms,input_tokens,output_tokens,total_tokens)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,error_code=EXCLUDED.error_code,context_snapshot=EXCLUDED.context_snapshot,duration_ms=EXCLUDED.duration_ms
      WHERE chat_traces.application_id IS NOT DISTINCT FROM EXCLUDED.application_id`,
        [
          traceId,
          identity.app?.id ?? null,
          question,
          JSON.stringify(context),
          status,
          result?.answer ?? null,
          result?.status === "refused",
          rawModelOutput ?? null,
          code ?? null,
          Date.now() - started,
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          usage?.totalTokens ?? null,
        ],
      );
    if (!files.length) {
      await write(this.database);
      return;
    }
    signal?.throwIfAborted();
    await this.database.transaction(async (client) => {
      const call = (
        await client.query<{
          owner: string | null;
          adminActorId: number | null;
        }>(
          "SELECT visitor_session_id AS owner,admin_actor_id::int AS \"adminActorId\" FROM integration_calls WHERE id=$1 AND app_id IS NOT DISTINCT FROM $2::uuid AND status='running' AND expires_at>now() FOR UPDATE",
          [localRunId, identity.app?.id ?? null],
        )
      ).rows[0];
      if (!call) throw new ConflictException("执行已过期，不能保存文件产物");
      await write(client);
      await this.artifacts!.save(
        client,
        {
          source: "generic_run",
          traceId,
          runId: localRunId!,
          entryVersionId: result!.agentVersionId,
          applicationId: identity.app?.id ?? null,
          visitorSessionId: call.owner,
          ...(identity.adminActorId
            ? { adminActorId: identity.adminActorId }
            : {}),
        },
        files,
        result!.artifacts,
      );
      signal?.throwIfAborted();
    });
  }

  /** Attachments are authorized knowledge-document references, never arbitrary URLs/files/body injection.
   * Read only the pinned index (or explicit legacy live scope), with current document visibility. */
  private async attachments(
    input: RunRequest,
    composition: CompositionSnapshot,
  ): Promise<SearchHit[]> {
    if (!input.attachments.length) return [];
    const entry = composition.agents.get(composition.entryVersionId)!;
    const versionIds = entry.knowledge.flatMap((k) =>
      k.indexVersionId === null ? [] : [k.indexVersionId],
    );
    const liveIds = entry.knowledge
      .filter((k) => k.indexVersionId === null)
      .map((k) => k.id);
    const ids = [...new Set(input.attachments.map((a) => Number(a.id)))];
    const limit = Math.max(
      1,
      Math.floor(entry.spec.retrieval.contextChars / ids.length),
    );
    const hits = (
      await this.database.query<SearchHit>(
        `SELECT d.id::int AS "documentId",kb.id::int AS "knowledgeBaseId",c.* FROM documents d
      JOIN knowledge_bases kb ON kb.id=d.knowledge_base_id
      JOIN LATERAL (
        SELECT c.id::int AS "chunkId",c.document_title AS "documentTitle",c.original_filename AS "originalFilename",c.ordinal,c.heading_path AS "headingPath",c.content,
          (c.source_locator->>'start')::int AS "sourceStartLine",(c.source_locator->>'end')::int AS "sourceEndLine",0::float AS score,'published' AS "indexKind",c.version_id::int AS "indexVersionId"
        FROM index_chunks c JOIN knowledge_index_versions v ON v.id=c.version_id AND v.status='ready' AND v.knowledge_base_id=kb.id
        WHERE c.document_id=d.id AND c.version_id=ANY($2::bigint[]) AND c.kind<>'parent'
        UNION ALL
        SELECT c.id::int,d.title,d.original_filename,c.ordinal,c.heading_path,c.content,c.source_start_line,c.source_end_line,0::float,'live',NULL::int
        FROM document_chunks c WHERE c.document_id=d.id AND kb.id=ANY($3::bigint[]) AND kb.active_index_version_id IS NULL AND d.status='ready' AND d.source_type='file'
        ORDER BY ordinal LIMIT 24
      ) c ON true
      WHERE d.id=ANY($1::bigint[]) AND d.archived_at IS NULL AND d.deleted_at IS NULL AND d.enabled_for_retrieval AND kb.archived_at IS NULL AND kb.enabled_for_chat`,
        [ids, versionIds, liveIds],
      )
    ).rows;
    if (
      ids.some(
        (id) =>
          !hits.some(
            (hit) =>
              hit.documentId === id &&
              entry.knowledge.some(
                (k) =>
                  k.id === hit.knowledgeBaseId &&
                  k.indexVersionId === (hit.indexVersionId ?? null),
              ),
          ),
      )
    )
      throw new NotFoundException(
        "附件文档未授权、不可用或未包含在当前索引版本",
      );
    return ids.flatMap((id) => {
      let remaining = limit;
      return hits
        .filter((hit) => hit.documentId === id)
        .sort((a, b) => a.ordinal - b.ordinal)
        .flatMap((hit) => {
          if (remaining <= 0) return [];
          const chars = Array.from(hit.content),
            selected = chars.slice(0, remaining);
          remaining -= selected.length;
          return [
            {
              ...hit,
              content: selected.join(""),
              ...(selected.length < chars.length
                ? { contentTruncated: true }
                : {}),
            },
          ];
        });
    });
  }
}
