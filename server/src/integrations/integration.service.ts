import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Request } from "express";
import { DatabaseService } from "../database.service";
import { AppConfigService } from "../config/config.service";
import { IntegrationAppDto, IntegrationKeyDto } from "./integration.dto";
import {
  INTERNAL_APP_ID,
  type AccessScope,
  type IntegrationApp,
  type IntegrationIdentity,
  type IntegrationCallResult,
  type PublicAgentResult,
} from "./integration.types";
import {
  DAY_START,
  IntegrationTokenService,
} from "./integration-token.service";
import {
  contextFingerprint,
  type RequestContext,
} from "../chat/request-context";
import { quotaExceeded } from "./quota-error";
import { lifecycleWriteLock } from "../agent-management/resource-lifecycle";
import { selectWorkspace } from "../workspaces/workspace-context";
import { workspaceAccess } from "../workspaces/workspace-access";
import { currentWorkspaceId } from "../workspaces/workspace-context";
import {
  applicationLimit,
  APPLICATION_SAFETY,
  DISABLED_APPLICATION_LIMITS,
} from "./application-limits";

// Server-created administrative identity; never accepted from public API bodies.
type ManagedTestIdentity = {
  kind: "admin";
  actorId: number;
  app: IntegrationApp;
  scopes: AccessScope[];
  keyId?: never;
  source: "workflow_test" | "agent_preview";
};

const APP_COLUMNS = `workspace_id::int AS "workspaceId",agent_id::int AS "agentId",environment,id, name, enabled, website_enabled AS "websiteEnabled", api_enabled AS "apiEnabled",
  allowed_origins AS "allowedOrigins", scopes, requests_per_minute AS "requestsPerMinute", concurrency,
  daily_requests AS "dailyRequests", daily_token_limit::float8 AS "dailyTokenLimit", limit_settings AS "limitSettings", auth_version AS "authVersion", is_internal AS "isInternal",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const KEY_COLUMNS = `id, name, masked_key AS "maskedKey", scopes, expires_at AS "expiresAt",
  revoked_at AS "revokedAt", last_used_at AS "lastUsedAt", created_at AS "createdAt"`;
const WIDGET_AUDIENCE = "agent-studio-widget";
export const credentialHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function browserOrigin(request: Request): string | undefined {
  if (request.headers.origin) return request.headers.origin;
  // Same-origin GET fetches omit Origin. Require browser Fetch Metadata before inferring it.
  if (request.headers["sec-fetch-site"] !== "same-origin") return undefined;
  try {
    return request.headers.referer
      ? new URL(request.headers.referer).origin
      : `${request.protocol}://${request.get("host")}`;
  } catch {
    return undefined;
  }
}

export function canonicalOrigin(value: string): string {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.hostname.includes("*") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new BadRequestException(
      "域名必须是完整 HTTPS Origin（协议、主机、端口）；本地开发允许 HTTP localhost。",
    );
  }
}

