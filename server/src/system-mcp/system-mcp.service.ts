import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { DatabaseService } from "../database.service";
import { AgentManagementService } from "../agent-management/agent-management.service";
import { PromptService } from "../prompts/prompt.service";
import { ModelManagementService } from "../model-management/model-management.service";
import { KnowledgeBaseService } from "../documents/knowledge-base.service";
import { KnowledgeIndexService } from "../documents/knowledge-index.service";
import { workspaceAccess } from "../workspaces/workspace-access";
import { currentWorkspaceId, inWorkspace } from "../workspaces/workspace-context";
import { executionContextView } from "../observability/execution-view";

const ALL_WORKSPACES = 0;
const ALL_SCOPES = "*";

const scopePermission: Record<string, string> = {
  "agents.read": "agent_config.read",
  "agents.manage": "agent_config.manage",
  "prompts.read": "prompts.read",
  "prompts.manage": "prompts.manage",
  "models.read": "model_profiles.read",
  "models.manage": "model_profiles.manage",
  "embeddings.read": "embedding_profiles.read",
  "embeddings.manage": "embedding_profiles.manage",
  "knowledge.read": "documents.read",
  "knowledge.manage": "knowledge_bases.manage",
  "recording.read": "agent_config.read",
  "recording.manage": "agent_config.manage",
  "audit.read": "audit.read",
  "workspaces.read": "agent_config.read",
};
const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
function withoutUsage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUsage);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["inputTokens", "outputTokens", "totalTokens", "reservedTokens"].includes(key)).map(([key, item]) => [key, withoutUsage(item)]));
}
const credentialScopesSchema = z.array(z.union([z.literal(ALL_SCOPES), z.enum(["agents.read", "agents.manage", "prompts.read", "prompts.manage", "models.read", "models.manage", "embeddings.read", "embeddings.manage", "knowledge.read", "knowledge.manage", "recording.read", "recording.manage", "audit.read", "workspaces.read"])]))
  .min(1).refine((scopes) => scopes.includes(ALL_SCOPES) ? scopes.length === 1 : true, "全部权限不能与单项权限同时选择");

@Injectable()
export class SystemMcpService {
  constructor(
    private readonly db: DatabaseService,
    private readonly agents: AgentManagementService,
    private readonly prompts: PromptService,
    private readonly models: ModelManagementService,
    private readonly knowledge: KnowledgeBaseService,
    private readonly indexes: KnowledgeIndexService,
  ) {}

  async listCredentials(adminId: number) {
    const rows = await this.db.platformQuery(`SELECT id::int,name,workspace_ids AS "workspaceIds",scopes,
      expires_at AS "expiresAt",revoked_at AS "revokedAt",created_at AS "createdAt",last_used_at AS "lastUsedAt"
      FROM system_mcp_credentials WHERE admin_id=$1 ORDER BY id DESC`, [adminId]);
    return rows.rows;
  }

