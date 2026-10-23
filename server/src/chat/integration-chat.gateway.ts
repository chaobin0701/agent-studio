import { uiBlocks } from "../tool-management/ui-tool";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
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
  agentMemoryScope,
  type CompositionSnapshot,
} from "../agent-management/runtime-scope";
import { InteractionService } from "../interactions/interaction.service";
import { InteractionSuspension, InteractionWaiting, type RuntimeInteractionHost } from "../interactions/contracts";
import { lifecycleWriteLock } from "../agent-management/resource-lifecycle";

type Admission = Awaited<ReturnType<IntegrationService["admit"]>>;
export type PreparedChat={identity:IntegrationIdentity;ownerId:string;question:string;context?:RequestContext;admission:Admission;compositionSnapshot?:CompositionSnapshot;interactionHost?:RuntimeInteractionHost;executionTraceId?:string};

@Injectable()
export class IntegrationChatGateway {
  private readonly logger=new Logger(IntegrationChatGateway.name);
  constructor(
    private readonly access: IntegrationService,
    private readonly application: ChatApplicationService,
    private readonly db: DatabaseService,
    private readonly management: AgentManagementService,
    @Optional() private readonly interactions?:InteractionService,
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
    prepared: PreparedChat,
    requestId: string,
    callbacks?: ChatStreamCallbacks,
  ): Promise<
    PublicAgentResult & Pick<ChatAnswer, "progressEvents" | "toolSteps">
  > {
    const { admission, identity, ownerId, question, context } = prepared;
    if (admission.cached)
      return admission.cached as PublicAgentResult &
        Pick<ChatAnswer, "progressEvents" | "toolSteps">;
    const traceId=prepared.executionTraceId??randomUUID();
    try {
      const composition=prepared.compositionSnapshot;
      const host=prepared.interactionHost??(this.interactions && composition?.mode==="single" ? await this.interactions.createHost(admission.callId,{
        entryPoint:"legacy_chat",traceId,question,context:JSON.parse(JSON.stringify(context??{})),conversationId:admission.conversationId,clientRequestId:admission.clientRequestId,
        applicationId:identity.app.id,applicationAuthVersion:identity.app.authVersion,ownerId,agentId:composition.agentId,agentVersionId:composition.entryVersionId,memoryScope:agentMemoryScope(composition),
      }):undefined);
      if(host && !(await this.db.query("UPDATE integration_calls SET trace_id=$2 WHERE id=$1 AND status='running' AND expires_at>now() RETURNING id",[admission.callId,traceId])).rowCount)throw new ConflictException("原执行已结束或过期，不能继续调用工具");
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
                {...callbacks,...(host?{interactionHost:host,executionTraceId:traceId,integrationCallId:admission.callId}:{})},
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
        ...(answer.contextUsage ? { contextUsage: answer.contextUsage } : {}),
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
      await this.interactions?.complete(admission.callId).catch(()=>this.logger.warn("Could not purge completed chat checkpoint"));
      return {
        ...(completed ?? result),
        progressEvents: answer.progressEvents,
        ...(answer.contextUsage ? { contextUsage: answer.contextUsage } : {}),
        toolSteps: answer.toolSteps,
      };
    } catch (error) {
      if(error instanceof InteractionWaiting) throw error;
      if(error instanceof InteractionSuspension && this.interactions) {
        let interaction;
        try {interaction=await this.interactions.saveWaiting(admission.callId,traceId,error,async(c,expiresAt)=>{await this.access.pause(admission.callId,c);await c.query("UPDATE integration_calls SET expires_at=LEAST(expires_at,$2::timestamptz) WHERE id=$1 AND status='waiting'",[admission.callId,expiresAt]);await c.query("UPDATE conversation_runs SET expires_at=$2 WHERE integration_call_id=$1 AND status='waiting'",[admission.callId,expiresAt]);});}
        catch(storageError){error=storageError;}
        if(interaction)throw new InteractionWaiting(interaction);
      }
      await this.access.finish(admission.callId, null);
      await this.interactions?.cancel(admission.callId);
      if(this.interactions) await this.db.query("UPDATE conversation_runs SET status='failed',finished_at=now(),error_code='interaction_failed' WHERE integration_call_id=$1 AND status='waiting'",[admission.callId]);
      throw error;
    }
  }

  async cancelAdmission(prepared:PreparedChat) {
    const id=prepared.admission.callId;
    if(!id)return;
    await this.access.finish(id,null);
    await this.interactions?.cancel(id);
    if(this.interactions) await this.db.query("UPDATE conversation_runs SET status='failed',finished_at=now(),error_code='run_cancelled' WHERE integration_call_id=$1 AND status IN ('running','waiting')",[id]);
  }

