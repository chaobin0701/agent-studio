import { omitExternalTraceLinks } from "../observability/execution-view";
import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database.service';
import { InspectConversationDebugDto } from './admin-debug.dto';

type JsonRecord = Record<string, unknown>;
type Severity = 'error' | 'warning' | 'info';

export type DebugFinding = {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
  conversationId?: string;
  traceId?: string;
};

type DebugMetrics = {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  runCount: number;
  failedRunCount: number;
  activeRunCount: number;
  traceCount: number;
  failedTraceCount: number;
  refusedTraceCount: number;
  toolCallCount: number;
  modelCallCount: number;
  totalDurationMs: number;
  totalTokens: number;
};

type ConversationRow = {
  id: string;
  visitorSessionId: string;
  title: string;
  summary: string;
  busyUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

type MessageRow = {
  id: number;
  role: string;
  content: string;
  refused: boolean | null;
  citations: unknown;
  toolSteps: unknown;
  progressEvents: unknown;
  createdAt: string;
};

type RunRow = {
  id: string;
  clientRequestId: string;
  question: string;
  status: string;
  expiresAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  userMessageId: number | null;
  assistantMessageId: number | null;
  createdAt: string;
};

type TraceRow = {
  id: string;
  kind: string;
  conversationId: string | null;
  userMessageId: number | null;
  question: string;
  contextSnapshot: unknown;
  model: string | null;
  rawModelOutput: string | null;
  finalAnswer: string | null;
  refused: boolean | null;
  status: string;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
  createdAt: string;
};

type DebugConversation = ConversationRow & {
  messages: MessageRow[];
  runs: RunRow[];
  traces: TraceRow[];
  findings: DebugFinding[];
  metrics: DebugMetrics;
};

export type DebugInspection = {
  requestedIds: string[];
  requestedConversationIds: string[];
  resolvedConversationIds: string[];
  focusTraceIds: string[];
  notFoundIds: string[];
  requestedTraceIds: string[];
  notFoundTraceIds: string[];
  issueDescription: string;
  inspectedAt: string;
  conversations: DebugConversation[];
  diagnostics: {
    findings: DebugFinding[];
    metrics: DebugMetrics;
  };
};

@Injectable()
export class AdminDebugService {
  constructor(private readonly database: DatabaseService) {}

  async inspect(actorId: number, input: InspectConversationDebugDto): Promise<DebugInspection> {
    const conversationIds = unique(input.conversationIds ?? []);
    const traceIds = unique(input.traceIds ?? []);
    if (conversationIds.length + traceIds.length < 1 || conversationIds.length + traceIds.length > 20) {
      throw new BadRequestException('Provide between 1 and 20 unique conversationIds and traceIds in total');
    }

    const resolvedTraces = traceIds.length
      ? (await this.database.query<{ id: string; conversationId: string | null }>(
        'SELECT id, conversation_id AS "conversationId" FROM chat_traces WHERE id = ANY($1::uuid[])', [traceIds],
      )).rows
      : [];
    const resolvedIds = unique([...conversationIds, ...resolvedTraces.flatMap((trace) => trace.conversationId ? [trace.conversationId] : [])]);

    const conversations: DebugConversation[] = [];
    const notFoundIds: string[] = [];
    const foundTraceIds = new Set(resolvedTraces.map((trace) => trace.id));
    for (const conversationId of resolvedIds) {
      const conversation = await this.loadConversation(conversationId);
      if (!conversation) {
        notFoundIds.push(conversationId);
        continue;
      }
      conversation.traces.forEach((trace) => foundTraceIds.add(trace.id));
      conversation.findings = this.diagnoseConversation(conversation);
      conversations.push(conversation);
    }

    const findings = [
      ...notFoundIds.map((id): DebugFinding => ({
        code: 'conversation_not_found', severity: 'error', title: '会话不存在', detail: `找不到会话 ${id}`, conversationId: id,
      })),
      ...traceIds.filter((id) => !foundTraceIds.has(id)).map((id): DebugFinding => ({
        code: 'trace_not_found', severity: 'warning', title: '轨迹不存在', detail: `没有找到指定轨迹 ${id}`, traceId: id,
      })),
      ...conversations.flatMap((conversation) => conversation.findings),
    ];
    const metrics = sumMetrics(conversations.map((conversation) => conversation.metrics));
    const inspectedAt = new Date().toISOString();
    const result: DebugInspection = {
      requestedIds: conversationIds,
      requestedConversationIds: conversationIds,
      resolvedConversationIds: conversations.map((conversation) => conversation.id),
      focusTraceIds: traceIds.filter((id) => foundTraceIds.has(id)),
      notFoundIds,
      requestedTraceIds: traceIds,
      notFoundTraceIds: traceIds.filter((id) => !foundTraceIds.has(id)),
      issueDescription: input.issueDescription?.trim() ?? '',
      inspectedAt,
      conversations,
      diagnostics: { findings, metrics },
    };
    await this.audit(actorId, 'debug.inspected', 'debug_inspection', randomUUID(), {
      conversationIds,
      traceIds,
      issueDescription: result.issueDescription,
      conversationCount: conversations.length,
      findingCount: findings.length,
    });
    return result;
  }

  private async loadConversation(conversationId: string): Promise<DebugConversation | null> {
    const conversationResult = await this.database.query<ConversationRow>(
      `SELECT id, visitor_session_id AS "visitorSessionId", title, summary,
              busy_until AS "busyUntil", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM conversations WHERE id = $1`, [conversationId],
    );
    const conversation = conversationResult.rows[0];
    if (!conversation) return null;
    const [messages, runs, traces] = await Promise.all([
      this.database.query<MessageRow>(
        `SELECT id::int, role, content, refused, citations, request_context AS context, tool_steps AS "toolSteps",
                progress_events AS "progressEvents", created_at AS "createdAt"
         FROM conversation_messages WHERE conversation_id = $1 ORDER BY id ASC`, [conversationId],
      ),
      this.database.query<RunRow>(
        `SELECT id, client_request_id AS "clientRequestId", question, request_context AS context, status,
                expires_at AS "expiresAt", started_at AS "startedAt", finished_at AS "finishedAt",
                error_code AS "errorCode", user_message_id::int AS "userMessageId",
                assistant_message_id::int AS "assistantMessageId", created_at AS "createdAt"
         FROM conversation_runs WHERE conversation_id = $1 ORDER BY created_at ASC`, [conversationId],
      ),
      this.database.query<TraceRow>(
        `SELECT id, kind, conversation_id AS "conversationId", user_message_id::int AS "userMessageId",
                question, context_snapshot AS "contextSnapshot", model,
                raw_model_output AS "rawModelOutput", final_answer AS "finalAnswer", refused, status,
                error_code AS "errorCode", input_tokens AS "inputTokens", output_tokens AS "outputTokens",
                total_tokens AS "totalTokens", duration_ms AS "durationMs", created_at AS "createdAt"
         FROM chat_traces WHERE conversation_id = $1 ORDER BY created_at ASC`, [conversationId]),
    ]);
    const base = {
      ...conversation,
      messages: messages.rows,
      runs: runs.rows,
      traces: traces.rows.map(trace => ({ ...trace, contextSnapshot: omitExternalTraceLinks(trace.contextSnapshot) })),
      findings: [],
      metrics: emptyMetrics(),
    } satisfies DebugConversation;
    base.metrics = metricsFor(base);
    return base;
  }

  private diagnoseConversation(conversation: DebugConversation): DebugFinding[] {
    const findings: DebugFinding[] = [];
    const add = (finding: Omit<DebugFinding, 'conversationId'>) => findings.push({ ...finding, conversationId: conversation.id });
    const now = Date.now();
    const messageIds = new Set(conversation.messages.map((message) => message.id));
    const assistantMessages = conversation.messages.filter((message) => message.role === 'assistant');
    if (!conversation.traces.length && (assistantMessages.length > 0 || conversation.runs.length > 0)) {
      add({ code: 'trace_missing', severity: 'warning', title: '缺少对话轨迹', detail: '会话存在消息或运行记录，但没有对应的 chat trace。' });
    }
    if (conversation.busyUntil && new Date(conversation.busyUntil).getTime() > now
      && !conversation.runs.some((run) => ['queued', 'running'].includes(run.status))) {
      add({ code: 'busy_lock_without_run', severity: 'warning', title: '会话仍被占用', detail: `busyUntil 为 ${conversation.busyUntil}，但没有活跃运行记录。` });
    }
    for (const run of conversation.runs) {
      if (run.status === 'failed') add({ code: 'run_failed', severity: 'error', title: '运行失败', detail: run.errorCode ? `运行失败：${run.errorCode}` : '运行状态为 failed。' });
      if (['queued', 'running'].includes(run.status) && new Date(run.expiresAt).getTime() <= now) {
        add({ code: 'stale_run', severity: 'error', title: '运行记录已过期', detail: `运行 ${run.id} 已超过 expiresAt，但仍为 ${run.status}。` });
      }
      if (run.status === 'completed' && (!run.userMessageId || !run.assistantMessageId)) {
        add({ code: 'run_message_link_missing', severity: 'warning', title: '运行与消息未完整关联', detail: `运行 ${run.id} 缺少用户消息或助手消息 ID。` });
      }
      if (run.userMessageId && !messageIds.has(run.userMessageId)) add({ code: 'run_user_message_missing', severity: 'error', title: '运行引用的用户消息不存在', detail: `运行 ${run.id} 引用了消息 ${run.userMessageId}。` });
      if (run.assistantMessageId && !messageIds.has(run.assistantMessageId)) add({ code: 'run_assistant_message_missing', severity: 'error', title: '运行引用的助手消息不存在', detail: `运行 ${run.id} 引用了消息 ${run.assistantMessageId}。` });
    }
    for (const message of assistantMessages) {
      if (!message.content.trim()) add({ code: 'empty_assistant_message', severity: 'error', title: '助手消息为空', detail: `助手消息 ${message.id} 没有内容。` });
      const citations = asArray(message.citations);
      const sourceIds = new Set<number>();
      const messageIndex = conversation.messages.findIndex((item) => item.id === message.id);
      const precedingUserMessageId = messageIndex > 0 && conversation.messages[messageIndex - 1]?.role === 'user'
        ? conversation.messages[messageIndex - 1]!.id
        : null;
      for (const trace of conversation.traces.filter((item) => item.userMessageId === precedingUserMessageId)) {
        const context = asRecord(trace.contextSnapshot);
        for (const source of asArray(context.sources)) {
          const chunkId = asNumber(asRecord(source).chunkId);
          if (chunkId !== null) sourceIds.add(chunkId);
        }
        if (trace.status === 'failed') add({ code: 'trace_failed', severity: 'error', title: '轨迹执行失败', detail: trace.errorCode ? `${trace.id}：${trace.errorCode}` : `轨迹 ${trace.id} 执行失败。`, traceId: trace.id });
        if (!trace.finalAnswer?.trim() && trace.status === 'completed') add({ code: 'empty_final_answer', severity: 'error', title: '最终回答为空', detail: `轨迹 ${trace.id} 已完成但 finalAnswer 为空。`, traceId: trace.id });
        const modelCalls = asArray(context.modelCalls);
        if (modelCalls.some((call) => !asRecord(asRecord(call).response).content)) add({ code: 'empty_model_output', severity: 'error', title: '模型返回为空', detail: `轨迹 ${trace.id} 存在空的模型输出。`, traceId: trace.id });
        if (trace.durationMs > 10000) add({ code: 'high_latency', severity: 'warning', title: '响应耗时较长', detail: `轨迹耗时 ${trace.durationMs} ms。`, traceId: trace.id });
        if ((trace.totalTokens ?? 0) > 12000) add({ code: 'high_token_usage', severity: 'warning', title: 'Token 消耗较高', detail: `轨迹消耗 ${trace.totalTokens} tokens。`, traceId: trace.id });
        const steps = asArray(context.executionSteps);
        const toolCalls = steps.filter((step) => asRecord(step).type === 'tool_call');
        if (trace.refused === true && toolCalls.length === 0 && looksLikeToolIntent(trace.rawModelOutput)) {
          add({ code: 'planner_tool_not_executed', severity: 'error', title: '模型请求了工具但未执行', detail: `轨迹 ${trace.id} 的原始模型输出包含工具请求，但执行步骤中没有对应的工具调用，随后进入了拒答。`, traceId: trace.id });
        }
        const actualTools = steps.filter(step => (asRecord(step).type === 'tool_call' || asRecord(step).origin === 'preload') && !asRecord(step).reused && !asRecord(step).deferred);
        const failedTools = actualTools.filter((step) => asRecord(step).ok === false);
        if (failedTools.length) add({ code: 'tool_failed', severity: 'error', title: '工具调用失败', detail: `轨迹 ${trace.id} 有 ${failedTools.length} 次工具调用失败。`, traceId: trace.id });
        const attemptedToolCount = toolCalls.filter(step => !asRecord(step).deferred).length;
        if (attemptedToolCount >= 5) add({ code: 'tool_call_limit_risk', severity: 'warning', title: '工具调用次数较多', detail: `轨迹 ${trace.id} 共调用 ${attemptedToolCount} 次工具。`, traceId: trace.id });
        const callKeys = actualTools.map((step) => JSON.stringify({ name: asRecord(step).name, arguments: asRecord(step).arguments }));
        if (new Set(callKeys).size < callKeys.length) add({ code: 'duplicate_tool_call', severity: 'warning', title: '存在重复工具调用', detail: `轨迹 ${trace.id} 有完全相同的工具参数被重复调用。`, traceId: trace.id });
        const preflight = asRecord(context.preflight);
        if ((asNumber(preflight.hitCount) ?? 0) > 0 && sourceIds.size === 0) add({ code: 'preflight_evidence_lost', severity: 'warning', title: '预检索资料未进入最终上下文', detail: `轨迹 ${trace.id} 预检索命中，但最终没有保存资料来源。`, traceId: trace.id });
        const progress = asArray(message.progressEvents);
        const running = new Set(progress.filter((event) => asRecord(event).status === 'running').map((event) => asRecord(event).operationId).filter((id): id is string => typeof id === 'string'));
        const completed = new Set(progress.filter((event) => asRecord(event).status === 'completed').map((event) => asRecord(event).operationId).filter((id): id is string => typeof id === 'string'));
        if ([...running].some((id) => !completed.has(id))) add({ code: 'progress_incomplete', severity: 'warning', title: '过程事件未闭合', detail: `轨迹 ${trace.id} 存在没有完成事件的操作。`, traceId: trace.id });
      }
      if (!message.refused && citations.length === 0 && sourceIds.size > 0) add({ code: 'citation_missing', severity: 'error', title: '回答缺少引用', detail: `助手消息 ${message.id} 有资料来源但没有引用。` });
      for (const citation of citations) {
        const chunkId = asNumber(asRecord(citation).chunkId);
        if (chunkId !== null && !sourceIds.has(chunkId)) add({ code: 'citation_invalid', severity: 'error', title: '引用资料不在检索结果中', detail: `助手消息 ${message.id} 引用了未出现在来源中的片段 ${chunkId}。` });
      }
      if (message.refused && sourceIds.size > 0) add({ code: 'refused_with_evidence', severity: 'warning', title: '有资料但仍然拒答', detail: `助手消息 ${message.id} 拒答时存在 ${sourceIds.size} 个资料来源。` });
    }
    for (const trace of conversation.traces) {
      if (trace.status === 'failed') add({ code: 'trace_failed', severity: 'error', title: '轨迹执行失败', detail: trace.errorCode ? `${trace.id}：${trace.errorCode}` : `轨迹 ${trace.id} 执行失败。`, traceId: trace.id });
      if (trace.userMessageId !== null && !messageIds.has(trace.userMessageId)) add({ code: 'trace_message_missing', severity: 'error', title: '轨迹引用的消息不存在', detail: `轨迹 ${trace.id} 引用了消息 ${trace.userMessageId}。`, traceId: trace.id });
    }
    if (!findings.length) findings.push({ code: 'no_rule_issue', severity: 'info', title: '未发现明显流程异常', detail: '规则检查没有发现结构化数据或执行状态异常。', conversationId: conversation.id });
    return findings;
  }

  private async audit(actorId: number, action: string, targetType: string, targetId: string, details: JsonRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`, [actorId, action, targetType, targetId, JSON.stringify(details)],
    );
  }
}

function emptyMetrics(): DebugMetrics {
  return { messageCount: 0, userMessageCount: 0, assistantMessageCount: 0, runCount: 0, failedRunCount: 0, activeRunCount: 0, traceCount: 0, failedTraceCount: 0, refusedTraceCount: 0, toolCallCount: 0, modelCallCount: 0, totalDurationMs: 0, totalTokens: 0 };
}

function metricsFor(conversation: DebugConversation): DebugMetrics {
  const metrics = emptyMetrics();
  metrics.messageCount = conversation.messages.length;
  metrics.userMessageCount = conversation.messages.filter((message) => message.role === 'user').length;
  metrics.assistantMessageCount = conversation.messages.filter((message) => message.role === 'assistant').length;
  metrics.runCount = conversation.runs.length;
  metrics.failedRunCount = conversation.runs.filter((run) => run.status === 'failed').length;
  metrics.activeRunCount = conversation.runs.filter((run) => ['queued', 'running'].includes(run.status)).length;
  metrics.traceCount = conversation.traces.length;
  metrics.failedTraceCount = conversation.traces.filter((trace) => trace.status === 'failed').length;
  metrics.refusedTraceCount = conversation.traces.filter((trace) => trace.refused === true).length;
  metrics.totalDurationMs = conversation.traces.reduce((sum, trace) => sum + trace.durationMs, 0);
  metrics.totalTokens = conversation.traces.reduce((sum, trace) => sum + (trace.totalTokens ?? 0), 0);
  for (const trace of conversation.traces) {
    const context = asRecord(trace.contextSnapshot);
    metrics.toolCallCount += asArray(context.toolCalls).length;
    metrics.modelCallCount += asArray(context.modelCalls).length;
  }
  return metrics;
}

function sumMetrics(items: DebugMetrics[]): DebugMetrics {
  return items.reduce((sum, item) => {
    for (const key of Object.keys(sum) as Array<keyof DebugMetrics>) sum[key] += item[key];
    return sum;
  }, emptyMetrics());
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function looksLikeToolIntent(value: string | null): boolean {
  if (!value) return false;
  return /"type"\s*:\s*"tool"/u.test(value) || /<｜｜DSML｜｜\s*(?:calls|invoke)/u.test(value);
}
