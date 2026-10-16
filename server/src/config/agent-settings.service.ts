import { BadRequestException, ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database.service';
import { AppConfigService } from './config.service';
import { agentConfigurationRevision, storedAgentConfigurationRevision, agentEditableSchema, parseAgentConfiguration, type AgentConfiguration, type AgentConfigurationSnapshot } from './agent-config';
import { SkillRegistry } from '../ai/skills/skill-registry';
import { ToolExecutionService } from '../ai/tools/tool-execution';

const saveSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{12}$/u), configurationVersion: z.number().int().positive(), settings: agentEditableSchema }).strict();
type Row = { configuration: unknown; revision: string; version: number; updatedAt: Date | string; updatedBy: number | null };
const SELECT = 'SELECT configuration,revision,version,updated_at AS "updatedAt",updated_by::int AS "updatedBy" FROM agent_settings WHERE id=1';

@Injectable()
export class AgentSettingsService implements OnModuleInit {
  constructor(private readonly database: DatabaseService, private readonly config: AppConfigService,
    private readonly skills: SkillRegistry, private readonly tools: ToolExecutionService) {}

  async onModuleInit() {
    const initial = this.config.agent;
    await this.database.query('INSERT INTO agent_settings(id,configuration,revision) VALUES(1,$1::jsonb,$2) ON CONFLICT(workspace_id,id) DO NOTHING', [JSON.stringify(initial), agentConfigurationRevision(initial)]);
  }

  async snapshot(): Promise<AgentConfigurationSnapshot> {
    const result = await this.database.query<Row>(SELECT);
    if (!result.rows[0]) throw new Error('Agent settings not initialized');
    return this.fromRow(result.rows[0]);
  }

  async save(actorId: number, body: unknown): Promise<AgentConfigurationSnapshot> {
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ message: '配置无效，请检查字段和关联限制。', fields: parsed.error.issues.map(issue => issue.path.join('.')) });
    const value = parsed.data;
    const configuration = parseAgentConfiguration({ ...value.settings, version: 1, answerInstructions: this.config.agent.answerInstructions });
    this.validateCapabilities(configuration);
    return this.database.transaction(async client => {
      const existing = (await client.query<Row>(SELECT + ' FOR UPDATE')).rows[0];
      if (!existing || existing.revision !== value.revision || existing.version !== value.configurationVersion) throw new ConflictException('配置已被其他管理员更新，请重新加载后合并修改。');
      const revision = agentConfigurationRevision(configuration);
      if (revision === existing.revision) return this.fromRow(existing);
      const result = await client.query<Row>(`UPDATE agent_settings SET configuration=$1::jsonb,revision=$2,version=version+1,updated_by=$3,updated_at=now()
        WHERE id=1 RETURNING configuration,revision,version,updated_at AS "updatedAt",updated_by::int AS "updatedBy"`, [JSON.stringify(configuration), revision, actorId]);
      await client.query(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,'agent_config.updated','agent_config','1',$2::jsonb)`,
        [actorId, JSON.stringify({ previousVersion: existing.version, version: result.rows[0].version, previousRevision: existing.revision, revision, changes: changes(existing.configuration, configuration) })]);
      return this.fromRow(result.rows[0]);
    });
  }

  private validateCapabilities(configuration: AgentConfiguration) {
    for (const id of configuration.enabledSkills) if (!this.skills.has(id)) throw new BadRequestException('只能开启已注册的专项 Skill。');
    const registered = new Set(this.tools.toolDefinitions().map(tool => tool.name));
    for (const name of configuration.runtime.allowedTools) if (!registered.has(name)) throw new BadRequestException('只能开启已注册的工具。');
    const allowed = new Set(configuration.runtime.allowedTools);
    if (!allowed.has('load_skill')) throw new BadRequestException('专项指导读取是系统能力，不支持手动移除。');
    for (const group of this.tools.capabilities()) {
      if (group.system) continue;
      const enabled = group.tools.filter(tool => allowed.has(tool.name)).length;
      if (enabled !== 0 && enabled !== group.tools.length) throw new BadRequestException('同一能力的本地与 MCP 工具必须统一启停。');
    }
  }

  private fromRow(row: Row): AgentConfigurationSnapshot {
    const configuration = parseAgentConfiguration(row.configuration);
    const calculatedRevision = storedAgentConfigurationRevision(row.configuration);
    // Rows written before dynamic memory management contain the removed
    // memory fields. Their historical revision was calculated by the old
    // schema/parser, so it cannot be reproduced after normalization. Keep
    // the row readable and let the next explicit save rewrite it canonically.
    const rawMemory = row.configuration && typeof row.configuration === 'object' && !Array.isArray(row.configuration)
      ? (row.configuration as Record<string, unknown>).memory
      : undefined;
    const legacyMemory = rawMemory && typeof rawMemory === 'object' && !Array.isArray(rawMemory)
      && Object.keys(rawMemory).some(key => key !== 'toolResults');
    if (calculatedRevision !== row.revision && !legacyMemory) throw new Error('Agent settings revision mismatch');
    return Object.freeze({ configuration, revision: row.revision, configurationVersion: row.version,
      updatedAt: new Date(row.updatedAt).toISOString(), updatedBy: row.updatedBy });
  }
}

function changes(before: unknown, after: unknown, path = ''): { path: string; before: unknown; after: unknown }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => changes(a[key], b[key], path ? `${path}.${key}` : key));
  }
  return [{ path, before, after }];
}
