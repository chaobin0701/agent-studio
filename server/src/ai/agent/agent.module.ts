import { Module } from "@nestjs/common";
import { AiModule } from "../ai.module";
import { ToolsModule } from "../tools/tools.module";
import { LlmService } from "../../chat/llm.service";
import { AgentExecutionService } from "../runtime/agent-execution.service";
import { SkillsModule } from "../skills/skills.module";
import { McpModule } from "../mcp/mcp.module";
import { ContextGovernor } from "../../chat/context-governor";
import { PromptsModule } from "../../prompts/prompts.module";
import { TracingModule } from "../../observability/tracing.module";
import { DeepAgentExecutionService } from "../deep-agents/deep-agent-execution.service";

@Module({
  imports: [
    AiModule,
    ToolsModule,
    SkillsModule,
    McpModule,
    PromptsModule,
    TracingModule,
  ],
  providers: [
    ContextGovernor,
    LlmService,
    DeepAgentExecutionService,
    AgentExecutionService,
  ],
  exports: [ContextGovernor, LlmService, AgentExecutionService, ToolsModule],
})
export class AgentModule {}
