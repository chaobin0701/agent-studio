import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Optional,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { PermissionGuard } from "../admin/permission.guard";
import { RequirePermission } from "../admin/permission.decorator";
import type { AdminRequest } from "../admin/admin.types";
import { DatabaseService } from "../database.service";
import { AppConfigService } from "../config/config.service";
import { executionContextView } from "./execution-view";
import { LangSmithLinkService, recordedLangSmithLink } from "./langsmith-link";

const columns = `id, kind, conversation_id AS "conversationId", question, final_answer AS "finalAnswer", refused, status, error_code AS "errorCode", input_tokens AS "inputTokens", output_tokens AS "outputTokens", total_tokens AS "totalTokens", duration_ms AS "durationMs", created_at AS "createdAt"`;
function integer(value: string | undefined, defaultValue: number, max: number) {
  if (value === undefined) return defaultValue;
  if (
    typeof value !== "string" ||
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > max
  )
    throw new BadRequestException("查询参数无效");
  return Number(value);
}

@Controller("admin/executions")
@UseGuards(AdminAuthGuard, PermissionGuard)
export class AdminExecutionController {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
    @Optional() private readonly externalLinks?: LangSmithLinkService,
  ) {}

  @Get()
  @RequirePermission("conversations.read")
  async list(
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("agentId") agentId?: string,
    @Query("status") status?: string,
  ) {
    const currentPage = integer(page, 1, 100000),
      size = integer(pageSize, 20, 100);
    const selectedAgent =
      agentId === undefined
        ? null
        : String(integer(agentId, 1, Number.MAX_SAFE_INTEGER));
    if (status !== undefined && !["completed", "failed"].includes(status))
      throw new BadRequestException("执行状态无效");
    const where = `WHERE ($1::text IS NULL OR context_snapshot->'agentComposition'->>'agentId'=$1) AND ($2::text IS NULL OR status=$2)`;
    const values = [selectedAgent, status ?? null];
    const [rows, count] = await Promise.all([
      this.database.query(
        `SELECT ${columns}, context_snapshot->'agentComposition'->>'agentId' AS "agentId", context_snapshot->>'executionEngine' AS engine FROM chat_traces ${where} ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,
        [...values, size, (currentPage - 1) * size],
      ),
      this.database.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM chat_traces ${where}`,
        values,
      ),
    ]);
    return {
      items: rows.rows,
      total: count.rows[0]?.total ?? 0,
      page: currentPage,
      pageSize: size,
    };
  }

  @Get(":id")
  @RequirePermission("conversations.read")
  async detail(@Param("id", ParseUUIDPipe) id: string) {
    const row = await this.find(id);
    const { contextSnapshot, ...trace } = row;
    return { ...trace, execution: executionContextView(contextSnapshot) };
  }

  @Get(":id/conversation")
  @RequirePermission("conversations.read")
  async conversation(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    const requestedPage = page === undefined ? undefined : integer(page, 1, 100000);
    const size = integer(pageSize, 10, 50);
    const trace = await this.find(id);
    if (!trace.conversationId) return { conversation: null, items: [], total: 0, page: 1, pageSize: size };
    const conversation = (await this.database.query(
      `SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM conversations WHERE id=$1`, [trace.conversationId],
    )).rows[0];
    if (!conversation) throw new NotFoundException("会话不存在");

    // Read the saved conversation, not raw runtime state. Failed attempts without
    // saved messages stay in the timeline; turns without a Trace remain readable.
    const timeline = `WITH timeline AS (
      SELECT 'message:' || lpad(m.id::text, 20, '0') AS key, m.id::int AS "userMessageId",
             m.content AS question, a.content AS "finalAnswer", a.refused,
             t.id AS "traceId", COALESCE(t.status, 'completed') AS status,
             t.error_code AS "errorCode", t.total_tokens AS "totalTokens",
             t.duration_ms AS "durationMs", m.created_at AS "createdAt"
      FROM conversation_messages m
      LEFT JOIN LATERAL (
        SELECT role, content, refused FROM conversation_messages
        WHERE conversation_id=m.conversation_id AND id>m.id ORDER BY id LIMIT 1
      ) a ON a.role='assistant'
      LEFT JOIN LATERAL (
        SELECT id, status, error_code, total_tokens, duration_ms FROM chat_traces
        WHERE conversation_id=m.conversation_id AND user_message_id=m.id AND kind='answer'
        ORDER BY created_at DESC, id DESC LIMIT 1
      ) t ON true
      WHERE m.conversation_id=$1 AND m.role='user'
      UNION ALL
      SELECT 'trace:' || id, NULL::int, question, final_answer, refused, id,
             status, error_code, total_tokens, duration_ms, created_at
      FROM chat_traces
      WHERE conversation_id=$1 AND kind='answer' AND status='failed' AND user_message_id IS NULL
    )`;
    const count = (await this.database.query<{ total: number; beforeCurrent: number }>(
      `${timeline} SELECT count(*)::int AS total,
        count(*) FILTER (WHERE ("createdAt", key) < (
          SELECT "createdAt", key FROM timeline WHERE "traceId"=$2
        ))::int AS "beforeCurrent" FROM timeline`, [trace.conversationId, id],
    )).rows[0];
    const currentPage = requestedPage ?? Math.floor((count?.beforeCurrent ?? 0) / size) + 1;
    const items = await this.database.query(
      `${timeline} SELECT * FROM timeline ORDER BY "createdAt", key LIMIT $2 OFFSET $3`,
      [trace.conversationId, size, (currentPage - 1) * size],
    );
    return { conversation, items: items.rows, total: count?.total ?? 0, page: currentPage, pageSize: size };
  }

  @Get(":id/external-trace")
  @RequirePermission("observability.external.read")
  async external(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: AdminRequest,
  ) {
    // External tracing can span multiple application workspaces. Link access
    // requires a global grant AND the selected workspace's trace-read grant.
    if (!request.workspacePermissionCodes?.includes("conversations.read"))
      throw new ForbiddenException("没有此工作空间的执行记录权限");
    const row = await this.find(id);
    const snapshot = row.contextSnapshot as Record<string, unknown> | null;
    return this.externalLinks
      ? this.externalLinks.resolve(snapshot?.externalTrace)
      : recordedLangSmithLink(snapshot?.externalTrace, this.config.tracing);
  }

  private async find(id: string) {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT ${columns},context_snapshot AS "contextSnapshot" FROM chat_traces WHERE id=$1`,
      [id],
    );
    if (!result.rows[0]) throw new NotFoundException("执行记录不存在");
    return result.rows[0];
  }
}
