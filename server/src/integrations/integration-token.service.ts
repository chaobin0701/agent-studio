import { ForbiddenException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResult } from "pg";
import { DatabaseService } from "../database.service";
import type { LlmRequest, LlmUsage } from "../ai/providers/provider.types";
import { ProviderError } from "../ai/providers/provider-errors";
import {
  modelInputReservation,
  type ModelCallAccounting,
  type ModelCallPurpose,
} from "../chat/model-call-accounting";
import { quotaExceeded } from "./quota-error";
import type { PublicAgentResult } from "./integration.types";
import {
  applicationLimit,
  type ApplicationLimitSettings,
} from "./application-limits";
import { workspaceAccess } from "../workspaces/workspace-access";
import { currentWorkspaceId } from "../workspaces/workspace-context";

export const DAY_START =
  "date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'";
export const DAY_END =
  "(date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') + interval '1 day') AT TIME ZONE 'Asia/Shanghai'";
const quotaDay = "(now() AT TIME ZONE 'Asia/Shanghai')::date";
const consumed =
  "CASE WHEN m.usage_status='reserved' AND m.expires_at<=now() THEN m.reserved_tokens ELSE m.total_tokens END";
const reserved =
  "CASE WHEN m.usage_status='reserved' AND m.expires_at>now() THEN m.reserved_tokens ELSE 0 END";
const incomplete =
  "(m.usage_status IN ('unknown','legacy') OR (m.usage_status='reserved' AND m.expires_at<=now()))";
const validToken = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
type QueryConnection = {
  query: (statement: string, values?: unknown[]) => Promise<QueryResult>;
};

@Injectable()
export class IntegrationTokenService {
  constructor(private readonly db: DatabaseService) {}

  accounting(appId: string | null, callId: string): ModelCallAccounting {
    return {
      reserve: (request, purpose) =>
        this.reserve(appId, callId, request, purpose),
    };
  }

  async daily(
    appId: string,
    owner?: string,
    connection: QueryConnection = this.db,
  ) {
    const result = await connection.query(
      `SELECT ${DAY_START} AS "startAt", ${DAY_END} AS "resetAt",
      COALESCE(sum(${consumed}),0)::float8 AS "totalTokens",
      COALESCE(sum(${reserved}),0)::float8 AS "reservedTokens",
      COALESCE(sum(m.input_tokens),0)::float8 AS "inputTokens",
      COALESCE(sum(m.output_tokens),0)::float8 AS "outputTokens",
      count(*) FILTER(WHERE ${incomplete})::int AS "unknownModelCalls"
      FROM integration_model_calls m JOIN integration_calls c ON c.id=m.call_id
      WHERE m.app_id=$1 AND m.quota_day=${quotaDay} AND ($2::uuid IS NULL OR c.visitor_session_id=$2)`,
      [appId, owner ?? null],
    );
    const row = result.rows[0];
    return {
      ...row,
      startAt: new Date(row.startAt).toISOString(),
      resetAt: new Date(row.resetAt).toISOString(),
      timezone: "Asia/Shanghai" as const,
    };
  }

  async callUsage(
    callId: string,
    connection: QueryConnection = this.db,
  ): Promise<NonNullable<PublicAgentResult["usage"]>> {
    const result = await connection.query(
      `SELECT COALESCE(sum(${consumed}),0)::float8 AS "totalTokens",
      COALESCE(sum(${reserved}),0)::float8 AS "reservedTokens",
      COALESCE(sum(m.input_tokens),0)::float8 AS "inputTokens", COALESCE(sum(m.output_tokens),0)::float8 AS "outputTokens",
      count(*) FILTER(WHERE ${incomplete})::int AS "unknownModelCalls",
      COALESCE(bool_or(m.purpose='summary'),false) AS "includesSummary"
      FROM integration_model_calls m WHERE m.call_id=$1`,
      [callId],
    );
    const row = result.rows[0];
    return {
      ...row,
      accounting: row.unknownModelCalls
        ? "incomplete"
        : row.reservedTokens
          ? "pending"
          : "actual",
    };
  }

