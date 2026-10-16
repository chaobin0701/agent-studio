import { Module, OnModuleInit } from "@nestjs/common";
import { AdminModule } from "../../admin/admin.module";
import { DocumentModule } from "../../documents/document.module";
import { AgentTool } from "./agent-tool";
import { KnowledgeSearchTool } from "./knowledge-search.tool";
import { ToolExecutionService } from "./tool-execution";
import { ToolPolicy } from "./tool-policy";
import { ToolRegistry } from "./tool-registry";
import { SkillsModule } from "../skills/skills.module";
import { LoadSkillTool } from "./load-skill.tool";
import { SpecializedWorkflowRegistry } from "../workflows/specialized-workflow";
import { textStatistics } from "../workflows/text-statistics";
import { textSummary } from "../workflows/text-summary";

@Module({
  imports: [DocumentModule, AdminModule, SkillsModule],
  providers: [
    KnowledgeSearchTool,
    LoadSkillTool,
    ToolPolicy,
    ToolExecutionService,
    ToolRegistry,
    SpecializedWorkflowRegistry,
  ],
  exports: [ToolRegistry, ToolExecutionService],
})
export class ToolsModule implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly knowledgeSearch: KnowledgeSearchTool,
    private readonly loadSkill: LoadSkillTool,
    private readonly workflows: SpecializedWorkflowRegistry,
  ) {}

  onModuleInit(): void {
    this.workflows.register(textStatistics);
    this.workflows.register(textSummary);
    const tools: AgentTool[] = [this.knowledgeSearch, this.loadSkill];
    tools.push(...this.workflows.tools());
    for (const tool of tools) this.registry.register(tool);
  }
}