  async createCredential(adminId: number, input: unknown) {
    const parsed = z.object({
      name: z.string().trim().min(1).max(120),
      workspaceIds: z.array(z.number().int().nonnegative()).min(1).max(50).refine((ids) => ids.includes(ALL_WORKSPACES) ? ids.length === 1 : true, "全部工作区不能与单个工作区同时选择"),
      scopes: credentialScopesSchema,
      expiresAt: z.string().datetime().optional(),
    }).strict().parse(input);
    const workspaceIds = this.normalizeWorkspaceIds(parsed.workspaceIds);
    for (const workspaceId of await this.workspacesForValidation(adminId, workspaceIds)) {
      const access = await workspaceAccess(this.db, adminId, workspaceId);
      for (const scope of parsed.scopes) {
        if (scope === ALL_SCOPES) continue;
        if (!access.permissionCodes.includes(scopePermission[scope])) throw new ForbiddenException(`账号缺少 ${scopePermission[scope]} 权限`);
      }
    }
    const token = `astm_${randomBytes(32).toString("base64url")}`;
    const result = await this.db.platformQuery(`INSERT INTO system_mcp_credentials
      (admin_id,name,token_hash,workspace_ids,scopes,expires_at)
      VALUES($1,$2,$3,$4::bigint[],$5,$6) RETURNING id::int`,
    [adminId, parsed.name, tokenHash(token), workspaceIds, [...new Set(parsed.scopes)], parsed.expiresAt ?? null]);
    await this.db.platformQuery(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details)
      VALUES($1,'system_mcp.credential_created','system_mcp_credential',$2,$3)`,
    [adminId, String(result.rows[0].id), JSON.stringify({ workspaceIds, scopes: parsed.scopes })]);
    return { id: result.rows[0].id, token, endpoint: "/api/mcp/system" };
  }

  async revokeCredential(adminId: number, id: number) {
    const result = await this.db.platformQuery(`UPDATE system_mcp_credentials SET revoked_at=now()
      WHERE id=$1 AND admin_id=$2 AND revoked_at IS NULL RETURNING id`, [id, adminId]);
    if (!result.rowCount) throw new NotFoundException("MCP 凭证不存在或已撤销");
    await this.db.platformQuery(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id)
      VALUES($1,'system_mcp.credential_revoked','system_mcp_credential',$2)`, [adminId, String(id)]);
    return { ok: true };
  }

  async updateCredentialScopes(adminId: number, id: number, input: unknown) {
    const parsed = z.object({ scopes: credentialScopesSchema, workspaceIds: z.array(z.number().int().nonnegative()).min(1).max(50).refine((ids) => ids.includes(ALL_WORKSPACES) ? ids.length === 1 : true, "全部工作区不能与单个工作区同时选择").optional() }).strict().parse(input);
    const existing = await this.db.platformQuery<{ workspaceIds: string[]; scopes: string[] }>(`SELECT workspace_ids AS "workspaceIds",scopes
      FROM system_mcp_credentials WHERE id=$1 AND admin_id=$2 AND revoked_at IS NULL`, [id, adminId]);
    const credential = existing.rows[0];
    if (!credential) throw new NotFoundException("MCP 凭证不存在或已撤销");
    const scopes = [...new Set(parsed.scopes)];
    const workspaceIds = this.normalizeWorkspaceIds(parsed.workspaceIds ?? credential.workspaceIds.map(Number));
    for (const workspaceId of await this.workspacesForValidation(adminId, workspaceIds)) {
      const access = await workspaceAccess(this.db, adminId, Number(workspaceId));
      for (const scope of scopes) {
        if (scope === ALL_SCOPES) continue;
        if (!access.permissionCodes.includes(scopePermission[scope])) throw new ForbiddenException(`账号缺少 ${scopePermission[scope]} 权限`);
      }
    }
    const result = await this.db.platformQuery(`UPDATE system_mcp_credentials SET scopes=$3,workspace_ids=$4::bigint[]
      WHERE id=$1 AND admin_id=$2 AND revoked_at IS NULL RETURNING id`, [id, adminId, scopes, workspaceIds]);
    if (!result.rowCount) throw new NotFoundException("MCP 凭证不存在或已撤销");
    await this.db.platformQuery(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details)
      VALUES($1,'system_mcp.credential_scopes_updated','system_mcp_credential',$2,$3)`,
    [adminId, String(id), JSON.stringify({ previousScopes: credential.scopes, scopes, previousWorkspaceIds: credential.workspaceIds, workspaceIds })]);
    return { ok: true };
  }

  async authenticate(authorization?: string) {
    const token = /^Bearer\s+(astm_\S+)$/i.exec(authorization ?? "")?.[1];
    if (!token) throw new ForbiddenException("MCP account credential required");
    const result = await this.db.platformQuery<any>(`SELECT c.id,c.admin_id::int AS "adminId",c.workspace_ids AS "workspaceIds",c.scopes
      FROM system_mcp_credentials c JOIN admins a ON a.id=c.admin_id
      WHERE c.token_hash=$1 AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>now()) AND a.disabled_at IS NULL`, [tokenHash(token)]);
    const credential = result.rows[0];
    if (!credential) throw new ForbiddenException("MCP credential is invalid or expired");
    await this.db.platformQuery("UPDATE system_mcp_credentials SET last_used_at=now() WHERE id=$1", [credential.id]);
    return { ...credential, workspaceIds: credential.workspaceIds.map(Number) } as { id: number; adminId: number; workspaceIds: number[]; scopes: string[] };
  }

  private normalizeWorkspaceIds(ids: number[]) {
    const normalized = [...new Set(ids)];
    if (!normalized.length || normalized.some((id) => !Number.isSafeInteger(id) || id < 0) || normalized.includes(ALL_WORKSPACES) && normalized.length !== 1)
      throw new BadRequestException("工作区范围无效");
    return normalized;
  }
  private async workspacesForValidation(adminId: number, workspaceIds: number[]) {
    if (!workspaceIds.includes(ALL_WORKSPACES)) return workspaceIds;
    const rows = await this.db.platformQuery<{ id: number }>(`SELECT w.id::int AS id FROM workspaces w
      JOIN workspace_members m ON m.workspace_id=w.id JOIN admins a ON a.id=m.admin_id
      WHERE m.admin_id=$1 AND a.disabled_at IS NULL AND w.enabled ORDER BY w.id`, [adminId]);
    if (!rows.rows.length) throw new ForbiddenException("账号没有可访问的工作区");
    return rows.rows.map(({ id }) => id);
  }
  async listWorkspaces(credential: { adminId: number; workspaceIds: number[]; scopes: string[] }) {
    if (!credential.scopes.includes("workspaces.read") && !credential.scopes.includes(ALL_SCOPES)) throw new ForbiddenException("MCP credential does not grant workspaces.read");
    const rows = await this.db.platformQuery(`SELECT w.id::int AS id,w.name,w.enabled,m.role FROM workspaces w
      JOIN workspace_members m ON m.workspace_id=w.id JOIN admins a ON a.id=m.admin_id
      WHERE m.admin_id=$1 AND a.disabled_at IS NULL ORDER BY w.id`, [credential.adminId]);
    return rows.rows.filter((row: any) => credential.workspaceIds.includes(ALL_WORKSPACES) || credential.workspaceIds.includes(row.id));
  }
  async withScope<T>(credential: { adminId: number; workspaceIds: number[]; scopes: string[] }, workspaceId: number, scope: string, work: () => Promise<T>): Promise<T> {
    if (!(credential.workspaceIds.includes(workspaceId) || credential.workspaceIds.includes(ALL_WORKSPACES)) || !(credential.scopes.includes(scope) || credential.scopes.includes(ALL_SCOPES))) throw new ForbiddenException("MCP credential does not grant this workspace and scope");
    const requiredPermission = scopePermission[scope];
    if (!requiredPermission) throw new ForbiddenException("Unknown MCP operation scope");
    const access = await workspaceAccess(this.db, credential.adminId, workspaceId);
    if (!access.permissionCodes.includes(requiredPermission)) throw new ForbiddenException("Account workspace permission was removed");
    return inWorkspace(workspaceId, work);
  }

  async executionList(input: { agentId?: number; conversationId?: string; status?: "completed" | "failed"; from?: string; to?: string; page: number; pageSize: number }) {
    const values: unknown[] = [];
    const filters: string[] = ["kind='answer'", "workspace_id = $1"];
    values.push(currentWorkspaceId());
    const add = (clause: string, value: unknown) => { values.push(value); filters.push(clause.replace("?", `$${values.length}`)); };
    if (input.agentId) add("context_snapshot->'agentComposition'->>'agentId' = ?", String(input.agentId));
    if (input.conversationId) add("conversation_id = ?::uuid", input.conversationId);
    if (input.status) add("status = ?", input.status);
    if (input.from) add("created_at >= ?::timestamptz", input.from);
    if (input.to) add("created_at <= ?::timestamptz", input.to);
    const where = `WHERE ${filters.join(" AND ")}`;
    values.push(input.pageSize, (input.page - 1) * input.pageSize);
    const pageSizeIndex = values.length - 1, offsetIndex = values.length;
    const [items, count] = await Promise.all([
      this.db.query(`SELECT id,kind,conversation_id AS "conversationId",status,error_code AS "errorCode",input_tokens AS "inputTokens",output_tokens AS "outputTokens",total_tokens AS "totalTokens",duration_ms AS "durationMs",created_at AS "createdAt",context_snapshot->'agentComposition'->>'agentId' AS "agentId" FROM chat_traces ${where} ORDER BY created_at DESC,id DESC LIMIT $${pageSizeIndex} OFFSET $${offsetIndex}`, values),
      this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM chat_traces ${where}`, values.slice(0, values.length - 2)),
    ]);
    const policy = await this.getRecordingPolicy(0);
    const visibleItems = policy.usageEnabled ? items.rows : items.rows.map((item: any) => ({ ...item, inputTokens: null, outputTokens: null, totalTokens: null }));
    return { items: visibleItems, total: count.rows[0]?.total ?? 0, page: input.page, pageSize: input.pageSize };
  }

  async executionDetail(id: string) {
    const { rows } = await this.db.query<any>(`SELECT id,kind,conversation_id AS "conversationId",question,final_answer AS "finalAnswer",refused,status,error_code AS "errorCode",input_tokens AS "inputTokens",output_tokens AS "outputTokens",total_tokens AS "totalTokens",duration_ms AS "durationMs",created_at AS "createdAt",context_snapshot AS "contextSnapshot" FROM chat_traces WHERE id=$1`, [id]);
    const row = rows[0];
    if (!row) throw new NotFoundException("执行记录不存在");
    const { contextSnapshot, question, finalAnswer, ...trace } = row;
    const policy = await this.getRecordingPolicy(0);
    return { ...trace, ...(policy.conversationContentEnabled ? { question, finalAnswer } : { question: null, finalAnswer: null }),
      ...(!policy.usageEnabled ? { inputTokens: null, outputTokens: null, totalTokens: null } : {}), execution: policy.usageEnabled ? executionContextView(contextSnapshot) : withoutUsage(executionContextView(contextSnapshot)) };
  }

  async executionConversation(id: string, page: number, pageSize: number) {
    const trace = (await this.db.query<any>(`SELECT id,conversation_id AS "conversationId" FROM chat_traces WHERE id=$1`, [id])).rows[0];
    if (!trace) throw new NotFoundException("执行记录不存在");
    if (!trace.conversationId) return { conversation: null, items: [], total: 0, page: 1, pageSize };
    const conversation = (await this.db.query(`SELECT id,title,created_at AS "createdAt",updated_at AS "updatedAt" FROM conversations WHERE id=$1`, [trace.conversationId])).rows[0];
    if (!conversation) throw new NotFoundException("会话不存在");
    const timeline = `WITH timeline AS (
      SELECT 'message:' || lpad(m.id::text,20,'0') AS key,m.id::int AS "userMessageId",m.content AS question,a.content AS "finalAnswer",a.refused,
        t.id AS "traceId",COALESCE(t.status,'completed') AS status,t.error_code AS "errorCode",t.total_tokens AS "totalTokens",t.duration_ms AS "durationMs",m.created_at AS "createdAt"
      FROM conversation_messages m
      LEFT JOIN LATERAL (SELECT role,content,refused FROM conversation_messages WHERE conversation_id=m.conversation_id AND id>m.id ORDER BY id LIMIT 1) a ON a.role='assistant'
      LEFT JOIN LATERAL (SELECT id,status,error_code,total_tokens,duration_ms FROM chat_traces WHERE conversation_id=m.conversation_id AND user_message_id=m.id AND kind='answer' ORDER BY created_at DESC,id DESC LIMIT 1) t ON true
      WHERE m.conversation_id=$1 AND m.role='user'
      UNION ALL SELECT 'trace:'||id,NULL::int,question,final_answer,refused,id,status,error_code,total_tokens,duration_ms,created_at FROM chat_traces WHERE conversation_id=$1 AND kind='answer' AND status='failed' AND user_message_id IS NULL
    )`;
    const count = (await this.db.query<{ total: number }>(`${timeline} SELECT count(*)::int AS total FROM timeline`, [trace.conversationId])).rows[0]?.total ?? 0;
    const items = await this.db.query(`${timeline} SELECT * FROM timeline ORDER BY "createdAt",key LIMIT $2 OFFSET $3`, [trace.conversationId, pageSize, (page - 1) * pageSize]);
    const policy = await this.getRecordingPolicy(0);
    const visibleItems = items.rows.map((item: any) => ({ ...item,
      ...(!policy.conversationContentEnabled ? { question: null, finalAnswer: null } : {}),
      ...(!policy.usageEnabled ? { totalTokens: null } : {}),
    }));
    return { conversation, items: visibleItems, total: count, page, pageSize };
  }

  async agentConfigurationProfile(id: number) {
    const resource = await this.agents.get(id);
    if (resource.kind !== "agent") throw new NotFoundException("Agent 不存在");
    const version = resource.versions.find((item: any) => item.id === resource.currentVersionId) ?? resource.versions.find((item: any) => item.status === "published");
    if (!version) return { agent: { id, name: resource.name, enabled: resource.enabled }, version: null, profile: null, issues: [{ resource: "Agent", status: "not_published" }] };
    const config = version.config;
    const issues: Array<{ resource: string; id?: number; status: string }> = [];
    if (!resource.enabled) issues.push({ resource: "agent", id, status: "disabled" });
    const checkIds = async (table: string, ids: number[], expectedKind?: string) => {
      if (!ids.length) return [];
      const params: unknown[] = [ids];
      const kindFilter = expectedKind ? ` AND r.kind=$2` : "";
      if (expectedKind) params.push(expectedKind);
      const result = await this.db.query<any>(`SELECT v.id::int AS "versionId",v.resource_id::int AS "resourceId",v.version,v.status,r.name,r.enabled,r.kind FROM ${table} v JOIN agent_resources r ON r.id=v.resource_id WHERE v.id=ANY($1::bigint[])${kindFilter}`, params);
      return ids.map((resourceVersionId) => {
        const row = result.rows.find((item: any) => item.versionId === resourceVersionId);
        const state = !row ? "missing" : row.kind !== expectedKind ? "wrong_kind" : !row.enabled ? "disabled" : row.status !== "published" ? "not_published" : "ok";
        if (state !== "ok") issues.push({ resource: expectedKind ?? "resource", id: resourceVersionId, status: state });
        return row ? { versionId: row.versionId, resourceId: row.resourceId, name: row.name, version: row.version, status: state } : { versionId: resourceVersionId, status: state };
      });
    };
    const [prompt, llm, embedding, tools, skills, knowledge, collaborationMembers] = await Promise.all([
      this.db.query<any>(`SELECT v.id::int AS "versionId",v.version,v.status,r.name FROM prompt_versions v JOIN prompt_resources r ON r.id=v.resource_id WHERE v.id=$1`, [config.promptVersionId]),
      config.modelPlanVersionId ? this.db.query<any>(`SELECT v.id::int AS "versionId",v.version,v.status,p.name FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE v.id=$1 AND p.kind='llm'`, [config.modelPlanVersionId]) : Promise.resolve({ rows: [] }),
      config.embeddingPlanVersionId ? this.db.query<any>(`SELECT v.id::int AS "versionId",v.version,v.status,p.name FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id WHERE v.id=$1 AND p.kind='embedding'`, [config.embeddingPlanVersionId]) : Promise.resolve({ rows: [] }),
      checkIds("agent_resource_versions", config.toolVersionIds ?? [], "tool"),
      checkIds("agent_resource_versions", config.skillVersionIds ?? [], "skill"),
      (async () => {
        const result = await this.db.query<any>(`SELECT id::int,name,enabled_for_chat AS enabled,archived_at FROM knowledge_bases WHERE id=ANY($1::bigint[])`, [config.knowledgeBaseIds ?? []]);
        return (config.knowledgeBaseIds ?? []).map((kbId: number) => {
          const row = result.rows.find((item: any) => item.id === kbId);
          const status = !row ? "missing" : row.archived_at ? "archived" : !row.enabled ? "disabled" : "ok";
          if (status !== "ok") issues.push({ resource: "knowledge_base", id: kbId, status });
          return row ? { id: kbId, name: row.name, status } : { id: kbId, status };
        });
      })(),
      config.collaboration ? checkIds("agent_resource_versions", config.collaboration.memberVersionIds ?? [], "agent") : Promise.resolve([]),
    ]);
    const checkVersion = (name: string, rows: any[], expectedId: number | null) => {
      const row = rows[0];
      const status = !expectedId ? "not_configured" : !row ? "missing" : row.status !== "published" ? "not_published" : "ok";
      if (status !== "ok" && status !== "not_configured") issues.push({ resource: name, id: expectedId ?? undefined, status });
      return row ? { versionId: row.versionId, version: row.version, name: row.name, status } : { versionId: expectedId, status };
    };
    return {
      agent: { id: resource.id, key: resource.key, name: resource.name, enabled: resource.enabled },
      version: { id: version.id, number: version.version, status: version.status },
      profile: {
        model: checkVersion("llm_model", llm.rows, config.modelPlanVersionId),
        embeddingModel: checkVersion("embedding_model", embedding.rows, config.embeddingPlanVersionId),
        prompt: checkVersion("prompt", prompt.rows, config.promptVersionId),
        retrieval: config.retrieval,
        tools, skills, knowledgeBases: knowledge,
        collaboration: config.collaboration ? { mode: "multi", members: collaborationMembers } : { mode: "single", members: 0 },
        budgets: config.executionLimits ?? null,
      },
      issues,
    };
  }

  async listAgents() {
    const result = await this.agents.list();
    return result.resources.filter((row: any) => row.kind === "agent").map(({ id, key, name, enabled, currentVersionId, versions }: any) => ({
      id, key, name, enabled, currentVersionId,
      versions: versions.map(({ id: versionId, version, status, config }: any) => ({ versionId, version, status, config: this.safeConfiguration(config) })),
    }));
  }
  async getAgent(id: number) {
    const result = await this.agents.get(id);
    return { id: result.id, key: result.key, name: result.name, kind: result.kind, enabled: result.enabled, currentVersionId: result.currentVersionId,
      versions: result.versions.map(({ id: versionId, version, status, revision, createdAt, updatedAt, config }: any) => ({ versionId, version, status, revision, createdAt, updatedAt, config: this.safeConfiguration(config) })) };
  }
  async listResources(kind?: "agent" | "skill" | "tool" | "collaboration") {
    const result = await this.agents.list();
    return result.resources.filter((row: any) => !kind || row.kind === kind).map(({ id, key, name, kind: resourceKind, enabled, currentVersionId, versions }: any) => ({
      id, key, name, kind: resourceKind, enabled, currentVersionId,
      versions: versions.map(({ id: versionId, version, status, name: versionName, config }: any) => ({ versionId, version, status, name: versionName, config: this.safeConfiguration(config) })),
    }));
  }
  async getResource(id: number) {
    const resource = await this.agents.get(id);
    return { id: resource.id, key: resource.key, name: resource.name, kind: resource.kind, enabled: resource.enabled, currentVersionId: resource.currentVersionId,
      versions: resource.versions.map(({ id: versionId, version, status, revision, createdAt, updatedAt, config }: any) => ({ versionId, version, status, revision, createdAt, updatedAt, config: this.safeConfiguration(config) })) };
  }
  safeConfiguration(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.safeConfiguration(item));
    if (!value || typeof value !== "object") return value;
    const hidden = /(template|instructions|document|business.?prompt|endpoint|base.?url|url|headers|authorization|api.?key|secret|token|credential)/iu;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hidden.test(key) ? "[redacted]" : this.safeConfiguration(item)]));
  }
  createResource(adminId: number, input: unknown) { return this.agents.create(adminId, input); }
  updateResource(adminId: number, versionId: number, input: unknown) { return this.agents.update(adminId, versionId, input); }
  agentDraft(adminId: number, resourceId: number, input: unknown) { return this.agents.agentDraft(adminId, resourceId, input); }
  publishAgent(adminId: number, versionId: number) { return this.agents.publish(adminId, versionId); }
  publishResource(adminId: number, versionId: number) { return this.agents.publish(adminId, versionId); }
  async prepareResourceDraft(adminId: number, resourceId: number, input: unknown) {
    const resource = await this.agents.get(resourceId);
    if (resource.kind === "agent") return this.agents.agentDraft(adminId, resourceId, input);
    if (resource.kind === "skill") return this.agents.skillDraft(adminId, resourceId, input);
    if (resource.kind === "tool") return this.agents.toolDraft(adminId, resourceId, input);
    throw new ForbiddenException("协作方案应通过 Agent 协作配置进行版本化");
  }
  listPrompts() { return this.prompts.list(); }
  async getPrompt(id: number) {
    const value = await this.prompts.get(id);
    const { template: _template, variables: _variables, ...safe } = value;
    return { ...safe, versions: value.versions.map(({ template: _body, variables: _vars, ...version }: any) => version) };
  }
  createPrompt(adminId: number, input: unknown) { return this.prompts.create(adminId, input); }
  createPromptVersion(adminId: number, id: number, input: unknown) { return this.prompts.createVersion(adminId, id, input); }
  updatePromptVersion(adminId: number, id: number, input: unknown) { return this.prompts.updateDraft(adminId, id, input); }
  publishPrompt(adminId: number, id: number, input: unknown) { return this.prompts.publish(adminId, id, input); }
  listModels() { return this.modelPlanSummary("llm"); }
  listEmbeddings() { return this.modelPlanSummary("embedding"); }
  private async modelPlanSummary(kind: "llm" | "embedding") {
    const { plans, versions } = await this.models.list(kind);
    return { plans, versions: versions.map((version: any) => ({ id: version.id, plan_id: version.plan_id, version: version.version, status: version.status, name: version.name, active: version.active })) };
  }
  createModelPlan(adminId: number, kind: "llm" | "embedding", input: unknown) { return this.models.createPlan(adminId, kind, input); }
  prepareModelDraft(adminId: number, kind: "llm" | "embedding", planId: number, input: unknown) { return this.models.workingDraft(adminId, kind, planId, input); }
  updateModelDraft(adminId: number, kind: "llm" | "embedding", versionId: number, input: unknown) { return this.models.updateDraft(adminId, kind, versionId, input); }
  testAndPublishModel(adminId: number, kind: "llm" | "embedding", versionId: number) { return this.models.testAndPublish(adminId, kind, versionId); }
  listKnowledgeBases() { return this.knowledge.list().then((rows: any[]) => rows.map(({ id, name, description, enabledForChat, documentCount, readyDocumentCount, activeIndexVersionId, updatedAt }) => ({ id, name, description, enabledForChat, documentCount, readyDocumentCount, activeIndexVersionId, updatedAt }))); }
  async getKnowledgeBase(id: number) { return this.safeConfiguration(await this.knowledge.get(id)); }
  createKnowledgeBase(adminId: number, input: unknown) { return this.knowledge.create(adminId, input); }
  updateKnowledgeBase(adminId: number, id: number, input: unknown) { return this.knowledge.update(adminId, id, input); }
  archiveKnowledgeBase(adminId: number, id: number) { return this.knowledge.archive(adminId, id); }
  configureKnowledgeBase(adminId: number, id: number, input: unknown) { return this.indexes.configure(adminId, id, input); }
  buildKnowledgeIndex(adminId: number, id: number, activateOnReady: boolean) { return this.indexes.build(adminId, id, activateOnReady); }
  async listAudit(workspaceId: number, limit: number) {
    const { rows } = await this.db.query(`SELECT id::int,actor_admin_id::int AS "actorAdminId",action,target_type AS "targetType",
      target_id AS "targetId",created_at AS "createdAt" FROM audit_logs
      WHERE workspace_id=$1 ORDER BY id DESC LIMIT $2`, [workspaceId, Math.min(100, Math.max(1, limit))]);
    return rows;
  }
  async getRecordingPolicy(adminId: number) {
    const result = await this.db.platformQuery(`SELECT audit_enabled AS "auditEnabled",conversation_content_enabled AS "conversationContentEnabled",
      trace_enabled AS "traceEnabled",usage_enabled AS "usageEnabled",updated_at AS "updatedAt" FROM system_mcp_recording_policy WHERE id=1`);
    return result.rows[0];
  }
  async updateRecordingPolicy(adminId: number, input: unknown) {
    const parsed = z.object({ auditEnabled: z.boolean(), conversationContentEnabled: z.boolean(), traceEnabled: z.boolean(), usageEnabled: z.boolean() }).strict().parse(input);
    if (!parsed.auditEnabled) throw new BadRequestException("安全审计记录为平台强制保留项，不能关闭");
    const result = await this.db.platformQuery(`UPDATE system_mcp_recording_policy SET audit_enabled=$1,conversation_content_enabled=$2,
      trace_enabled=$3,usage_enabled=$4,updated_by=$5,updated_at=now() WHERE id=1
      RETURNING audit_enabled AS "auditEnabled",conversation_content_enabled AS "conversationContentEnabled",trace_enabled AS "traceEnabled",usage_enabled AS "usageEnabled",updated_at AS "updatedAt"`,
    [parsed.auditEnabled, parsed.conversationContentEnabled, parsed.traceEnabled, parsed.usageEnabled, adminId]);
    await this.db.platformQuery(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details)
      VALUES($1,'system_mcp.recording_policy_updated','system_mcp','recording-policy',$2)`, [adminId, JSON.stringify(parsed)]);
    return result.rows[0];
  }
}
