import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { SkillRegistry } from "../skills/skill-registry";
import type { AgentTool } from "./agent-tool";
import type { ToolResult } from "./tool-result";
import type { ToolContext } from "./tool-context";
import { annotateExecution } from "../../observability/execution-tracer";

const inputSchema = z
  .object({ skillId: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u) })
  .strict();

@Injectable()
export class LoadSkillTool implements AgentTool<z.infer<typeof inputSchema>> {
  readonly name = "load_skill";
  readonly execution = {
    channel: "skill_guidance",
    source: "platform",
  } as const;
  readonly capabilities = ["skill"] as const;
  readonly description =
    "按需读取已授权 Skill 的详细指导；不执行任务、不切换 Agent、不扩大权限。无需每轮加载，只能使用可用 Skill 摘要中列出的 skillId。";
  readonly inputSchema = inputSchema;
  readonly planning = {
    canBatch: false,
    dependency: "需要使用专项指导时单独读取，再根据内容决定后续动作。",
  };

  constructor(private readonly registry: SkillRegistry) {}

  async execute(
    input: z.infer<typeof inputSchema>,
    context?: ToolContext,
  ): Promise<ToolResult> {
    if (!this.registry.has(input.skillId))
      return {
        success: false,
        content: "unknown_skill",
        errorCode: "unknown_skill",
      };
    if (
      context?.enabledSkillIds &&
      !context.enabledSkillIds.includes(input.skillId)
    )
      return {
        success: false,
        content: "skill_unavailable",
        errorCode: "skill_unavailable",
      };
    const definition = this.registry.get(input.skillId);
    annotateExecution({
      skillId: definition.id,
      skillVersionId: definition.versionId,
    });
    const skill = {
      id: definition.id,
      version: definition.version,
      name: definition.name,
      instructions: definition.systemInstructions,
    };
    return { success: true, content: JSON.stringify(skill), data: { skill } };
  }
}
