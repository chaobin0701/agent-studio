import {
  ConflictException,
  Controller,
  Get,
  Optional,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { AgentManagementService } from "../agent-management/agent-management.service";
import {
  runtimeScope,
  type ResolvedAgent,
} from "../agent-management/runtime-scope";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { PermissionGuard } from "../admin/permission.guard";
import { RequirePermission } from "../admin/permission.decorator";
import { effectiveAgentConfiguration } from "../config/agent-config";
import { ToolExecutionService } from "../ai/tools/tool-execution";
import { LlmService } from "./llm.service";
import { nativeSystemPrompt } from "../ai/deep-agents/deep-agent-execution.service";
import { DEEP_AGENT_RUNTIME_VERSION } from "../ai/deep-agents/managed-harness";

/** Read-only compatibility view for the retained old admin. Never constructs a
 * static Agent, writes legacy settings or injects the retired planner engine. */
@Controller("admin/agent-config")
@UseGuards(AdminAuthGuard, PermissionGuard)
export class AdminAgentConfigController {
  constructor(
    private readonly llm: LlmService,
    private readonly management: AgentManagementService,
    @Optional() private readonly tools?: ToolExecutionService,
  ) {}

  @Get()
  @RequirePermission("agent_config.read", "agent_config.manage")
  async inspect() {
    const snapshot = await this.management.snapshot();
    const entry = snapshot.agents.get(snapshot.entryVersionId)!;
    return runtimeScope.run(entry, () =>
      this.llm.withPinnedModelPlan(entry.modelPlan, async () =>
        this.view(entry),
      ),
    );
  }

  @Patch()
  @RequirePermission("agent_config.manage")
  save() {
    throw new ConflictException(
      "Agent 配置已迁移，请在 Agent 管理中创建草稿、测试并发布",
    );
  }

  private view(entry: ResolvedAgent) {
    const snapshot = entry.configurationSnapshot;
    const agent = snapshot.configuration;
    const {
      version: _version,
      answerInstructions: _instructions,
      ...editable
    } = agent;
    const enabledSkills = new Set(agent.enabledSkills);
    return {
      ...agent,
      revision: snapshot.revision,
      configurationVersion: snapshot.configurationVersion,
      updatedAt: snapshot.updatedAt,
      updatedBy: snapshot.updatedBy,
      source: "agent_resources",
      readOnly: true,
      settings: editable,
      model: {
        name: this.llm.model,
        contextWindowTokens: this.llm.contextWindowTokens,
        maxOutputTokens: this.llm.maxOutputTokens,
      },
      runtime: {
        ...effectiveAgentConfiguration(agent).runtime,
        shouldPreRetrieve: false,
        execution: "sequential",
        answerValidation: "format_only",
        engine: "deepagents",
        runtimeVersion: DEEP_AGENT_RUNTIME_VERSION,
      },
      availableSkills: [...entry.skills.values()].map(
        ({ id, name, version, description, systemInstructions }) => ({
          id,
          name,
          version,
          description,
          instructions: systemInstructions,
          enabled: enabledSkills.has(id),
        }),
      ),
      capabilities: (this.tools?.capabilities() ?? []).map((group) => ({
        ...group,
        enabled: group.system
          ? enabledSkills.size > 0
          : group.tools.every((tool) =>
              agent.runtime.allowedTools.includes(tool.name),
            ),
      })),
      prompts: {
        base: entry.promptSnapshot.businessPrompt ?? entry.spec.responsibility,
        protocol:
          "Deep Agents 原生模型与工具执行；Skill、文件和上下文说明按实际授权在运行时注入，无固定 JSON 规划协议。",
        assembled: nativeSystemPrompt(entry),
        runtimeManaged: true,
        scope: "published_base_before_runtime_context",
      },
    };
  }
}