  private async reserve(
    appId: string | null,
    callId: string,
    request: LlmRequest,
    purpose: ModelCallPurpose,
  ) {
    // Reserve the full configured output, rather than silently shortening answers
    // when the day budget is nearly exhausted. No per-request quota is introduced.
    const amount = modelInputReservation(request) + (request.maxTokens ?? 1200);
    const id = randomUUID();
    await this.db.transaction(async (client) => {
      if (appId === null) {
        const call = (
          await client.query<{ adminId: number; agentId: number }>(
            `SELECT admin_actor_id::int AS "adminId",entry_agent_id::int AS "agentId" FROM integration_calls WHERE id=$1 AND app_id IS NULL AND status='running' AND expires_at>now() FOR UPDATE`,
            [callId],
          )
        ).rows[0];
        if (!call) throw new ForbiddenException("当前管理员请求已结束");
        const codes = (
          await workspaceAccess(this.db, call.adminId, currentWorkspaceId())
        ).permissionCodes;
        if (!codes.includes("agent_chat.use"))
          throw new ForbiddenException("Agent 对话权限已撤销");
        const agent = await client.query(
          `SELECT 1 FROM agent_resources WHERE id=$1 AND kind='agent' AND enabled AND deleted_at IS NULL AND archived_at IS NULL`,
          [call.agentId],
        );
        if (!agent.rowCount) throw new ForbiddenException("Agent 已停用");
        await client.query(
          "INSERT INTO integration_model_calls(id,call_id,app_id,purpose,model,usage_status,reserved_tokens) VALUES($1,$2,NULL,$3,$4,'reserved',$5)",
          [id, callId, purpose, request.model, amount],
        );
        return;
      }
      const found = await client.query<{
        enabled: boolean;
        dailyTokenLimit: string | null;
        limitSettings?: ApplicationLimitSettings;
      }>(
        'SELECT enabled,daily_token_limit AS "dailyTokenLimit",limit_settings AS "limitSettings" FROM integration_apps WHERE id=$1 FOR UPDATE',
        [appId],
      );
      const app = found.rows[0];
      if (!app?.enabled) throw new ForbiddenException("接入应用已停用");
      const call = await client.query(
        "SELECT id FROM integration_calls WHERE id=$1 AND app_id=$2 AND (status='running' OR ($3='summary' AND status='completed'))",
        [callId, appId, purpose],
      );
      if (!call.rowCount)
        throw new ForbiddenException("当前请求已结束，不能继续调用模型");
      // Expiry frees execution slots, NOT unknown provider costs. A late actual
      // usage response may still reconcile this row because settled_at stays null.
      await client.query(
        "UPDATE integration_model_calls SET usage_status='unknown',total_tokens=reserved_tokens WHERE app_id=$1 AND usage_status='reserved' AND expires_at<=now()",
        [appId],
      );
      const today = await this.daily(appId, undefined, client);
      const tokenLimit = applicationLimit(app, "dailyTokenLimit");
      if (
        tokenLimit !== null &&
        today.totalTokens + today.reservedTokens + amount > tokenLimit
      ) {
        const temporarilyReserved = today.totalTokens + amount <= tokenLimit;
        throw quotaExceeded(
          temporarilyReserved
            ? "token_budget_reserved"
            : "daily_token_budget_insufficient",
          temporarilyReserved
            ? "Token 额度暂被其他请求占用，请稍后再试。"
            : "今日剩余 Token 额度不足，请稍后再试或联系管理员调整配额。",
          temporarilyReserved
            ? new Date(Date.now() + 10000).toISOString()
            : today.resetAt,
        );
      }
      await client.query(
        "INSERT INTO integration_model_calls(id,call_id,app_id,purpose,model,usage_status,reserved_tokens) VALUES($1,$2,$3,$4,$5,'reserved',$6)",
        [id, callId, appId, purpose, request.model, amount],
      );
    });
    return {
      settle: (usage: LlmUsage | null, error?: unknown) =>
        this.settle(appId, callId, id, amount, usage, error),
    };
  }

  private async settle(
    appId: string | null,
    callId: string,
    id: string,
    amount: number,
    usage: LlmUsage | null,
    error?: unknown,
  ) {
    const input = validToken(usage?.inputTokens),
      output = validToken(usage?.outputTokens);
    const rawTotal = validToken(usage?.totalTokens);
    const knownSum =
      input === null && output === null ? null : (input ?? 0) + (output ?? 0);
    const reported =
      rawTotal !== null
        ? Math.max(rawTotal, knownSum ?? 0)
        : input !== null && output !== null
          ? input + output
          : null;
    // These failures definitively reject generation. Transport failures and
    // malformed successful responses are NOT known to be free.
    const rejected =
      error instanceof ProviderError &&
      [
        "provider_authentication",
        "provider_rate_limit",
        "provider_context_length",
        "provider_model_not_found",
        "provider_unsupported_response_format",
      ].includes(error.code);
    const total = reported ?? (rejected ? 0 : amount);
    const status =
      rejected || (reported !== null && input !== null && output !== null)
        ? "actual"
        : "unknown";
    await this.db.transaction(async (client) => {
      if (appId === null)
        await client.query(
          "SELECT id FROM integration_calls WHERE id=$1 FOR UPDATE",
          [callId],
        );
      else
        await client.query(
          "SELECT id FROM integration_apps WHERE id=$1 FOR UPDATE",
          [appId],
        );
      await client.query(
        "UPDATE integration_model_calls SET usage_status=$2,total_tokens=$3,input_tokens=$4,output_tokens=$5,settled_at=now() WHERE id=$1 AND settled_at IS NULL",
        [id, status, total, input, output],
      );
      await this.syncCall(client, callId);
    });
  }

  async syncCall(client: PoolClient, callId: string) {
    await client.query(
      `UPDATE integration_calls SET total_tokens=s.total,input_tokens=s.input,output_tokens=s.output,unknown_model_calls=s.unknown
      FROM (SELECT COALESCE(sum(${consumed}),0)::bigint AS total, COALESCE(sum(m.input_tokens),0)::bigint AS input,
        COALESCE(sum(m.output_tokens),0)::bigint AS output, count(*) FILTER(WHERE ${incomplete})::int AS unknown
        FROM integration_model_calls m WHERE m.call_id=$1) s WHERE integration_calls.id=$1`,
      [callId],
    );
  }
}
