import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database.service";
import { redactToolData } from "../tool-management/network";
import { interactionResponseSchema, InteractionSuspension, InteractionWaiting, type InteractionRequest, type InteractionResponse, type JsonObject, type JsonValue, type PublicInteraction, type RuntimeContinuationState, type RuntimeInteractionHost } from "./contracts";
import { PostgresCheckpointSaver } from "./postgres-checkpointer";

type Thread = { run_id: string; host_input: JsonObject; continuation: RuntimeContinuationState; interrupt_id: string | null; status: string; expires_at: string | Date };
type Row = { id: string; run_id: string; interrupt_id: string; revision: number; kind: "question" | "approval"; status: PublicInteraction["status"]; request: InteractionRequest; public_request: JsonObject; response: JsonValue | null; response_fingerprint: string | null; expires_at: string | Date };
export type InteractionResolution = { replayed: boolean; interaction: PublicInteraction; hostInput: JsonObject; host: RuntimeInteractionHost };
function canonical(value:unknown):unknown { return Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value; }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function bounded(value: unknown, bytes: number) { if (Buffer.byteLength(JSON.stringify(value))>bytes) throw new BadRequestException("交互内容超过长度限制"); }

/** Private checkpoint/interaction persistence. Authority belongs to the existing
 * Run/Chat edge, which must authorize the current owner before each operation. */
