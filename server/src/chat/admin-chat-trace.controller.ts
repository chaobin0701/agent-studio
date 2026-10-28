import { Controller, DefaultValuePipe, Get, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { RequirePermission } from '../admin/permission.decorator';
import { PermissionGuard } from '../admin/permission.guard';
import { DatabaseService } from '../database.service';

@Controller('admin/chat-traces')
@UseGuards(AdminAuthGuard, PermissionGuard)
export class AdminChatTraceController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  @RequirePermission('conversations.read')
  async list(@Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number) {
    const result = await this.database.query(
      `SELECT id, kind, conversation_id AS "conversationId", question, model, final_answer AS "finalAnswer",
              refused, status, error_code AS "errorCode", input_tokens AS "inputTokens",
              output_tokens AS "outputTokens", total_tokens AS "totalTokens",
              duration_ms AS "durationMs", created_at AS "createdAt"
       FROM chat_traces ORDER BY created_at DESC LIMIT $1`, [Math.max(1, Math.min(limit, 100))],
    );
    return result.rows;
  }

  @Get(':id')
  @RequirePermission('conversations.read')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT id, kind, conversation_id AS "conversationId", question, context_snapshot AS "contextSnapshot",
              model, raw_model_output AS "rawModelOutput", final_answer AS "finalAnswer",
              refused, status, error_code AS "errorCode", input_tokens AS "inputTokens",
              output_tokens AS "outputTokens", total_tokens AS "totalTokens",
              duration_ms AS "durationMs", created_at AS "createdAt"
       FROM chat_traces WHERE id = $1`, [id],
    );
    if (!result.rows[0]) throw new NotFoundException('Trace not found');
    const { rawModelOutput: _rawModelOutput, contextSnapshot, ...trace } = result.rows[0];
    const context = contextSnapshot && typeof contextSnapshot === 'object' && !Array.isArray(contextSnapshot)
      ? { ...(contextSnapshot as Record<string, unknown>) }
      : {};
    delete context.externalTrace;
    delete context.phoenix; // Historical links also need a separate platform grant.
    delete context.langSmith; // Do not expose legacy stored external links.
    delete context.systemPrompt;
    delete context.modelCalls;
    if(Array.isArray(context.specialistTasks)) context.specialistTasks=context.specialistTasks.map(({context:_context,...task})=>task);
    // Skill instructions are internal prompt material, not ordinary trace data.
    if (Array.isArray(context.toolResults)) context.toolResults = context.toolResults.map(item => {
      if (item && typeof item === 'object' && item.tool === 'load_skill') return { tool: 'load_skill', result: '专项指导已加载，完整内容需调试权限' };
      return item;
    });
    if (Array.isArray(context.executionSteps)) context.executionSteps = context.executionSteps.map(item => {
      if (item && typeof item === 'object' && item.name === 'load_skill') return { ...item, result: '专项指导已加载，完整内容需调试权限' };
      return item;
    }).filter(item => !(item && typeof item === 'object' && (item as Record<string, unknown>).type === 'agent_setup'));
    if (Array.isArray(context.agentTranscript)) context.agentTranscript = context.agentTranscript.map(item => {
      if (item && typeof item === 'object' && item.toolName === 'load_skill') return { ...item, content: '专项指导已加载，完整内容需调试权限' };
      return item;
    });
    return { ...trace, contextSnapshot: context, rawModelOutput: null };
  }
}
