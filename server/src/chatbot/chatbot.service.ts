import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { DatabaseService } from "../database.service";
import { AgentManagementService } from "../agent-management/agent-management.service";
import {
  AgentRunService,
  type PreparedRun,
} from "../executions/agent-run.service";
import { parseRunRequest } from "../executions/run-request";
import {
  IntegrationService,
  credentialHash,
} from "../integrations/integration.service";
import { publicIntegrationError } from "../integrations/quota-error";
import { workspaceAccess } from "../workspaces/workspace-access";
import { currentWorkspaceId } from "../workspaces/workspace-context";
import { SecurityRateLimitService } from "../security/security-rate-limit.service";
import { ExecutionArtifactService } from "../artifacts/execution-artifact.service";
import {
  ChatbotAttachmentService,
  supportsConversationImages,
} from "./chatbot-attachment.service";
import type {
  ChatbotEvent,
  ChatbotPrincipal,
  ChatbotTurn,
} from "./chatbot.types";
import { InteractionService } from "../interactions/interaction.service";
import { InteractionWaiting, type PublicInteraction } from "../interactions/contracts";
import { lifecycleWriteLock } from "../agent-management/resource-lifecycle";

const sendSchema = z
  .object({
    requestId: z.string().uuid(),
    message: z.string().trim().max(2000),
    stream: z.boolean().default(true),
    attachmentIds: z.array(z.string().uuid()).max(5).default([]),
  })
  .strict()
  .refine(
    (input) => input.message.length > 0 || input.attachmentIds.length > 0,
  );
const turnColumns = `t.id,t.session_id AS "sessionId",t.request_id AS "requestId",t.request_fingerprint AS "requestFingerprint",t.question,t.partial_answer AS "partialAnswer",t.progress,
 CASE WHEN c.status='completed' THEN 'completed' WHEN t.status='cancelled' THEN 'cancelled' WHEN c.status='expired' OR (c.status IN ('running','waiting') AND c.expires_at<=now()) THEN 'expired' WHEN c.status='failed' THEN 'failed' WHEN c.status='waiting' THEN 'waiting' ELSE t.status END AS status,
 COALESCE(t.response,c.response) AS response,t.error_code AS "errorCode",t.error_message AS "errorMessage",t.agent_version_id::int AS "agentVersionId",v.version AS "agentVersion",c.trace_id AS "traceId",t.created_at AS "createdAt",t.finished_at AS "finishedAt"`;
const principalWhere = `s.admin_actor_id IS NOT DISTINCT FROM $2::bigint AND s.application_id IS NOT DISTINCT FROM $3::uuid AND s.visitor_session_id IS NOT DISTINCT FROM $4::uuid`;
type Active = {
  abort: AbortController;
  listeners: Set<(value: ChatbotEvent) => void>;
  answer: string;
  progress: unknown[];
  queue: Promise<unknown>;
  done?: Promise<void>;
  flush?: ReturnType<typeof setTimeout>;
};

