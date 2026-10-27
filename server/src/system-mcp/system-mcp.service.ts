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
import { inWorkspace } from "../workspaces/workspace-context";

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
};
const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
const credentialScopesSchema = z.array(z.enum(["agents.read", "agents.manage", "prompts.read", "prompts.manage", "models.read", "models.manage", "embeddings.read", "embeddings.manage", "knowledge.read", "knowledge.manage", "recording.read", "recording.manage", "audit.read"])).min(1);

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
      workspaceIds: z.array(z.number().int().positive()).min(1).max(50),
      scopes: credentialScopesSchema,
      expiresAt: z.string().datetime().optional(),
    }).strict().parse(input);
    const workspaceIds = [...new Set(parsed.workspaceIds)];
    for (const workspaceId of workspaceIds) {
      const access = await workspaceAccess(this.db, adminId, workspaceId);
      for (const scope of parsed.scopes) {
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
    const parsed = z.object({ scopes: credentialScopesSchema }).strict().parse(input);
    const existing = await this.db.platformQuery<{ workspaceIds: string[]; scopes: string[] }>(`SELECT workspace_ids AS "workspaceIds",scopes
      FROM system_mcp_credentials WHERE id=$1 AND admin_id=$2 AND revoked_at IS NULL`, [id, adminId]);
    const credential = existing.rows[0];
    if (!credential) throw new NotFoundException("MCP 凭证不存在或已撤销");
    const scopes = [...new Set(parsed.scopes)];
    for (const workspaceId of credential.workspaceIds) {
      const access = await workspaceAccess(this.db, adminId, Number(workspaceId));
      for (const scope of scopes) {
        if (!access.permissionCodes.includes(scopePermission[scope])) throw new ForbiddenException(`账号缺少 ${scopePermission[scope]} 权限`);
      }
    }
    const result = await this.db.platformQuery(`UPDATE system_mcp_credentials SET scopes=$3
      WHERE id=$1 AND admin_id=$2 AND revoked_at IS NULL RETURNING id`, [id, adminId, scopes]);
    if (!result.rowCount) throw new NotFoundException("MCP 凭证不存在或已撤销");
    await this.db.platformQuery(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details)
      VALUES($1,'system_mcp.credential_scopes_updated','system_mcp_credential',$2,$3)`,
    [adminId, String(id), JSON.stringify({ previousScopes: credential.scopes, scopes })]);
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

  async withScope<T>(credential: { adminId: number; workspaceIds: number[]; scopes: string[] }, workspaceId: number, scope: string, work: () => Promise<T>): Promise<T> {
    if (!credential.workspaceIds.includes(workspaceId) || !credential.scopes.includes(scope)) throw new ForbiddenException("MCP credential does not grant this workspace and scope");
    const access = await workspaceAccess(this.db, credential.adminId, workspaceId);
    if (!access.permissionCodes.includes(scopePermission[scope])) throw new ForbiddenException("Account workspace permission was removed");
    return inWorkspace(workspaceId, work);
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
