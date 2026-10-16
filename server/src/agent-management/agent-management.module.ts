import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { ToolsModule } from '../ai/tools/tools.module';
import { SkillsModule } from '../ai/skills/skills.module';
import { McpModule } from '../ai/mcp/mcp.module';
import { PromptsModule } from '../prompts/prompts.module';
import { ModelManagementModule } from '../model-management/model-management.module';
import { AgentManagementService } from './agent-management.service';
import { AgentManagementController } from './agent-management.controller';
import { ToolManagementModule } from '../tool-management/tool-management.module';
@Module({imports:[AdminModule,ToolsModule,SkillsModule,McpModule,PromptsModule,ModelManagementModule,ToolManagementModule],controllers:[AgentManagementController],providers:[AgentManagementService],exports:[AgentManagementService]})
export class AgentManagementModule {}