/** Session, ownership and transport orchestration only. AgentRunService remains the sole Run host. */
@Injectable()
export class ChatbotService implements OnApplicationShutdown {
  private readonly logger = new Logger(ChatbotService.name);
  private readonly active = new Map<string, Active>();
  constructor(
    private readonly db: DatabaseService,
    private readonly management: AgentManagementService,
    private readonly runs: AgentRunService,
    private readonly access: IntegrationService,
    private readonly limiter: SecurityRateLimitService,
    private readonly artifacts: ExecutionArtifactService,
    private readonly attachments: ChatbotAttachmentService,
    @Optional() private readonly interactions?: InteractionService,
  ) {}
  private principal(p: ChatbotPrincipal) {
    return "adminId" in p
      ? [p.adminId, null, null]
      : [null, p.identity.app.id, p.owner];
  }
  private async authorize(p: ChatbotPrincipal) {
    if ("adminId" in p) {
      const codes = (
        await workspaceAccess(this.db, p.adminId, currentWorkspaceId())
      ).permissionCodes;
      if (!codes.includes("agent_chat.use"))
        throw new ForbiddenException("需要 Agent 对话使用权限");
    } else {
      const app = await this.access.app(p.identity.app.id);
      if (
        !app.enabled ||
        !app.websiteEnabled ||
        app.authVersion !== p.identity.app.authVersion ||
        !app.scopes.includes("chat:write")
      )
        throw new ForbiddenException("网站授权已更新或停用，请重新进入对话");
    }
  }
  async options(p: ChatbotPrincipal) {
    await this.authorize(p);
    const agents = (
      await this.db.query(
        `SELECT r.id::int,r.name,v.id::int AS "versionId",v.version,
          m.id::int AS "modelPlanVersionId",m.plan_id::int AS "modelPlanId",
          COALESCE(cap.snapshot_images,false) AS "supportsImages",
          COALESCE(NOT cap.snapshot_images AND cap.deployment_images,false) AS "imageConfigOutdated",
          CASE WHEN cap.snapshot_images THEN NULL
            WHEN cap.deployment_images THEN '部署已开启图片，但 Agent 仍引用旧方案。请同步并发布模型方案，再更新并发布 Agent。'
            ELSE '当前已发布模型方案未开启图片输入；主模型和备用模型都需支持图片。' END AS "imageInputReason"
        FROM agent_resources r
        JOIN agent_resource_versions v ON v.id=r.current_version_id AND v.resource_id=r.id AND v.status='published'
        LEFT JOIN model_plan_versions m ON m.id=(v.config->>'modelPlanVersionId')::bigint AND m.status='published'
        LEFT JOIN LATERAL (
          SELECT count(*)>0 AND bool_and(d->'config'->>'supportsImageInput' IS NOT DISTINCT FROM 'true') AS snapshot_images,
            count(*)>0 AND bool_and(COALESCE(md.enabled AND md.config->>'supportsImageInput'='true',false)) AS deployment_images
          FROM jsonb_array_elements(m.config->'deployments') d
          LEFT JOIN model_deployments md ON md.id=(d->>'id')::bigint
        ) cap ON true
        WHERE r.kind='agent' AND r.enabled AND r.deleted_at IS NULL AND r.archived_at IS NULL
          AND ($1::bigint IS NULL OR r.id=$1) ORDER BY r.name,r.id`,
        ["adminId" in p ? null : p.identity.app.agentId],
      )
    ).rows;
    return {
      agents,
      canDelete:
        "adminId" in p || p.identity.scopes.includes("conversations:delete"),
      canRename: true,
    };
  }
  async list(p: ChatbotPrincipal, query = "") {
    await this.authorize(p);
    if (query.length > 200) throw new BadRequestException("搜索词过长");
    return (
      await this.db.query(
        `SELECT s.id,s.title,s.agent_id::int AS "agentId",r.name AS "agentName",s.updated_at AS "updatedAt" FROM chatbot_sessions s JOIN agent_resources r ON r.id=s.agent_id WHERE s.deleted_at IS NULL AND ${principalWhere} AND ($1='' OR s.title ILIKE '%'||$1||'%') ORDER BY s.updated_at DESC,s.id LIMIT 100`,
        [query, ...this.principal(p)],
      )
    ).rows;
  }
  private async session(
    p: ChatbotPrincipal,
    id: string,
    c: Pick<DatabaseService, "query"> = this.db,
    lock = false,
  ) {
    await this.authorize(p);
    const row = (
      await c.query(
        `SELECT s.id,s.title,s.agent_id::int AS "agentId",r.name AS "agentName",r.enabled AND r.deleted_at IS NULL AND r.archived_at IS NULL AS "agentEnabled",r.current_version_id::int AS "currentVersionId",s.created_at AS "createdAt",s.updated_at AS "updatedAt" FROM chatbot_sessions s JOIN agent_resources r ON r.id=s.agent_id WHERE s.id=$1 AND s.deleted_at IS NULL AND ${principalWhere}${lock ? " FOR UPDATE OF s" : ""}`,
        [id, ...this.principal(p)],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("会话不存在或已删除");
    return row;
  }
  async create(p: ChatbotPrincipal, value: unknown) {
    const input = z
      .object({ agentId: z.number().int().positive() })
      .strict()
      .safeParse(value);
    if (!input.success) throw new BadRequestException("请选择 Agent");
    const options = await this.options(p);
    if (!options.agents.some((a) => a.id === input.data.agentId))
      throw new ForbiddenException("请选择当前授权范围内已发布的 Agent");
    const id = randomUUID();
    await this.db.transaction(async (c) => {
      await c.query(
        "INSERT INTO chatbot_sessions(id,agent_id,admin_actor_id,application_id,visitor_session_id) VALUES($1,$2,$3,$4,$5)",
        [id, input.data.agentId, ...this.principal(p)],
      );
      await this.audit(c, p, "created", id);
    });
    return this.session(p, id);
  }
  async rename(p: ChatbotPrincipal, id: string, value: unknown) {
    const input = z
      .object({ title: z.string().trim().min(1).max(160) })
      .strict()
      .safeParse(value);
    if (!input.success) throw new BadRequestException("请填写会话名称");
    return this.db.transaction(async (c) => {
      await this.session(p, id, c, true);
      await c.query(
        "UPDATE chatbot_sessions SET title=$2,title_is_default=false,updated_at=now() WHERE id=$1",
        [id, input.data.title],
      );
      await this.audit(c, p, "renamed", id);
      return { ok: true };
    });
  }
  async remove(p: ChatbotPrincipal, id: string) {
    if (!("adminId" in p))
      this.access.assertScope(p.identity, "conversations:delete");
    const runIds = await this.db.transaction(async (c) => {
      await this.session(p, id, c, true);
      const running = await c.query<{ id: string }>(
        "UPDATE chatbot_turns SET cancel_requested_at=now() WHERE session_id=$1 AND status IN ('running','waiting') RETURNING id",
        [id],
      );
      await c.query(
        "UPDATE chatbot_sessions SET deleted_at=now(),updated_at=now() WHERE id=$1",
        [id],
      );
      await this.audit(c, p, "deleted", id);
      return running.rows.map((r) => r.id);
    });
    for (const runId of runIds) {
      this.active.get(runId)?.abort.abort(new Error("Conversation deleted"));
      if(!this.active.has(runId)) { await this.interactions?.cancel(runId);await this.access.finish(runId,null); }
    }
    return { ok: true };
  }
  async detail(p: ChatbotPrincipal, id: string) {
    const session = await this.session(p, id);
    const turns = (
      await this.db.query<ChatbotTurn>(
        `SELECT * FROM (SELECT ${turnColumns} FROM chatbot_turns t JOIN integration_calls c ON c.id=t.id JOIN agent_resource_versions v ON v.id=t.agent_version_id WHERE t.session_id=$1 ORDER BY t.created_at DESC,t.id DESC LIMIT 150) recent ORDER BY "createdAt",id`,
        [id],
      )
    ).rows;
    const attachments = await this.attachments.forTurns(id);
    const interactions=await this.interactions?.listMany(turns.map(t=>t.id));
    return {
      session,
      messages: turns
        .flatMap((t) => this.messages(t,interactions?.get(t.id)??[]))
        .map((message) => ({
          ...message,
          attachments:
            message.role === "user"
              ? attachments.filter((a) => a.turnId === message.runId)
              : [],
        })),
      attachments: await this.attachments.list(id),
      activeRunId: turns.find((t) => t.status === "running" || t.status === "waiting")?.id ?? null,
    };
  }
  private messages(t: ChatbotTurn,interactions:PublicInteraction[]=[]) {
    const response = t.response ? this.runs.publicResult(t.response) : null;
    return [
      {
        id: `${t.id}:user`,
        role: "user",
        content: t.question,
        status: "completed",
        runId: t.id,
        requestId: t.requestId,
        createdAt: t.createdAt,
      },
      {
        id: `${t.id}:assistant`,
        role: "assistant",
        content: response?.answer ?? t.partialAnswer,
        status: t.status,
        runId: t.id,
        requestId: t.requestId,
        traceId: t.traceId,
        agentVersion: t.agentVersion,
        progress: t.progress,
        interactions,
        error:
          t.errorMessage ??
          (t.status === "expired"
            ? "执行已中断，请明确发起新消息重试"
            : t.status === "failed"
              ? "本轮未完成，请明确发起新消息重试"
              : undefined),
        artifacts: response?.artifacts ?? [],
        references: response?.references ?? [],
        ...(response?.structured!==undefined?{structured:response.structured}:{}),
        usage: response?.usage,
        createdAt: t.createdAt,
      },
    ];
  }
  async turn(p: ChatbotPrincipal, sessionId: string, runId: string) {
    await this.session(p, sessionId);
    const row = (
      await this.db.query<ChatbotTurn>(
        `SELECT ${turnColumns} FROM chatbot_turns t JOIN integration_calls c ON c.id=t.id JOIN agent_resource_versions v ON v.id=t.agent_version_id WHERE t.session_id=$1 AND t.id=$2`,
        [sessionId, runId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("消息不存在");
    const { requestFingerprint: _fingerprint, ...visible } = row;
    return {
      ...visible,
      interactions:await this.interactions?.list(runId)??[],
      response: row.response ? this.runs.publicResult(row.response) : null,
    };
  }
  async start(p: ChatbotPrincipal, sessionId: string, value: unknown) {
    const input = sendSchema.safeParse(value);
    if (!input.success)
      throw new BadRequestException("请填写消息和有效请求 ID");
    const fingerprint = credentialHash(
      JSON.stringify([input.data.message, input.data.attachmentIds]),
    );
    const state = await this.db.transaction(async (c) => {
      const session = await this.session(p, sessionId, c, true);
      const old = (
        await c.query<{ id: string; request_fingerprint: string }>(
          "SELECT id,request_fingerprint FROM chatbot_turns WHERE session_id=$1 AND request_id=$2",
          [sessionId, input.data.requestId],
        )
      ).rows[0];
      if (old) {
        if (old.request_fingerprint !== fingerprint)
          throw new ConflictException("此请求 ID 已用于其他消息");
        return { runId: old.id };
      }
      if (!session.agentEnabled || !session.currentVersionId)
        throw new ConflictException("Agent 已停用或尚未发布");
      if (!("adminId" in p) && p.identity.app.agentId !== session.agentId)
        throw new ConflictException("应用已切换 Agent，请新建会话");
      if (
        (
          await c.query(
            "SELECT 1 FROM chatbot_turns t JOIN integration_calls c ON c.id=t.id WHERE t.session_id=$1 AND t.status IN ('running','waiting') AND c.status IN ('running','waiting') AND c.expires_at>now()",
            [sessionId],
          )
        ).rowCount
      )
        throw new ConflictException("当前会话已有正在执行的消息");
      const composition = await this.management.snapshot(session.agentId);
      const previous = (
        await c.query<{ id: string; chars: number }>(
          `SELECT a.id,COALESCE(length(a.parsed_text),0)::int AS chars FROM chatbot_turn_attachments l JOIN chatbot_turns t ON t.id=l.turn_id JOIN integration_calls call ON call.id=t.id JOIN chatbot_attachments a ON a.id=l.attachment_id WHERE t.session_id=$1 AND call.status='completed' AND a.status='ready' AND a.expires_at>now() AND ($2 OR a.kind<>'image') GROUP BY a.id ORDER BY max(t.created_at) DESC LIMIT 5`,
          [sessionId, supportsConversationImages(composition)],
        )
      ).rows;
      const explicit = await this.attachments.resolve(
        sessionId,
        input.data.attachmentIds,
        composition,
        c,
      );
      const attachmentIds = [...new Set(input.data.attachmentIds)];
      let chars = explicit.contextFiles.reduce(
        (n, file) => n + file.content.length,
        0,
      );
      for (const attachment of previous) {
        if (attachmentIds.length >= 5) break;
        if (
          !attachmentIds.includes(attachment.id) &&
          chars + attachment.chars <= 60000
        ) {
          attachmentIds.push(attachment.id);
          chars += attachment.chars;
        }
      }
      const attachmentInput = await this.attachments.resolve(
        sessionId,
        attachmentIds,
        composition,
        c,
      );
      const history = (
        await c.query<{ question: string; answer: string }>(
          `SELECT t.question,c.response->>'answer' AS answer FROM chatbot_turns t JOIN integration_calls c ON c.id=t.id WHERE t.session_id=$1 AND c.status='completed' ORDER BY t.created_at DESC,t.id DESC LIMIT 10`,
          [sessionId],
        )
      ).rows.reverse();
      const task = parseRunRequest({
        task: input.data.message || "请分析附件",
        messages: history
          .flatMap((h) => [
            { role: "user", content: h.question },
            { role: "assistant", content: (h.answer ?? "").slice(0, 2000) },
          ])
          .filter((m) => m.content.trim()),
        stream: true,
      });
      const prepared = await this.runs.prepareChatbot(
        p,
        task,
        composition,
        `chatbot/${sessionId}/${input.data.requestId}`,
        c,
      );
      prepared.chatContext = {
        contextFiles: attachmentInput.contextFiles,
        images: attachmentInput.images,
        validateContextFile: async (file, signal) => {
          signal.throwIfAborted();
          await this.session(p, sessionId);
          await this.attachments.validate(sessionId, file.reference!.id);
        },
      };
      const runId = prepared.admission.callId;
      if (!runId) throw new ConflictException("消息状态已变化，请刷新会话");
      await c.query(
        "INSERT INTO chatbot_turns(id,session_id,request_id,request_fingerprint,agent_version_id,question) VALUES($1,$2,$3,$4,$5,$6)",
        [
          runId,
          sessionId,
          input.data.requestId,
          fingerprint,
          composition.entryVersionId,
          input.data.message || "请分析附件",
        ],
      );
      await this.attachments.link(c, runId, attachmentIds);
      await c.query(
        "UPDATE chatbot_sessions SET title=CASE WHEN title_is_default THEN $2 ELSE title END,title_is_default=false,updated_at=now() WHERE id=$1",
        [sessionId, (input.data.message || "附件分析").slice(0, 80)],
      );
      return { runId, prepared };
    });
    if (state.prepared) this.launch(p, sessionId, state.runId, state.prepared);
    return {
      runId: state.runId,
      stream: input.data.stream,
      replayed: !state.prepared,
    };
  }
  private launch(
    principal: ChatbotPrincipal,
    sessionId: string,
    runId: string,
    prepared: PreparedRun,
    releaseSlot?: () => void,
  ) {
    const active: Active = {
      abort: new AbortController(),
      listeners: new Set(),
      answer: "",
      progress: [],
      queue: Promise.resolve(),
    };
    this.active.set(runId, active);
    const emit = (event: string, data: unknown) => {
      for (const listener of active.listeners)
        try {
          listener({ event, data });
        } catch {
          /* disconnected subscribers never stop an execution */
        }
    };
    const flush = () => {
      clearTimeout(active.flush);
      active.flush = undefined;
      const answer = active.answer,
        progress = JSON.stringify(active.progress);
      active.queue = active.queue
        .then(() =>
          this.db.query(
            "UPDATE chatbot_turns SET partial_answer=$2,progress=$3::jsonb WHERE id=$1 AND status='running'",
            [runId, answer, progress],
          ),
        )
        .catch(() =>
          this.logger.warn("Could not checkpoint public chat message"),
        );
      return active.queue;
    };
    const schedule = () => {
      active.flush ??= setTimeout(() => void flush(), 300);
      active.flush.unref();
    };
    let checking = false;
    const watchCancellation = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.session(principal, sessionId)
        .then(async (session) => {
          const row = (
            await this.db.query<{ cancel: boolean }>(
              "SELECT cancel_requested_at IS NOT NULL OR c.status<>'running' OR c.expires_at<=now() AS cancel FROM chatbot_turns t JOIN integration_calls c ON c.id=t.id WHERE t.id=$1",
              [runId],
            )
          ).rows[0];
          if (!session.agentEnabled || !row || row.cancel)
            active.abort.abort(
              new Error("Execution cancelled or authorization changed"),
            );
        })
        .catch(() =>
          active.abort.abort(
            new Error("Execution ownership could not be checked"),
          ),
        )
        .finally(() => {
          checking = false;
        });
    }, 1000);
    watchCancellation.unref();
    active.done = (async () => {
      let completed:
        | Awaited<ReturnType<AgentRunService["execute"]>>
        | undefined;
      try {
        const execute = () =>
          this.runs.execute(prepared, active.abort.signal, {
            onAnswerDelta: (text) => {
              active.answer = (active.answer + text).slice(0, 200000);
              emit("answer_delta", { text });
              schedule();
            },
            onAnswerReset: (text) => {
              active.answer = text.slice(0, 200000);
              emit("answer_reset", { text });
              schedule();
            },
            onProgress: (progress) => {
              const safe = {
                id: progress.id,
                text: progress.text.slice(0, 1000),
                stage: progress.stage,
                status: progress.status,
              };
              active.progress = [...active.progress, safe].slice(-100);
              emit("progress", safe);
              schedule();
            },
            onRetryStatus: (status) =>
              emit("retry_status", {
                type: "retry_status",
                state: status.state,
                target: status.target,
                stage: status.stage,
                attempt: status.attempt,
                maxAttempts: status.maxAttempts,
                delayMs: status.delayMs,
                errorCode: status.errorCode,
                errorKind: status.errorKind,
                message: status.message,
              }),
            onCommentary: (event) =>
              emit("commentary_completed", {
                id: event.id,
                text: event.text.slice(0, 2000),
              }),
          });
        const response = releaseSlot
          ? await execute()
          : await this.limiter.runConcurrent("chat", execute);
        completed = this.runs.publicResult(response);
        await flush();
        await this.db.query(
          "UPDATE chatbot_turns SET status='completed',response=$2::jsonb,partial_answer=$3,finished_at=now() WHERE id=$1",
          [
            runId,
            JSON.stringify(this.runs.publicResult(response)),
            response.answer.slice(0, 200000),
          ],
        );
        emit("done", this.runs.publicResult(response));
      } catch (error) {
        if(error instanceof InteractionWaiting) {
          await flush();
          await this.db.query("UPDATE chatbot_turns SET status='waiting',finished_at=NULL WHERE id=$1 AND status='running'",[runId]);
          emit("interaction_required",{runId,interaction:error.interaction});
          return;
        }
        // The execution ledger is authoritative. A failed UI checkpoint must
        // never turn completed tools into a retryable failed execution.
        if (completed) {
          this.logger.warn(
            "Completed chat message checkpoint unavailable; ledger retained",
          );
          emit("done", completed);
          return;
        }
        await flush();
        const safe = publicIntegrationError(error),
          cancelled = active.abort.signal.aborted;
        await this.runs
          .cancelAdmission(prepared)
          .catch(() =>
            this.logger.warn("Could not close cancelled chat admission"),
          );
        await this.db
          .query(
            "UPDATE chatbot_turns SET status=$2,error_code=$3,error_message=$4,finished_at=now() WHERE id=$1",
            [
              runId,
              cancelled ? "cancelled" : "failed",
              cancelled ? "run_cancelled" : (safe.code ?? "execution_failed"),
              (cancelled ? "已停止生成" : safe.message).slice(0, 500),
            ],
          )
          .catch(() => this.logger.warn("Could not save failed chat message"));
        emit("error", {
          ...safe,
          code: cancelled ? "run_cancelled" : (safe.code ?? "execution_failed"),
          message: cancelled ? "已停止生成" : safe.message,
        });
      } finally {
        clearInterval(watchCancellation);
        clearTimeout(active.flush);
        this.active.delete(runId);
        releaseSlot?.();
      }
    })().catch(() =>
      this.logger.warn("Chat background execution persistence failed"),
    );
  }
  subscribe(runId: string, listener: (value: ChatbotEvent) => void) {
    const active = this.active.get(runId);
    if (!active) return () => {};
    active.listeners.add(listener);
    if (active.answer)
      listener({ event: "answer_reset", data: { text: active.answer } });
    return () => active.listeners.delete(listener);
  }
  async cancel(p: ChatbotPrincipal, sessionId: string, runId: string) {
    const turn=await this.turn(p, sessionId, runId);
    if(turn.status==="waiting") {
      const pending=turn.interactions.find(card=>card.status==="pending");
      if(!this.interactions||!pending)throw new ConflictException("交互已处理，请刷新后查看当前执行");
      await this.interactions.cancelWaiting(runId,pending.id,async(c)=>{
        await lifecycleWriteLock(c);
        if(!(await c.query("SELECT id FROM integration_calls WHERE id=$1 AND status='waiting' AND expires_at>now() FOR UPDATE",[runId])).rowCount)
          throw new ConflictException("原执行已继续或过期，不能取消历史交互");
        await this.access.finish(runId,null,0,c);
        const cancelled=await c.query("UPDATE chatbot_turns SET status='cancelled',cancel_requested_at=now(),finished_at=now(),error_code='run_cancelled',error_message='已停止执行' WHERE id=$1 AND status='waiting' RETURNING id",[runId]);
        if(!cancelled.rowCount)throw new ConflictException("会话执行已继续，不能取消历史交互");
      });
      return {ok:true};
    }
    await this.db.query(
      "UPDATE chatbot_turns t SET cancel_requested_at=now() FROM integration_calls c WHERE t.id=$1 AND c.id=t.id AND t.status='running' AND c.status='running'",
      [runId],
    );
    this.active.get(runId)?.abort.abort(new Error("Stopped by user"));
    return { ok: true };
  }
  async respond(p:ChatbotPrincipal,sessionId:string,runId:string,interactionId:string,value:unknown) {
    const turn=await this.turn(p,sessionId,runId);
    if(!value || typeof value!=="object" || !("interactionId" in value) || value.interactionId!==interactionId) throw new BadRequestException("交互标识与请求路径不一致");
    const session=await this.session(p,sessionId);
    if(!session.agentEnabled) throw new ForbiddenException("Agent 已停用，不能继续执行");
    let chatContext:PreparedRun["chatContext"];
    if(turn.status==="waiting") {
      const composition=await this.management.snapshotPinned(session.agentId,turn.agentVersionId);
      const linked=(await this.attachments.forTurns(sessionId)).filter(a=>a.turnId===runId).map(a=>a.id);
      const resources=await this.attachments.resolve(sessionId,linked,composition);
      chatContext={contextFiles:resources.contextFiles,images:resources.images,validateContextFile:async(file,signal)=>{signal.throwIfAborted();await this.session(p,sessionId);await this.attachments.validate(sessionId,file.reference!.id);}};
    }
    const releaseSlot=this.limiter.acquireConcurrent("chat");
    let handedOff=false;
    try {
      const resumed=await this.runs.prepareResumeForChatbot(p,runId,value,chatContext);
      if(resumed.prepared) {
        await this.db.query("UPDATE chatbot_turns SET status='running',finished_at=NULL,error_code=NULL,error_message=NULL WHERE id=$1 AND status='waiting'",[runId]);
        this.launch(p,sessionId,runId,resumed.prepared,releaseSlot);
        handedOff=true;
      }
      return {runId,replayed:resumed.replayed,stream:true};
    } finally {
      if(!handedOff)releaseSlot();
    }
  }
  async upload(
    p: ChatbotPrincipal,
    sessionId: string,
    file: Express.Multer.File,
  ) {
    const session = await this.session(p, sessionId);
    const composition = await this.management.snapshot(session.agentId);
    const result = await this.limiter.run(
      "document-upload",
      JSON.stringify(this.principal(p)),
      () =>
        this.attachments.upload(
          sessionId,
          file,
          supportsConversationImages(composition),
        ),
    );
    await this.session(p, sessionId);
    return result;
  }
  async downloadAttachment(p: ChatbotPrincipal, sessionId: string, id: string) {
    await this.session(p, sessionId);
    const file = await this.attachments.get(sessionId, id, true);
    if (file.status !== "ready" || !file.content)
      throw new NotFoundException("附件尚未就绪或已过期");
    return file;
  }
  async artifact(
    p: ChatbotPrincipal,
    sessionId: string,
    runId: string,
    fileId: string,
  ) {
    const turn = await this.turn(p, sessionId, runId);
    if (
      turn.status !== "completed" ||
      !turn.traceId ||
      !turn.response?.artifacts.some(
        (a) => a.kind === "execution_file" && a.id === fileId,
      )
    )
      throw new NotFoundException("文件不存在或尚未生成");
    return "adminId" in p
      ? this.artifacts.downloadForAdmin(turn.traceId, fileId, p.adminId)
      : this.artifacts.downloadForApp(
          { ...p.identity, ownerId: p.owner },
          turn.response.agentId,
          fileId,
        );
  }
  private async audit(
    c: PoolClient,
    p: ChatbotPrincipal,
    action: string,
    id: string,
  ) {
    await c.query(
      "INSERT INTO chatbot_events(session_id,actor_kind,actor_id,action) VALUES($1,$2,$3,$4)",
      [
        id,
        "adminId" in p ? "admin" : "visitor",
        String("adminId" in p ? p.adminId : p.owner),
        action,
      ],
    );
    if ("adminId" in p)
      await c.query(
        "INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id) VALUES($1,$2,'chatbot_session',$3)",
        [p.adminId, `chatbot_session.${action}`, id],
      );
  }
  hasActive(runId: string) {
    return this.active.has(runId);
  }
  async onApplicationShutdown() {
    const tasks = [...this.active.values()];
    for (const state of tasks)
      state.abort.abort(new Error("API shutting down"));
    await Promise.race([
      Promise.allSettled(tasks.map((s) => s.done)),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        timeout.unref();
      }),
    ]);
  }
}
