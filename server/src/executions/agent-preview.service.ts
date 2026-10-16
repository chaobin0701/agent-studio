import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { z } from "zod";
import { DatabaseService } from "../database.service";
import { AgentManagementService } from "../agent-management/agent-management.service";
import { agentMemoryScope } from "../agent-management/runtime-scope";
import { IntegrationService } from "../integrations/integration.service";
import { currentWorkspaceId } from "../workspaces/workspace-context";
import { workspaceAccess } from "../workspaces/workspace-access";
import { configuredExecutionBudget } from "../ai/agent/execution-budget";
import { parseRunRequest } from "./run-request";
import { AgentRunService } from "./agent-run.service";
import { agentOutputContract } from "../ai/agent/output-contract";
import { isSystemTool } from "../agent-management/system-tools";

const draftSchema = z
  .object({
    versionId: z.number().int().positive(),
    revision: z.number().int().positive(),
  })
  .strict();
const requestSchema = z
  .object({
    applicationId: z.string().uuid(),
    contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    requestId: z.string().uuid(),
    input: z.unknown(),
    stream: z.boolean().default(false),
    draft: draftSchema.optional(),
  })
  .strict();
@Injectable()
export class AgentPreviewService {
  constructor(
    private readonly db: DatabaseService,
    private readonly management: AgentManagementService,
    private readonly access: IntegrationService,
    private readonly runs: AgentRunService,
  ) {}
  private async permission(actor: number) {
    const codes = (await workspaceAccess(this.db, actor, currentWorkspaceId()))
      .permissionCodes;
    if (
      !["agent_config.manage", "agent_tools.execute"].every((p) =>
        codes.includes(p),
      )
    )
      throw new ForbiddenException("试运行需要 Agent 配置管理和执行权限");
  }
  private async context(
    applicationId: string,
    draft?: z.infer<typeof draftSchema>,
  ) {
    const app = await this.access.app(applicationId);
    if (!app.enabled || !app.scopes.includes("chat:write"))
      throw new ConflictException("接入应用已停用或不允许执行");
    const composition = draft
      ? await this.management.draftSnapshot(
          app.agentId,
          draft.versionId,
          draft.revision,
        )
      : await this.management.snapshot(app.agentId);
    return {
      app,
      composition,
      entry: composition.agents.get(composition.entryVersionId)!,
    };
  }
  async options(
    actor: number,
    applicationId?: string,
    agentId?: number,
    draft?: z.infer<typeof draftSchema>,
  ) {
    await this.permission(actor);
    if (draft) {
      if (!agentId || !draftSchema.safeParse(draft).success)
        throw new BadRequestException("草稿预览需要有效的 Agent 和修订号");
      // Validate before presenting an application or reserving any quota.
      await this.management.draftSnapshot(
        agentId,
        draft.versionId,
        draft.revision,
      );
    }
    if (applicationId && !z.string().uuid().safeParse(applicationId).success)
      throw new BadRequestException("接入应用 ID 无效");
    const applications = (
      await this.db.query(
        `SELECT a.id,a.name,r.id::int AS "agentId",r.name AS "agentName",v.id::int AS "agentVersionId",v.version,
      CASE WHEN v.config->'collaboration' IS NULL OR v.config->'collaboration'='null'::jsonb THEN 'single' ELSE 'multi' END AS mode
      FROM integration_apps a JOIN agent_resources r ON r.id=a.agent_id JOIN agent_resource_versions v ON v.id=COALESCE($2::bigint,r.current_version_id) AND v.resource_id=r.id
      WHERE a.enabled AND 'chat:write'=ANY(a.scopes) AND r.kind='agent' AND r.enabled AND r.archived_at IS NULL AND r.deleted_at IS NULL AND (v.status='published' OR ($2::bigint IS NOT NULL AND v.status='draft'))
      AND ($1::bigint IS NULL OR r.id=$1) ORDER BY a.is_internal DESC,a.created_at DESC LIMIT 200`,
        [agentId ?? null, draft?.versionId ?? null],
      )
    ).rows;
    if (!applicationId) return { applications };
    const { composition, entry } = await this.context(applicationId, draft);
    if (agentId && composition.agentId !== agentId)
      throw new BadRequestException("所选应用未绑定此 Agent");
    return {
      applications,
      selected: {
        agentId: composition.agentId,
        agentVersionId: entry.version.id,
        agentName: entry.version.name,
        version: entry.version.version,
        mode: composition.mode,
        contextFingerprint: agentMemoryScope(composition),
        ...(draft ? { draft } : {}),
        modelName: entry.modelPlan?.name ?? "",
        modelVersion: entry.modelPlan?.version ?? null,
        promptVersionId: entry.spec.promptVersionId,
        tools: [...entry.tools.values()]
          .filter((tool) => !isSystemTool(tool.name))
          .map((tool) => ({
            key: tool.name,
            description: tool.description,
          })),
        skills: [...entry.skills.values()].map((skill) => ({
          key: skill.id,
          name: skill.name,
        })),
        knowledgeBases: entry.knowledge.length,
        fileOutputs: !!entry.spec.fileOutputs?.enabled,
        outputContract: agentOutputContract(
          entry.spec.output,
          entry.version.id,
        ),
        members: [...composition.agents.values()]
          .filter((member) => member.version.id !== composition.entryVersionId)
          .map((member) => ({
            name: member.version.name,
            version: member.version.version,
            versionId: member.version.id,
          })),
        limits: configuredExecutionBudget(
          entry.spec.runtime,
          composition.collaboration,
          entry.spec.executionLimits,
        ),
      },
    };
  }
  async prepare(actor: number, value: unknown) {
    await this.permission(actor);
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success)
      throw new BadRequestException("请指定应用、配置快照、请求 ID 和任务输入");
    const input = parseRunRequest(parsed.data.input);
    if (input.userId !== undefined || input.stream)
      throw new BadRequestException(
        "后台试运行使用当前管理员身份和独立任务结果，不接受访客身份或其他传输设置",
      );
    const { app, composition } = await this.context(
      parsed.data.applicationId,
      parsed.data.draft,
    );
    if (agentMemoryScope(composition) !== parsed.data.contextFingerprint)
      throw new ConflictException(
        "Agent 或实际模型配置已变更，请重新选择试运行上下文",
      );
    const prepared = await this.runs.prepareAdministrative(
      app,
      actor,
      { ...input, stream: parsed.data.stream },
      composition,
      parsed.data.requestId,
    );
    try {
      await this.audit(
        actor,
        composition.agentId,
        prepared.admission.cached
          ? "agent_preview.replayed"
          : "agent_preview.started",
        {
          applicationId: app.id,
          runId: prepared.admission.cached?.runId ?? prepared.admission.callId,
          agentVersionId: composition.entryVersionId,
          ...(composition.previewDraft
            ? { draftRevision: composition.previewDraft.revision }
            : {}),
        },
      );
    } catch (error) {
      await this.runs.cancelAdmission(prepared);
      throw error;
    }
    return prepared;
  }
  private audit(
    actor: number,
    agentId: number,
    action: string,
    details: Record<string, unknown>,
  ) {
    return this.db.query(
      "INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,$2,'agent_resource',$3,$4)",
      [actor, action, String(agentId), JSON.stringify(details)],
    );
  }
}
