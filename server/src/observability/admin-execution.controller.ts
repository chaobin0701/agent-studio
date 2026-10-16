import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
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
import { recordedPhoenixLink } from "./phoenix-link";

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

  @Get(":id/phoenix")
  @RequirePermission("observability.external.read")
  async external(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: AdminRequest,
  ) {
    // One local Phoenix collector can span multiple application workspaces. Link access
    // requires a global grant AND the selected workspace's trace-read grant.
    if (!request.workspacePermissionCodes?.includes("conversations.read"))
      throw new ForbiddenException("没有此工作空间的执行记录权限");
    const row = await this.find(id);
    const snapshot = row.contextSnapshot as Record<string, unknown> | null;
    return recordedPhoenixLink(snapshot?.phoenix, this.config.tracing);
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