@Injectable()
export class IntegrationService implements OnModuleInit {
  // Bootstrap is deliberately bounded independently of expensive Agent requests.
  private readonly bootstrapWindows = new Map<
    string,
    { count: number; until: number }
  >();
  private readonly inspectionWindows = new Map<
    string,
    { count: number; until: number }
  >();
  readonly tokens: IntegrationTokenService;
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    @Optional() tokens?: IntegrationTokenService,
  ) {
    this.tokens = tokens ?? new IntegrationTokenService(db);
  }

  async onModuleInit() {
    // Initialize only the migration-created row. Subsequent administrator choices, including [], are authoritative.
    const origins = this.config.security.allowedOrigins.map(canonicalOrigin);
    await this.db.query(
      `UPDATE integration_apps SET allowed_origins = $1 WHERE id = $2 AND auth_version = 1 AND allowed_origins = '{}'`,
      [origins, INTERNAL_APP_ID],
    );
  }

  async app(id: string): Promise<IntegrationApp> {
    const result = await this.db.query<IntegrationApp>(
      `SELECT ${APP_COLUMNS} FROM integration_apps WHERE id = $1`,
      [id],
    );
    if (!result.rows[0]) throw new NotFoundException("接入应用不存在");
    return result.rows[0];
  }

  async agentOptions() {
    const resources = (
      await this.db.query(
        "SELECT id::int,kind,resource_key AS key,name,enabled,current_version_id::int AS \"currentVersionId\" FROM agent_resources WHERE kind='agent' AND archived_at IS NULL AND deleted_at IS NULL",
      )
    ).rows;
    const bindings = resources
      .filter((r) => r.currentVersionId)
      .flatMap((r) =>
        ["dev", "test", "prod"].map((environment) => ({
          agentId: r.id,
          environment,
          versionId: r.currentVersionId,
        })),
      );
    return { resources, bindings };
  }

  private async authenticatedApp(id: string): Promise<IntegrationApp> {
    const app = (
      await this.db.platformQuery<IntegrationApp>(
        `SELECT ${APP_COLUMNS} FROM integration_apps WHERE id=$1 AND EXISTS(SELECT 1 FROM workspaces WHERE id=integration_apps.workspace_id AND enabled)`,
        [id],
      )
    ).rows[0];
    if (!app) throw new NotFoundException("接入应用不存在或工作空间已停用");
    selectWorkspace(app.workspaceId);
    return app;
  }

  async list() {
    const result = await this.db.query<IntegrationApp>(
      `SELECT ${APP_COLUMNS} FROM integration_apps ORDER BY is_internal DESC, created_at DESC LIMIT 200`,
    );
    return result.rows;
  }

  async save(actor: number, input: IntegrationAppDto, id?: string) {
    const name = input.name.trim();
    if (!name) throw new BadRequestException("请输入应用名称");
    const origins = [...new Set(input.allowedOrigins.map(canonicalOrigin))];
    if (input.websiteEnabled && !origins.length)
      throw new BadRequestException("网站接入至少需要一个授权 Origin");
    if (!input.scopes.length)
      throw new BadRequestException("至少选择一个接入权限");
    const appId = id ?? randomUUID();
    await this.db.transaction(async (client) => {
      await lifecycleWriteLock(client);
      // An explicit, quota-governed administrative trial app can target a new draft.
      // Public channels still require the current published version. This does not
      // make drafts addressable by API keys or website identities.
      const previewOnly = !input.websiteEnabled && !input.apiEnabled;
      const agent = (
        await client.query(
          `SELECT r.id FROM agent_resources r
        WHERE r.id=$1 AND r.kind='agent' AND r.enabled AND r.archived_at IS NULL AND r.deleted_at IS NULL
        AND (EXISTS(SELECT 1 FROM agent_resource_versions v WHERE v.id=r.current_version_id AND v.resource_id=r.id AND v.status='published')
          OR ($2::boolean AND EXISTS(SELECT 1 FROM agent_resource_versions v WHERE v.resource_id=r.id AND v.status='draft')))
        FOR SHARE OF r`,
          [input.agentId, previewOnly],
        )
      ).rows[0];
      if (!agent)
        throw new BadRequestException(
          "请选择启用的 Agent；未发布的 Agent 仅允许后台试运行，不能开启网站或 API 接入",
        );
      let dailyTokenLimit = input.dailyTokenLimit;
      let limitSettings = input.limitSettings ?? {
        ...DISABLED_APPLICATION_LIMITS,
      };
      if (id) {
        const found = await client.query(
          "SELECT id,daily_token_limit,limit_settings FROM integration_apps WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!found.rowCount) throw new NotFoundException("接入应用不存在");
        if (dailyTokenLimit === undefined)
          dailyTokenLimit = found.rows[0].daily_token_limit;
        if (!input.limitSettings)
          limitSettings = found.rows[0].limit_settings ?? {
            requestsPerMinute: true,
            concurrency: true,
            dailyRequests: true,
            dailyTokenLimit: dailyTokenLimit != null,
          };
      } else {
        const count = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM integration_apps",
        );
        if (count.rows[0].count >= 200)
          throw new BadRequestException("接入应用数量已达上限");
        await client.query(
          "INSERT INTO integration_apps(id, name,agent_id,environment) VALUES ($1,$2,$3,$4)",
          [appId, name, input.agentId, "prod"],
        );
      }
      if (!input.limitSettings && input.dailyTokenLimit === null)
        limitSettings = { ...limitSettings, dailyTokenLimit: false };
      if (limitSettings.dailyTokenLimit && !dailyTokenLimit)
        throw new BadRequestException(
          "开启每日 Token 限制后，请填写有效的上限",
        );
      await client.query(
        `UPDATE integration_apps SET name=$2, enabled=$3, website_enabled=$4, api_enabled=$5,
        allowed_origins=$6, scopes=$7, requests_per_minute=$8, concurrency=$9, daily_requests=$10,
        daily_token_limit=$11,agent_id=$12,environment=$13,limit_settings=$14::jsonb, auth_version=auth_version+1, updated_at=now() WHERE id=$1`,
        [
          appId,
          name,
          input.enabled,
          input.websiteEnabled,
          input.apiEnabled,
          origins,
          input.scopes,
          input.requestsPerMinute,
          input.concurrency,
          input.dailyRequests,
          dailyTokenLimit ?? null,
          input.agentId,
          "prod",
          JSON.stringify(limitSettings),
        ],
      );
      await this.audit(
        client,
        actor,
        id ? "integration.updated" : "integration.created",
        appId,
        {
          name,
          allowedOrigins: origins,
          scopes: input.scopes,
          enabled: input.enabled,
          dailyTokenLimit: dailyTokenLimit ?? null,
          limitSettings,
        },
      );
    });
    return this.app(appId);
  }

  async detail(id: string) {
    const app = await this.app(id);
    const keys = await this.db.query(
      `SELECT ${KEY_COLUMNS} FROM integration_api_keys WHERE app_id=$1 ORDER BY created_at DESC`,
      [id],
    );
    const usage = await this.db.query(
      `SELECT count(*)::int AS requests,
      count(*) FILTER(WHERE status='completed')::int AS completed,
      count(*) FILTER(WHERE status IN ('failed','expired'))::int AS failed,
      count(*) FILTER(WHERE status='running' AND expires_at > now())::int AS running,
      COALESCE(sum(total_tokens),0)::bigint::text AS "totalTokens"
      FROM integration_calls WHERE app_id=$1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`,
      [id],
    );
    const recent = await this.db.query(
      `SELECT id, status, conversation_id AS "conversationId", run_id AS "runId", trace_id AS "traceId",
      total_tokens AS "totalTokens", created_at AS "createdAt", finished_at AS "finishedAt",
      round(extract(epoch FROM (finished_at-created_at))*1000)::int AS "durationMs"
      FROM integration_calls WHERE app_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [id],
    );
    const tokenUsage = await this.tokens.daily(id);
    const tokenLimit = applicationLimit(app, "dailyTokenLimit");
    return {
      app,
      keys: keys.rows,
      usage: {
        ...usage.rows[0],
        ...tokenUsage,
        tokenLimit,
        remainingTokens:
          tokenLimit === null
            ? null
            : Math.max(
                0,
                tokenLimit - tokenUsage.totalTokens - tokenUsage.reservedTokens,
              ),
      },
      recent: recent.rows,
    };
  }

  async createKey(
    actor: number,
    appId: string,
    input: IntegrationKeyDto,
    rotateId?: string,
  ) {
    const raw = `ag_live_${randomBytes(32).toString("base64url")}`;
    const keyId = randomUUID();
    const masked = `${raw.slice(0, 12)}…${raw.slice(-4)}`;
    await this.db.transaction(async (client) => {
      await lifecycleWriteLock(client);
      const found = await client.query<IntegrationApp>(
        `SELECT ${APP_COLUMNS} FROM integration_apps WHERE id=$1 FOR UPDATE`,
        [appId],
      );
      const app = found.rows[0];
      if (!app) throw new NotFoundException("接入应用不存在");
      if (
        !input.name.trim() ||
        !input.scopes.length ||
        input.scopes.some((s) => !app.scopes.includes(s))
      )
        throw new BadRequestException("密钥权限必须是应用权限的子集");
      if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now())
        throw new BadRequestException("过期时间必须在未来");
      if (rotateId) {
        const old = await client.query(
          `UPDATE integration_api_keys SET revoked_at=now() WHERE id=$1 AND app_id=$2 AND revoked_at IS NULL RETURNING id`,
          [rotateId, appId],
        );
        if (!old.rowCount)
          throw new NotFoundException("待轮换的有效密钥不存在");
      }
      const count = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM integration_api_keys WHERE app_id=$1 AND revoked_at IS NULL",
        [appId],
      );
      if (count.rows[0].count >= 30)
        throw new BadRequestException("每个应用最多保留 30 个未撤销密钥");
      await client.query(
        `INSERT INTO integration_api_keys(id,app_id,name,secret_hash,masked_key,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          keyId,
          appId,
          input.name.trim(),
          credentialHash(raw),
          masked,
          input.scopes,
          input.expiresAt ?? null,
        ],
      );
      await this.audit(
        client,
        actor,
        rotateId ? "integration.key_rotated" : "integration.key_created",
        appId,
        { keyId, replacedKeyId: rotateId, scopes: input.scopes },
      );
    });
    // Never stored as plaintext; this is the only response containing the complete credential.
    return { id: keyId, apiKey: raw, maskedKey: masked };
  }

  async revokeKey(actor: number, appId: string, id: string) {
    await this.db.transaction(async (client) => {
      await lifecycleWriteLock(client);
      const found = await client.query(
        "UPDATE integration_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE app_id=$1 AND id=$2 RETURNING id",
        [appId, id],
      );
      if (!found.rowCount) throw new NotFoundException("密钥不存在");
      await this.audit(client, actor, "integration.key_revoked", appId, {
        keyId: id,
      });
    });
    return { revoked: true };
  }

  async allowedOrigin(origin: string) {
    // CORS only decides which browser can read a response; the guards still authenticate every request.
    const result = await this.db.platformQuery(
      "SELECT id FROM integration_apps WHERE enabled AND website_enabled AND $1=ANY(allowed_origins) AND EXISTS(SELECT 1 FROM workspaces WHERE id=workspace_id AND enabled) LIMIT 1",
      [origin],
    );
    return Boolean(result.rowCount);
  }

  assertScope(
    identity: Pick<IntegrationIdentity, "app" | "scopes">,
    scope: AccessScope,
  ) {
    if (
      !identity.scopes.includes(scope) ||
      !identity.app.scopes.includes(scope)
    )
      throw new ForbiddenException("此接入凭证没有所需权限");
  }

  async websiteApp(id: string, origin: string | undefined) {
    const app = await this.authenticatedApp(id);
    if (
      !app.enabled ||
      !app.websiteEnabled ||
      !origin ||
      !app.allowedOrigins.includes(origin)
    )
      throw new ForbiddenException("网站未获得此应用的访问授权");
    return app;
  }

  async authenticate(request: Request): Promise<IntegrationIdentity> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer "))
      throw new UnauthorizedException("需要接入令牌");
    const raw = authorization.slice(7);
    if (raw.startsWith("ag_live_")) {
      // Long-lived credentials are server-side only. Browser integrations must use visitor tokens.
      if (request.headers.origin || request.headers["sec-fetch-site"])
        throw new ForbiddenException(
          "浏览器请使用访客令牌，不要传入平台 API Key",
        );
      const result = await this.db.platformQuery<{
        id: string;
        appId: string;
        scopes: AccessScope[];
      }>(
        `SELECT id, app_id AS "appId", scopes FROM integration_api_keys
        WHERE secret_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`,
        [credentialHash(raw)],
      );
      const key = result.rows[0];
      if (!key) throw new UnauthorizedException("密钥无效或已过期");
      const app = await this.authenticatedApp(key.appId);
      if (!app.enabled || !app.apiEnabled)
        throw new ForbiddenException("平台接入已停用");
      await this.db.query(
        "UPDATE integration_api_keys SET last_used_at=now() WHERE id=$1",
        [key.id],
      );
      return {
        app,
        scopes: key.scopes.filter((s) => app.scopes.includes(s)),
        keyId: key.id,
        kind: "api",
      };
    }
    let payload: {
      sub: string;
      appId: string;
      version: number;
      origin: string;
      purpose: string;
    };
    try {
      payload = await this.jwt.verifyAsync(raw, {
        audience: WIDGET_AUDIENCE,
        issuer: this.config.jwt.issuer,
        algorithms: ["HS256"],
      });
    } catch {
      throw new UnauthorizedException("访客令牌无效或已过期");
    }
    if (payload.purpose !== "widget" || !payload.appId || !payload.sub)
      throw new UnauthorizedException("令牌用途无效");
    const origin = browserOrigin(request);
    const app = await this.websiteApp(payload.appId, origin);
    if (payload.origin !== origin || payload.version !== app.authVersion)
      throw new UnauthorizedException("网站授权已变更，请重新获取访客令牌");
    const owner = await this.db.query(
      "SELECT id FROM visitor_sessions WHERE id=$1 AND application_id=$2 AND external_user_id IS NULL AND credential_expires_at>now()",
      [payload.sub, app.id],
    );
    if (!owner.rowCount) throw new UnauthorizedException("访客会话已过期");
    return { app, scopes: app.scopes, ownerId: payload.sub, kind: "website" };
  }

  async widgetSession(
    request: Request,
    appId = INTERNAL_APP_ID,
    resumeToken?: string,
  ) {
    this.checkVisitorBootstrap(
      request.ip || request.socket.remoteAddress || "unknown",
    );
    const origin = browserOrigin(request);
    const app = await this.websiteApp(appId, origin);
    let raw = resumeToken;
    let owner: string | undefined;
    if (raw && /^[a-f0-9]{64}$/i.test(raw)) {
      const existing = await this.db.query<{ id: string }>(
        "SELECT id FROM visitor_sessions WHERE application_id=$1 AND token_hash=$2 AND external_user_id IS NULL AND credential_expires_at>now()",
        [appId, credentialHash(raw)],
      );
      owner = existing.rows[0]?.id;
    }
    if (!owner) {
      raw = randomBytes(32).toString("hex");
      owner = randomUUID();
      await this.db.query(
        `INSERT INTO visitor_sessions(id,token_hash,application_id,client_type,credential_expires_at) VALUES($1,$2,$3,'browser',now()+interval '7 days')`,
        [owner, credentialHash(raw!), appId],
      );
    } else
      await this.db.query(
        "UPDATE visitor_sessions SET last_seen_at=now(), credential_expires_at=now()+interval '7 days' WHERE id=$1",
        [owner],
      );
    const accessToken = await this.jwt.signAsync(
      {
        sub: owner,
        appId,
        purpose: "widget",
        version: app.authVersion,
        origin,
      },
      {
        audience: WIDGET_AUDIENCE,
        issuer: this.config.jwt.issuer,
        expiresIn: "15m",
        algorithm: "HS256",
      },
    );
    return { appId, accessToken, resumeToken: raw!, expiresIn: 900 };
  }

  async platformOwner(identity: IntegrationIdentity, userId?: string) {
    if (identity.kind === "website") {
      if (userId)
        throw new BadRequestException(
          "网站访客身份由令牌确定，不能指定 userId",
        );
      return identity.ownerId!;
    }
    const user = userId?.trim();
    if (!user || user.length > 128 || /[\x00-\x1f]/u.test(user))
      throw new BadRequestException("平台调用必须提供有效 userId");
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO visitor_sessions(id,token_hash,application_id,external_user_id,client_type)
      VALUES($1,$2,$3,$4,'api') ON CONFLICT(application_id,external_user_id) WHERE external_user_id IS NOT NULL
      DO UPDATE SET last_seen_at=now() RETURNING id`,
      [
        randomUUID(),
        credentialHash(randomBytes(32).toString("hex")),
        identity.app.id,
        user,
      ],
    );
    return result.rows[0].id;
  }

  async admit(
    identity: IntegrationIdentity,
    owner: string,
    conversationId: string | undefined,
    question: string,
    idempotencyKey?: string,
    context?: RequestContext,
  ) {
    const admission = await this.admitInvocation<PublicAgentResult>(
      identity,
      owner,
      conversationId,
      question,
      idempotencyKey,
      context,
    );
    if (!admission.conversationId)
      throw new Error("Conversation admission is missing its target");
    return { ...admission, conversationId: admission.conversationId };
  }

  /** Same authorization/quota/idempotency authority as Chat; no implicit conversation. */
  admitRun<R extends IntegrationCallResult>(
    identity: IntegrationIdentity,
    owner: string,
    fingerprint: string,
    idempotencyKey?: string,
    transaction?: PoolClient,
    beforeAdmission?: () => void,
  ) {
    return this.admitInvocation<R>(
      identity,
      owner,
      undefined,
      "",
      idempotencyKey,
      undefined,
      fingerprint,
      transaction,
      beforeAdmission,
    );
  }

  /** First-class administrator execution. No visitor/app/key is invented. */
  async admitAdministrator<R extends IntegrationCallResult>(
    actor: number,
    agentId: number,
    versionId: number,
    fingerprint: string,
    key: string,
    transaction?: PoolClient,
  ) {
    const codes = (await workspaceAccess(this.db, actor, currentWorkspaceId()))
      .permissionCodes;
    if (!codes.includes("agent_chat.use"))
      throw new ForbiddenException("需要 Agent 对话使用权限");
    if (!/^[\w.:/-]{1,120}$/u.test(key))
      throw new BadRequestException("请求 ID 无效");
    const work = async (client: PoolClient) => {
      await lifecycleWriteLock(client);
      await client.query("SELECT pg_advisory_xact_lock(245139,hashtext($1))", [
        `${currentWorkspaceId()}:${actor}`,
      ]);
      const available = await client.query(
        `SELECT r.id FROM agent_resources r JOIN agent_resource_versions v ON v.resource_id=r.id
        WHERE r.id=$1 AND v.id=$2 AND r.kind='agent' AND r.enabled AND r.archived_at IS NULL AND r.deleted_at IS NULL AND v.status='published' FOR SHARE OF r`,
        [agentId, versionId],
      );
      if (!available.rowCount)
        throw new ConflictException("此 Agent 已停用或没有可用的发布版本");
      await client.query(
        "UPDATE integration_calls SET status='expired',finished_at=now() WHERE admin_actor_id=$1 AND status='running' AND expires_at<=now()",
        [actor],
      );
      const old = (
        await client.query<{
          fingerprint: string;
          status: string;
          response: R | null;
        }>(
          `SELECT fingerprint,status,response FROM integration_calls WHERE admin_actor_id=$1 AND entry_agent_id=$2 AND idempotency_key=$3`,
          [actor, agentId, key],
        )
      ).rows[0];
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new ConflictException("此请求 ID 已用于不同输入");
        if (old.status === "completed" && old.response)
          return {
            cached: old.response,
            callId: "",
            conversationId: null,
            clientRequestId: key,
          };
        throw new ConflictException(
          old.status === "running"
            ? "请求正在执行，请恢复会话查看"
            : "此前请求未完成，请明确发起新请求",
        );
      }
      const counts = (
        await client.query<{ minute: number; active: number }>(
          `SELECT count(*) FILTER(WHERE created_at>now()-interval '1 minute')::int AS minute,count(*) FILTER(WHERE status='running' AND expires_at>now())::int AS active FROM integration_calls WHERE admin_actor_id=$1`,
          [actor],
        )
      ).rows[0];
      if (
        counts.active >= APPLICATION_SAFETY.concurrency ||
        counts.minute >= 30
      )
        throw quotaExceeded(
          "request_rate_limit",
          "达到平台安全保护上限，请稍后再试。",
          new Date(Date.now() + 60000).toISOString(),
        );
      const callId = randomUUID();
      await client.query(
        `INSERT INTO integration_calls(id,app_id,visitor_session_id,admin_actor_id,entry_agent_id,idempotency_key,fingerprint,status,run_id) VALUES($1,NULL,NULL,$2,$3,$4,$5,'running',$1)`,
        [callId, actor, agentId, key, fingerprint],
      );
      return {
        cached: null,
        callId,
        conversationId: null,
        clientRequestId: key,
      };
    };
    return transaction ? work(transaction) : this.db.transaction(work);
  }

  /** Same application quota/ledger/no-replay authority, without minting a key. */
  async admitManagedTest<R extends IntegrationCallResult>(
    appId: string,
    actorId: number,
    agentId: number,
    fingerprint: string,
    requestId: string,
  ) {
    return this.admitManagedExecution<R>(
      appId,
      actorId,
      agentId,
      fingerprint,
      requestId,
      "workflow_test",
    );
  }
  /** Explicit authenticated administration edge, separate from public key identities. */
  async admitManagedExecution<R extends IntegrationCallResult>(
    appId: string,
    actorId: number,
    agentId: number,
    fingerprint: string,
    requestId: string,
    source: "workflow_test" | "agent_preview",
  ) {
    const app = await this.app(appId);
    if (app.agentId !== agentId)
      throw new ConflictException("应用绑定的 Agent 已更改，请重新选择");
    const namespace =
      source === "workflow_test"
        ? "managed-workflow-test"
        : "managed-agent-preview";
    const hex = credentialHash(
      JSON.stringify([namespace, currentWorkspaceId(), appId, actorId]),
    );
    const owner = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return this.admitInvocation<R>(
      { kind: "admin", actorId, app, scopes: app.scopes, source },
      owner,
      undefined,
      "",
      requestId,
      undefined,
      fingerprint,
    );
  }

  private async admitInvocation<R extends IntegrationCallResult>(
    identity: IntegrationIdentity | ManagedTestIdentity,
    owner: string,
    conversationId: string | undefined,
    question: string,
    idempotencyKey?: string,
    context?: RequestContext,
    runFingerprint?: string,
    transaction?: PoolClient,
    beforeAdmission?: () => void,
  ) {
    const key = idempotencyKey ?? randomUUID();
    if (!/^[\w.:/-]{1,120}$/u.test(key))
      throw new BadRequestException(
        "Idempotency-Key 必须是 1–120 个安全 ASCII 字符",
      );
    // Empty context preserves existing context-free idempotency fingerprints.
    const fingerprint =
      runFingerprint ??
      credentialHash(
        JSON.stringify([
          conversationId ?? null,
          question,
          ...(context && Object.keys(context).length
            ? [contextFingerprint(context)]
            : []),
        ]),
      );
    const work = async (client: PoolClient) => {
      await lifecycleWriteLock(client);
      const locked = await client.query<IntegrationApp>(
        `SELECT ${APP_COLUMNS} FROM integration_apps WHERE id=$1 FOR UPDATE`,
        [identity.app.id],
      );
      const app = locked.rows[0];
      if (
        !app?.enabled ||
        (identity.kind !== "admin" &&
          !(identity.kind === "api" ? app.apiEnabled : app.websiteEnabled))
      )
        throw new ForbiddenException("接入应用已停用");
      if (identity.kind === "admin") {
        const codes = (
          await workspaceAccess(this.db, identity.actorId, currentWorkspaceId())
        ).permissionCodes;
        if (
          !["agent_config.manage", "agent_tools.execute"].every((p) =>
            codes.includes(p),
          )
        )
          throw new ForbiddenException("需要配置管理和工具执行权限");
        await client.query(
          `INSERT INTO visitor_sessions(id,token_hash,application_id,client_type) VALUES($1,$2,$3,$4)
          ON CONFLICT(id) DO UPDATE SET last_seen_at=now() WHERE visitor_sessions.application_id=EXCLUDED.application_id`,
          [
            owner,
            credentialHash(randomBytes(32).toString("hex")),
            app.id,
            identity.source === "agent_preview"
              ? "admin-agent-preview"
              : "admin-workflow-test",
          ],
        );
      }
      this.assertScope({ ...identity, app }, "chat:write");
      if (app.agentId !== identity.app.agentId)
        throw new ConflictException("接入应用的 Agent 已更改，请重新请求");
      if (identity.kind === "api") {
        const active = await client.query<{ scopes: AccessScope[] }>(
          "SELECT scopes FROM integration_api_keys WHERE id=$1 AND app_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())",
          [identity.keyId, app.id],
        );
        if (!active.rowCount)
          throw new UnauthorizedException("密钥已撤销或过期");
        this.assertScope(
          {
            ...identity,
            app,
            scopes: identity.scopes.filter((s) =>
              active.rows[0].scopes.includes(s),
            ),
          },
          "chat:write",
        );
      } else if (
        identity.kind === "website" &&
        app.authVersion !== identity.app.authVersion
      )
        throw new UnauthorizedException("网站授权已变更");
      await client.query(
        "UPDATE integration_calls SET status='expired',finished_at=now() WHERE app_id=$1 AND status='running' AND expires_at<=now()",
        [app.id],
      );
      const previous = await client.query<{
        fingerprint: string;
        status: string;
        response: R | null;
      }>(
        "SELECT fingerprint,status,response FROM integration_calls WHERE app_id=$1 AND visitor_session_id=$2 AND idempotency_key=$3",
        [app.id, owner, key],
      );
      if (previous.rows[0]) {
        const old = previous.rows[0];
        if (old.fingerprint !== fingerprint)
          throw new ConflictException("Idempotency-Key 已用于不同请求");
        if (old.status === "completed" && old.response) {
          const target = runFingerprint
            ? null
            : (old.response as unknown as PublicAgentResult).conversationId;
          if (!runFingerprint) {
            const accessible = await client.query(
              "SELECT id FROM conversations WHERE id=$1 AND visitor_session_id=$2 AND application_id=$3",
              [target, owner, app.id],
            );
            if (!accessible.rowCount)
              throw new NotFoundException("该会话已删除");
          }
          return {
            cached: old.response,
            callId: "",
            conversationId: target,
            clientRequestId: key,
          };
        }
        throw new ConflictException(
          old.status === "running"
            ? "请求正在处理中"
            : "此前请求未完成，请使用新的 Idempotency-Key",
        );
      }
      beforeAdmission?.(); // Only new requests validate the current contract; cached results keep their original version.
      const quota = await client.query<{
        minute: number;
        daily: number;
        active: number;
        visitorMinute: number;
        keyMinute: number;
      }>(
        `SELECT
        count(*) FILTER(WHERE created_at>now()-interval '1 minute')::int AS minute,
        count(*) FILTER(WHERE created_at>now()-interval '1 minute' AND visitor_session_id=$2)::int AS "visitorMinute",
        count(*) FILTER(WHERE created_at>now()-interval '1 minute' AND key_id=$3)::int AS "keyMinute",
        count(*) FILTER(WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')::int AS daily,
        count(*) FILTER(WHERE status='running')::int AS active FROM integration_calls WHERE app_id=$1
        AND (created_at>=LEAST(now()-interval '1 minute',date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') OR status='running')`,
        [app.id, owner, identity.keyId ?? null],
      );
      const usage = quota.rows[0];
      const rateLimit =
        applicationLimit(app, "requestsPerMinute") ??
        APPLICATION_SAFETY.requestsPerMinute;
      const concurrentLimit =
        applicationLimit(app, "concurrency") ?? APPLICATION_SAFETY.concurrency;
      const dailyLimit = applicationLimit(app, "dailyRequests");
      const tokenLimit = applicationLimit(app, "dailyTokenLimit");
      const visitorLimit = Math.min(
        rateLimit,
        identity.kind === "website" ? 10 : 30,
      );
      const today = await this.tokens.daily(app.id, undefined, client);
      if (dailyLimit !== null && usage.daily >= dailyLimit)
        throw quotaExceeded(
          "daily_request_quota_exceeded",
          "今日请求额度已用完，请明日再试。",
          today.resetAt,
        );
      if (tokenLimit !== null && today.totalTokens >= tokenLimit)
        throw quotaExceeded(
          "daily_token_quota_exceeded",
          "今日 Token 额度已用完，请明日再试或联系管理员。",
          today.resetAt,
        );
      if (
        tokenLimit !== null &&
        today.totalTokens + today.reservedTokens >= tokenLimit
      )
        throw quotaExceeded(
          "token_budget_reserved",
          "Token 额度暂被其他请求占用，请稍后再试。",
          new Date(Date.now() + 10000).toISOString(),
        );
      if (usage.active >= concurrentLimit)
        throw quotaExceeded(
          "concurrency_limit",
          applicationLimit(app, "concurrency") === null
            ? "同时执行数量达到平台安全上限，请稍后再试。"
            : "同时执行数量达到应用配置上限，请稍后再试。",
          new Date(Date.now() + 10000).toISOString(),
        );
      if (
        usage.minute >= rateLimit ||
        usage.keyMinute >= rateLimit ||
        usage.visitorMinute >= visitorLimit
      ) {
        const platform =
          applicationLimit(app, "requestsPerMinute") === null ||
          (usage.visitorMinute >= visitorLimit &&
            rateLimit > (identity.kind === "website" ? 10 : 30));
        throw quotaExceeded(
          "request_rate_limit",
          platform
            ? "请求达到平台防滥用上限，请稍后再试。"
            : "请求达到应用配置的频率上限，请稍后再试。",
          new Date(Date.now() + 60000).toISOString(),
        );
      }
      let target: string | null = conversationId ?? null;
      if (target) {
        const owned = await client.query(
          "SELECT id FROM conversations WHERE id=$1 AND visitor_session_id=$2 AND application_id=$3",
          [target, owner, app.id],
        );
        if (!owned.rowCount) throw new NotFoundException("会话不存在");
      } else if (!runFingerprint) {
        target = randomUUID();
        await client.query(
          "INSERT INTO conversations(id,visitor_session_id) VALUES($1,$2)",
          [target, owner],
        );
      }
      const callId = randomUUID();
      await client.query(
        `INSERT INTO integration_calls(id,app_id,visitor_session_id,key_id,idempotency_key,fingerprint,conversation_id,status,run_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'running',$8)`,
        [
          callId,
          app.id,
          owner,
          identity.keyId ?? null,
          key,
          fingerprint,
          target,
          runFingerprint ? callId : null,
        ],
      );
      return {
        cached: null,
        callId,
        conversationId: target,
        clientRequestId: key,
      };
    };
    return transaction ? work(transaction) : this.db.transaction(work);
  }

  async finish<R extends IntegrationCallResult = PublicAgentResult>(
    callId: string,
    result: R | null,
    tokens = 0,
  ) {
    return this.db.transaction(async (client) => {
      await lifecycleWriteLock(client);
      // Backward-compatible trace totals for callers without model accounting.
      // Normal requests already have one row per model attempt and must not double-count.
      if (tokens > 0)
        await client.query(
          `INSERT INTO integration_model_calls(id,call_id,app_id,purpose,usage_status,reserved_tokens,total_tokens,quota_day,settled_at)
        SELECT $1,id,app_id,'legacy','legacy',0,$2,(created_at AT TIME ZONE 'Asia/Shanghai')::date,now() FROM integration_calls
        WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM integration_model_calls WHERE call_id=$1) ON CONFLICT(id) DO NOTHING`,
          [callId, tokens],
        );
      await this.tokens.syncCall(client, callId);
      const response = result
        ? { ...result, usage: await this.tokens.callUsage(callId, client) }
        : null;
      await client.query(
        `UPDATE integration_calls SET status=$2,response=$3,run_id=COALESCE($4,run_id),trace_id=COALESCE($5,trace_id),finished_at=now()
        WHERE id=$1 AND status='running'`,
        [
          callId,
          result ? "completed" : "failed",
          response,
          result?.runId ?? null,
          result?.traceId ?? null,
        ],
      );
      return response;
    });
  }

  async publicUsage(identity: IntegrationIdentity) {
    if (identity.kind === "api") this.assertScope(identity, "usage:read");
    const owner = identity.kind === "website" ? identity.ownerId : undefined;
    if (identity.kind === "website" && !owner)
      throw new UnauthorizedException("访客身份无效");
    this.checkInspectionRate(identity);
    const app = await this.app(identity.app.id);
    const tokens = await this.tokens.daily(app.id, owner);
    const counts = await this.db.query(
      `SELECT count(*)::int AS requests,
      count(*) FILTER(WHERE status='completed')::int AS completed,
      count(*) FILTER(WHERE status IN ('failed','expired'))::int AS failed,
      count(*) FILTER(WHERE status='running' AND expires_at>now())::int AS running
      FROM integration_calls WHERE app_id=$1 AND created_at>=${DAY_START} AND ($2::uuid IS NULL OR visitor_session_id=$2)`,
      [app.id, owner ?? null],
    );
    // Never disclose application-wide traffic or budgets to an anonymous visitor.
    const limit = owner ? null : applicationLimit(app, "dailyTokenLimit");
    return {
      scope: owner ? "visitor" : "application",
      ...tokens,
      ...counts.rows[0],
      tokenLimit: limit,
      remainingTokens:
        limit === null
          ? null
          : Math.max(0, limit - tokens.totalTokens - tokens.reservedTokens),
    };
  }

  // Explicitly published website budget, separate from private visitor usage and platform reports.
  // No keys, origins, other applications, user identities or execution contexts are returned.
  async publicWebsiteQuota(identity: IntegrationIdentity) {
    if (identity.kind !== "website" || !identity.ownerId)
      throw new ForbiddenException("仅当前网站访客可以查询共享额度");
    this.assertScope(identity, "conversations:read");
    this.checkInspectionRate(identity);
    const app = await this.app(identity.app.id);
    const tokens = await this.tokens.daily(app.id);
    const requests = (
      await this.db.query<{ requests: number }>(
        `SELECT count(*)::int AS requests FROM integration_calls WHERE app_id=$1 AND created_at>=${DAY_START}`,
        [app.id],
      )
    ).rows[0].requests;
    const requestLimit = applicationLimit(app, "dailyRequests"),
      tokenLimit = applicationLimit(app, "dailyTokenLimit");
    return {
      scope: "website-shared" as const,
      startAt: tokens.startAt,
      resetAt: tokens.resetAt,
      timezone: tokens.timezone,
      requests,
      requestLimit,
      remainingRequests:
        requestLimit === null ? null : Math.max(0, requestLimit - requests),
      totalTokens: tokens.totalTokens,
      reservedTokens: tokens.reservedTokens,
      tokenLimit,
      remainingTokens:
        tokenLimit === null
          ? null
          : Math.max(
              0,
              tokenLimit - tokens.totalTokens - tokens.reservedTokens,
            ),
      unknownModelCalls: tokens.unknownModelCalls,
      checkedAt: new Date().toISOString(),
    };
  }

  async publicStatus(identity: IntegrationIdentity) {
    this.checkInspectionRate(identity);
    const app = await this.app(identity.app.id);
    const today = await this.tokens.daily(app.id);
    const row = (
      await this.db.query(
        `SELECT
      count(*) FILTER(WHERE created_at>=${DAY_START})::int AS daily,
      count(*) FILTER(WHERE created_at>now()-interval '1 minute')::int AS minute,
      count(*) FILTER(WHERE created_at>now()-interval '1 minute' AND visitor_session_id=$2)::int AS "visitorMinute",
      count(*) FILTER(WHERE status='running' AND expires_at>now())::int AS active
      FROM integration_calls WHERE app_id=$1 AND (created_at>=LEAST(${DAY_START},now()-interval '1 minute') OR status='running')`,
        [app.id, identity.ownerId ?? null],
      )
    ).rows[0];
    const dailyLimit = applicationLimit(app, "dailyRequests"),
      tokenLimit = applicationLimit(app, "dailyTokenLimit");
    const concurrentLimit =
      applicationLimit(app, "concurrency") ?? APPLICATION_SAFETY.concurrency;
    const rateLimit =
      applicationLimit(app, "requestsPerMinute") ??
      APPLICATION_SAFETY.requestsPerMinute;
    let code = "ready",
      retryAt: string | null = null;
    if (
      !app.enabled ||
      !(identity.kind === "api" ? app.apiEnabled : app.websiteEnabled) ||
      !identity.scopes.includes("chat:write") ||
      !app.scopes.includes("chat:write")
    )
      code = "access_denied";
    else if (dailyLimit !== null && row.daily >= dailyLimit) {
      code = "daily_request_quota_exceeded";
      retryAt = today.resetAt;
    } else if (tokenLimit !== null && today.totalTokens >= tokenLimit) {
      code = "daily_token_quota_exceeded";
      retryAt = today.resetAt;
    } else if (
      tokenLimit !== null &&
      today.totalTokens + today.reservedTokens >= tokenLimit
    ) {
      code = "token_budget_reserved";
      retryAt = new Date(Date.now() + 10000).toISOString();
    } else if (row.active >= concurrentLimit) {
      code = "concurrency_limit";
      retryAt = new Date(Date.now() + 10000).toISOString();
    } else if (
      row.minute >= rateLimit ||
      (identity.kind === "website" &&
        row.visitorMinute >= Math.min(rateLimit, 10))
    ) {
      code = "request_rate_limit";
      retryAt = new Date(Date.now() + 60000).toISOString();
    }
    let limitSource: "application" | "platform" | null =
      code === "ready" || code === "access_denied" ? null : "application";
    if (
      (code === "concurrency_limit" &&
        applicationLimit(app, "concurrency") === null) ||
      (code === "request_rate_limit" &&
        (applicationLimit(app, "requestsPerMinute") === null ||
          (identity.kind === "website" &&
            row.visitorMinute >= Math.min(rateLimit, 10) &&
            rateLimit > 10)))
    )
      limitSource = "platform";
    return {
      service: "ready",
      canSend: code === "ready",
      code,
      retryAt,
      limitSource,
      checkedAt: new Date().toISOString(),
      modelHealth: "not_probed",
    };
  }

  checkInspectionRate(identity: IntegrationIdentity) {
    const now = Date.now();
    for (const [key, value] of this.inspectionWindows)
      if (value.until <= now) this.inspectionWindows.delete(key);
    const key = `${identity.app.id}:${identity.kind}:${identity.kind === "api" ? identity.keyId : identity.ownerId}`;
    const value = this.inspectionWindows.get(key) ?? {
      count: 0,
      until: now + 60000,
    };
    if (
      value.count >= 60 ||
      (!this.inspectionWindows.has(key) && this.inspectionWindows.size >= 10000)
    )
      throw quotaExceeded(
        "inspection_rate_limit",
        "状态与用量查询过于频繁，请稍后重试。",
        new Date(value.until).toISOString(),
      );
    value.count++;
    this.inspectionWindows.set(key, value);
  }

  checkVisitorBootstrap(ip: string) {
    const now = Date.now();
    for (const [key, value] of this.bootstrapWindows)
      if (value.until <= now) this.bootstrapWindows.delete(key);
    const value = this.bootstrapWindows.get(ip) ?? {
      count: 0,
      until: now + 60_000,
    };
    if (
      value.count >= 20 ||
      (!this.bootstrapWindows.has(ip) && this.bootstrapWindows.size >= 10000)
    )
      throw new HttpException("请稍后重试访客授权", 429);
    value.count++;
    this.bootstrapWindows.set(ip, value);
  }

  private async audit(
    client: PoolClient,
    actor: number,
    action: string,
    appId: string,
    details: object,
  ) {
    await client.query(
      "INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)",
      [actor, action, "integration", appId, details],
    );
  }
}