  async prepareResume(identity:IntegrationIdentity,ownerId:string,conversationId:string,interactionId:string,value:unknown) {
    this.access.assertScope(identity,"chat:write");
    if(!this.interactions) throw new ConflictException("交互服务不可用");
    if(!value||typeof value!=="object"||!("interactionId" in value)||value.interactionId!==interactionId)throw new BadRequestException("交互标识与路径不一致");
    const row=(await this.db.query<{callId:string}>("SELECT c.id AS \"callId\" FROM integration_calls c JOIN conversations v ON v.id=c.conversation_id JOIN agent_interactions i ON i.run_id=c.id WHERE i.id=$1 AND v.id=$2 AND c.app_id=$3 AND c.visitor_session_id=$4 AND v.application_id=c.app_id AND v.visitor_session_id=c.visitor_session_id",[interactionId,conversationId,identity.app.id,ownerId])).rows[0];
    if(!row)throw new NotFoundException("交互请求不存在或不属于当前会话");
    const thread=await this.interactions.thread(row.callId),stored=thread.host_input;
    if(thread.status==="completed"||thread.status==="cancelled"){
      const resolution=await this.interactions.respond(row.callId,value);
      return {runId:row.callId,conversationId,replayed:true,interaction:resolution.interaction,prepared:undefined};
    }
    if(stored.entryPoint!=="legacy_chat"||stored.conversationId!==conversationId||stored.applicationId!==identity.app.id||stored.ownerId!==ownerId||stored.applicationAuthVersion!==identity.app.authVersion||stored.agentId!==identity.app.agentId)throw new ForbiddenException("原会话的应用授权已变化");
    if(typeof stored.agentId!=="number"||typeof stored.agentVersionId!=="number"||typeof stored.traceId!=="string"||typeof stored.question!=="string"||typeof stored.clientRequestId!=="string")throw new ConflictException("原执行上下文不完整");
    const composition=await this.management.snapshotPinned(stored.agentId,stored.agentVersionId);
    if(composition.mode!=="single"||agentMemoryScope(composition)!==stored.memoryScope)throw new ConflictException("原发布资源已变化，无法安全继续执行");
    const resolution=await this.interactions.respond(row.callId,value,c=>this.access.resume(row.callId,c));
    const prepared:PreparedChat|undefined=resolution.replayed?undefined:{identity,ownerId,question:stored.question,context:normalizeRequestContext(stored.context,stored.question),compositionSnapshot:composition,executionTraceId:stored.traceId,interactionHost:resolution.host,
      admission:{cached:null,callId:row.callId as ReturnType<typeof randomUUID>,conversationId,clientRequestId:stored.clientRequestId}};
    return {runId:row.callId,conversationId,replayed:resolution.replayed,interaction:resolution.interaction,prepared};
  }

  async cancelInteraction(identity:IntegrationIdentity,ownerId:string,conversationId:string,interactionId:string) {
    this.access.assertScope(identity,"chat:write");
    if(!this.interactions)throw new ConflictException("交互服务不可用");
    const row=(await this.db.query<{id:string}>("SELECT c.id FROM integration_calls c JOIN conversations v ON v.id=c.conversation_id JOIN agent_interactions i ON i.run_id=c.id WHERE i.id=$1 AND v.id=$2 AND c.app_id=$3 AND c.visitor_session_id=$4 AND v.application_id=c.app_id AND v.visitor_session_id=c.visitor_session_id",[interactionId,conversationId,identity.app.id,ownerId])).rows[0];
    if(!row)throw new NotFoundException("交互请求不存在或不属于当前会话");
    await this.interactions.cancelWaiting(row.id,interactionId,async(c)=>{
      await lifecycleWriteLock(c);
      if(!(await c.query("SELECT id FROM integration_calls WHERE id=$1 AND status='waiting' AND expires_at>now() FOR UPDATE",[row.id])).rowCount)
        throw new ConflictException("原执行已继续或过期，不能取消历史交互");
      await this.access.finish(row.id,null,0,c);
      const cancelled=await c.query("UPDATE conversation_runs SET status='interrupted',finished_at=now(),error_code='run_cancelled' WHERE integration_call_id=$1 AND status='waiting' RETURNING id",[row.id]);
      if(!cancelled.rowCount)throw new ConflictException("会话执行已继续，不能取消历史交互");
    });
    return {ok:true,runId:row.id,conversationId};
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
      contextUsage,
    } = result;
    return {
      conversationId,
      runId,
      traceId,
      status,
      answer,
      refused,
      citations,
      uiBlocks: uiBlocks(artifacts, runId ?? ""),
      ...(usage ? { usage } : {}),
      ...(context ? { context } : {}),
      ...(progressEvents ? { progressEvents } : {}),
      ...(artifacts?.length ? { artifacts } : {}),
      ...(references?.length ? { references } : {}),
      ...(structured !== undefined ? { structured } : {}),
      ...(contextUsage ? { contextUsage } : {}),
    };
  }
}