@Injectable()
export class InteractionService {
  constructor(private readonly db: DatabaseService) {}
  private public(row: Row): PublicInteraction {
    return { ...row.public_request, id:row.id,runId:row.run_id,kind:row.kind,status:row.status,revision:row.revision,expiresAt:new Date(row.expires_at).toISOString(),...(row.kind==="question" && row.response ? {answer:row.response as PublicInteraction["answer"]} : {}) } as PublicInteraction;
  }
  private runtime(runId:string, thread?:Thread, response?:JsonValue):RuntimeInteractionHost {
    return {checkpointer:new PostgresCheckpointSaver(this.db,runId),threadId:runId,...(thread?.continuation ? {continuation:thread.continuation}:{}),...(response!==undefined && thread?.interrupt_id ? {resume:{interruptId:thread.interrupt_id,value:response}}:{})};
  }
  async createHost(runId:string, hostInput:JsonObject):Promise<RuntimeInteractionHost> {
    bounded(hostInput,2097152);
    await this.purgeExpired();
    await this.db.query("INSERT INTO agent_interaction_threads(run_id,host_input) VALUES($1,$2::jsonb) ON CONFLICT(run_id) DO NOTHING",[runId,JSON.stringify(hostInput)]);
    const thread = await this.thread(runId);
    if (thread.status==="waiting") {
      const current=(await this.list(runId)).find((item)=>item.status==="pending");
      if(current) throw new InteractionWaiting(current);
    }
    if(thread.status!=="running") throw new ConflictException("此任务不能重新开始执行");
    if(digest(thread.host_input)!==digest(hostInput)) throw new ConflictException("交互执行上下文与原请求不一致");
    return this.runtime(runId);
  }
  async thread(runId:string):Promise<Thread> {
    const thread=(await this.db.query<Thread>("SELECT run_id,host_input,continuation,interrupt_id,status,expires_at FROM agent_interaction_threads WHERE run_id=$1",[runId])).rows[0];
    if(!thread) throw new NotFoundException("交互任务不存在");
    return thread;
  }
  async saveWaiting(runId:string, traceId:string, suspension:InteractionSuspension, transition?:(c:PoolClient,expiresAt:Date)=>Promise<void>):Promise<PublicInteraction> {
    const request=suspension.request;
    this.validateRequest(request);
    bounded(suspension.continuation,2097152);
    const publicRequest:JsonObject=request.kind==="question" ? {...request} : {kind:"approval",toolName:request.toolName,description:request.description,arguments:redactToolData(request.arguments) as JsonObject};
    bounded(publicRequest,65536);
    return this.db.transaction(async(c)=>{
      const thread=(await c.query<Thread>("SELECT * FROM agent_interaction_threads WHERE run_id=$1 AND expires_at>now() FOR UPDATE",[runId])).rows[0];
      if(!thread || !["running","resuming"].includes(thread.status)) throw new ConflictException("此任务已结束或正在等待回应");
      if(thread.host_input.traceId!==traceId) throw new ConflictException("交互 Trace 与原执行不一致");
      if(!(await c.query("SELECT 1 FROM agent_native_checkpoints WHERE run_id=$1 LIMIT 1",[runId])).rowCount) throw new ConflictException("缺少原生执行检查点，无法安全等待");
      await transition?.(c,new Date(thread.expires_at));
      // LangGraph identifies an interrupt by its node task. Several approvals
      // inside one task legitimately share that native ID, so card identity
      // additionally binds the exact tool call/question payload.
      const requestKey=digest([suspension.interruptId,request]);
      const row=(await c.query<Row>("INSERT INTO agent_interactions(id,run_id,interrupt_id,kind,request,public_request,expires_at,request_key) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) ON CONFLICT(run_id,request_key) DO UPDATE SET interrupt_id=EXCLUDED.interrupt_id RETURNING *",[randomUUID(),runId,suspension.interruptId,request.kind,JSON.stringify(request),JSON.stringify(publicRequest),thread.expires_at,requestKey])).rows[0];
      if(row.status!=="pending" || digest(row.request)!==digest(request)) throw new ConflictException("原生交互已处理或内容发生变化");
      await c.query("UPDATE agent_interaction_threads SET status='waiting',interrupt_id=$2,continuation=$3::jsonb,updated_at=now() WHERE run_id=$1",[runId,suspension.interruptId,JSON.stringify(suspension.continuation)]);
      return this.public(row);
    });
  }
  private validateRequest(request:InteractionRequest) {
    bounded(request,65536);
    if(request.kind==="question") {
      if(!request.question.trim() || request.question.length>2000 || request.options.length>10 || (!request.options.length&&!request.allowCustom) || new Set(request.options.map(x=>x.id)).size!==request.options.length || request.options.some(x=>!x.id||x.id.length>80||!x.label.trim()||x.label.length>300)) throw new BadRequestException("问题选项不符合交互规范");
    } else if(!request.toolName || request.toolName.length>128 || !Number.isSafeInteger(request.toolVersionId) || request.toolVersionId<=0 || !request.toolCallId || request.toolCallId.length>200) throw new BadRequestException("工具审批缺少固定调用标识");
  }
  async list(runId:string):Promise<PublicInteraction[]> {
    await this.purgeExpired();
    await this.db.query("UPDATE agent_interactions SET status='expired',revision=revision+1,resolved_at=now() WHERE run_id=$1 AND status='pending' AND expires_at<=now()",[runId]);
    return (await this.db.query<Row>("SELECT * FROM agent_interactions WHERE run_id=$1 ORDER BY created_at,id",[runId])).rows.map(row=>this.public(row));
  }
  async listMany(runIds:string[]):Promise<Map<string,PublicInteraction[]>> {
    if(!runIds.length) return new Map();
    await this.purgeExpired();
    await this.db.query("UPDATE agent_interactions SET status='expired',revision=revision+1,resolved_at=now() WHERE run_id=ANY($1::uuid[]) AND status='pending' AND expires_at<=now()",[runIds]);
    const rows=(await this.db.query<Row>("SELECT * FROM agent_interactions WHERE run_id=ANY($1::uuid[]) ORDER BY created_at,id",[runIds])).rows;
    const result=new Map<string,PublicInteraction[]>();
    for(const row of rows) result.set(row.run_id,[...(result.get(row.run_id)??[]),this.public(row)]);
    return result;
  }
  async respond(runId:string, value:unknown, transition?:(c:PoolClient)=>Promise<void>):Promise<InteractionResolution> {
    const parsed=interactionResponseSchema.safeParse(value);
    if(!parsed.success) throw new BadRequestException("请提交有效的交互选择和修订号");
    const input=parsed.data;
    return this.db.transaction(async(c)=>{
      const thread=(await c.query<Thread>("SELECT * FROM agent_interaction_threads WHERE run_id=$1 FOR UPDATE",[runId])).rows[0];
      const row=(await c.query<Row>("SELECT * FROM agent_interactions WHERE id=$1 AND run_id=$2 FOR UPDATE",[input.interactionId,runId])).rows[0];
      if(!thread||!row) throw new NotFoundException("交互请求不存在");
      const response=this.response(row.request,input),fingerprint=digest(response);
      if(row.status!=="pending") {
        if(row.response_fingerprint===fingerprint && input.revision===row.revision-1) return {replayed:true,interaction:this.public(row),hostInput:thread.host_input,host:this.runtime(runId,thread,response)};
        throw new ConflictException("此交互已处理，请刷新后查看最新状态");
      }
      if(row.revision!==input.revision || thread.status!=="waiting" || thread.interrupt_id!==row.interrupt_id) throw new ConflictException("交互状态已变化，请刷新后重试");
      if(new Date(row.expires_at).getTime()<=Date.now() || new Date(thread.expires_at).getTime()<=Date.now()) throw new ConflictException("交互请求已过期，请发起新任务");
      if(!thread.continuation.harness || !thread.continuation.execution) throw new ConflictException("原生执行状态不完整，不能重新执行工具");
      await transition?.(c);
      const status=input.kind==="approval" ? input.decision==="approve"?"approved":"rejected" : input.skip?"skipped":"answered";
      const resolved=(await c.query<Row>("UPDATE agent_interactions SET status=$2,response=$3::jsonb,response_fingerprint=$4,revision=revision+1,resolved_at=now() WHERE id=$1 RETURNING *",[row.id,status,JSON.stringify(response),fingerprint])).rows[0];
      await c.query("UPDATE agent_interaction_threads SET status='resuming',updated_at=now() WHERE run_id=$1",[runId]);
      return {replayed:false,interaction:this.public(resolved),hostInput:thread.host_input,host:this.runtime(runId,thread,response)};
    });
  }
  private response(request:InteractionRequest,input:InteractionResponse):JsonValue {
    if(input.kind!==request.kind) throw new BadRequestException("交互类型不匹配");
    if(input.kind==="approval") return {decision:input.decision};
    if(request.kind!=="question") throw new BadRequestException("交互类型不匹配");
    if(input.skip) return {skipped:true};
    if(input.optionId) { const option=request.options.find(option=>option.id===input.optionId);if(!option)throw new BadRequestException("所选选项不存在");return {optionId:option.id,text:option.label}; }
    if(!request.allowCustom || !input.text) throw new BadRequestException("当前问题不允许自由填写");
    return {text:input.text};
  }
  private async clearTerminalApprovalArguments(c:PoolClient,runIds:string[]) {
    await c.query("UPDATE agent_interactions SET request=jsonb_set(request,'{arguments}','{}'::jsonb) WHERE run_id=ANY($1::uuid[]) AND kind='approval' AND status<>'pending'",[runIds]);
  }
  async complete(runId:string) { await this.db.transaction(async(c)=>{await c.query("UPDATE agent_interaction_threads SET status='completed',continuation='{}'::jsonb,host_input='{}'::jsonb,updated_at=now() WHERE run_id=$1 AND status IN ('running','resuming')",[runId]);await this.clearTerminalApprovalArguments(c,[runId]);await c.query("DELETE FROM agent_native_checkpoint_writes WHERE run_id=$1",[runId]);await c.query("DELETE FROM agent_native_checkpoints WHERE run_id=$1",[runId]);}); }
  /** Public cancellation may claim only the exact still-pending card. A stale
   * browser must never cancel a response another browser already consumed. */
  async cancelWaiting(runId:string,interactionId:string,transition?:(c:PoolClient)=>Promise<void>):Promise<PublicInteraction> {
    return this.db.transaction(async(c)=>{
      const thread=(await c.query<Thread>("SELECT * FROM agent_interaction_threads WHERE run_id=$1 FOR UPDATE",[runId])).rows[0];
      const row=(await c.query<Row>("SELECT * FROM agent_interactions WHERE id=$1 AND run_id=$2 FOR UPDATE",[interactionId,runId])).rows[0];
      if(!thread||!row)throw new NotFoundException("交互请求不存在");
      if(thread.status!=="waiting"||row.status!=="pending"||thread.interrupt_id!==row.interrupt_id)
        throw new ConflictException("此交互已处理，不能取消正在继续的执行");
      if(new Date(row.expires_at).getTime()<=Date.now()||new Date(thread.expires_at).getTime()<=Date.now())
        throw new ConflictException("交互请求已过期");
      await transition?.(c);
      const cancelled=(await c.query<Row>("UPDATE agent_interactions SET status='cancelled',revision=revision+1,resolved_at=now() WHERE id=$1 AND status='pending' RETURNING *",[interactionId])).rows[0];
      if(!cancelled)throw new ConflictException("交互状态已变化，请刷新后重试");
      await c.query("UPDATE agent_interaction_threads SET status='cancelled',continuation='{}'::jsonb,host_input='{}'::jsonb,updated_at=now() WHERE run_id=$1 AND status='waiting'",[runId]);
      await this.clearTerminalApprovalArguments(c,[runId]);
      await c.query("DELETE FROM agent_native_checkpoint_writes WHERE run_id=$1",[runId]);
      await c.query("DELETE FROM agent_native_checkpoints WHERE run_id=$1",[runId]);
      return this.public(cancelled);
    });
  }
  async cancel(runId:string) { await this.db.transaction(async(c)=>{await c.query("UPDATE agent_interaction_threads SET status='cancelled',continuation='{}'::jsonb,host_input='{}'::jsonb,updated_at=now() WHERE run_id=$1 AND status IN ('running','resuming','waiting')",[runId]);await c.query("UPDATE agent_interactions SET status='cancelled',revision=revision+1,resolved_at=now() WHERE run_id=$1 AND status='pending'",[runId]);await this.clearTerminalApprovalArguments(c,[runId]);await c.query("DELETE FROM agent_native_checkpoint_writes WHERE run_id=$1",[runId]);await c.query("DELETE FROM agent_native_checkpoints WHERE run_id=$1",[runId]);}); }
  async purgeExpired() {
    await this.db.transaction(async(c)=>{
      const expired=(await c.query<{run_id:string}>("UPDATE agent_interaction_threads SET status='expired',host_input='{}'::jsonb,continuation='{}'::jsonb,updated_at=now() WHERE expires_at<=now() AND status IN ('running','waiting','resuming') RETURNING run_id")).rows.map(row=>row.run_id);
      if(!expired.length) return;
      await c.query("UPDATE agent_interactions SET status='expired',revision=revision+1,resolved_at=now() WHERE run_id=ANY($1::uuid[]) AND status='pending'",[expired]);
      await this.clearTerminalApprovalArguments(c,expired);
      await c.query("DELETE FROM agent_native_checkpoint_writes WHERE run_id=ANY($1::uuid[])",[expired]);
      await c.query("DELETE FROM agent_native_checkpoints WHERE run_id=ANY($1::uuid[])",[expired]);
    });
  }
}
