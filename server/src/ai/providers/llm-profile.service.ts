import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../database.service';
import { AppConfigService } from '../../config/config.service';
import { normalizeModelBaseUrl } from '../../config/model-base-url';
import { SecretBox } from '../../security/secret-box';
import { ProviderRegistry } from './provider-registry';
import type { LlmProfileRecord, LlmProfileView } from './llm-profile.types';
import { isLlmPlatformKey } from './llm-platforms';
import { ProviderError } from './provider-errors';

const profileInput = z.object({
  name: z.string().trim().min(1).max(120),
  platformKey: z.enum(['volcengine', 'openai', 'deepseek', 'custom']).default('custom'),
  baseUrl: z.string().trim().url(),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(500).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(20000),
  contextWindowTokens: z.number().int().min(1024).max(1000000).default(32000),
  maxOutputTokens: z.number().int().min(128).max(32000).default(1200),
  supportsToolCalls: z.literal(true).default(true),
  supportsStreaming: z.boolean().default(true),
}).strict();

// PATCH must not apply creation defaults to omitted fields (Zod defaults otherwise
// survive partial()). A name-only edit must preserve platform and runtime settings.
const profileUpdateInput = profileInput.partial().extend({
  platformKey: profileInput.shape.platformKey.removeDefault().optional(),
  timeoutMs: profileInput.shape.timeoutMs.removeDefault().optional(),
  contextWindowTokens: profileInput.shape.contextWindowTokens.removeDefault().optional(),
  maxOutputTokens: profileInput.shape.maxOutputTokens.removeDefault().optional(),
  supportsToolCalls: profileInput.shape.supportsToolCalls.removeDefault().optional(),
  supportsStreaming: profileInput.shape.supportsStreaming.removeDefault().optional(),
});

type ProfileRow = Record<string, unknown>;
type ConnectionTestResult = { ok: true; model: string; durationMs: number; responsePreview: string; capabilities: { nativeTools: true; structuredOutput: true } };
const connectionTestInput = profileInput.extend({ profileId: z.number().int().positive().optional() });
const deleteInput = z.object({ replacementId: z.number().int().positive().optional() }).strict();
const connectionResponseFormat = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'connection_probe',
    strict: false,
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        commentary: { type: 'string' },
        probe: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
};

@Injectable()
export class LlmProfileService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
    private readonly secrets: SecretBox,
    private readonly registry: ProviderRegistry,
  ) {}

  async list(): Promise<LlmProfileView[]> {
    const rows = await this.database.query<ProfileRow>(this.selectSql('ORDER BY is_default DESC, updated_at DESC'));
    return rows.rows.map((row) => this.toView(row));
  }

  async create(actorId: number, input: unknown): Promise<LlmProfileView> {
    const parsed = profileInput.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Invalid OpenAI Compatible model profile');
    this.validateBaseUrl(parsed.data.platformKey, parsed.data.baseUrl);
    const apiKeyCiphertext = parsed.data.apiKey ? this.secrets.encrypt(parsed.data.apiKey) : null;
    if (!apiKeyCiphertext) this.environmentCredential(parsed.data.baseUrl);
    try {
      const row = await this.database.transaction(async (client) => {
        const inserted = await client.query<ProfileRow>(`${this.insertSql()} RETURNING ${this.returningColumns()}`, [
          parsed.data.name, parsed.data.platformKey, parsed.data.baseUrl, parsed.data.model, apiKeyCiphertext,
          parsed.data.timeoutMs, parsed.data.contextWindowTokens, parsed.data.maxOutputTokens,
          'required', parsed.data.supportsToolCalls, parsed.data.supportsStreaming,
        ]);
        const created = inserted.rows[0];
        await client.query(`INSERT INTO audit_logs(actor_admin_id, action, target_type, target_id, details)
          VALUES ($1, 'llm_profile.created', 'llm_profile', $2, $3)`, [actorId, String(created.id), JSON.stringify({ name: parsed.data.name, model: parsed.data.model })]);
        return created;
      });
      return this.toView(row);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('Only one default model profile is allowed');
      throw error;
    }
  }

  async update(actorId: number, id: number, input: unknown): Promise<LlmProfileView> {
    const parsed = profileUpdateInput.safeParse(input);
    if (!parsed.success || Object.keys(parsed.data).length === 0) throw new BadRequestException('No valid profile fields');
    const existing = await this.find(id);
    if (!existing) throw new NotFoundException('LLM profile not found');
    const platformKey = this.fixedPlatform(existing, parsed.data.platformKey);
    if (parsed.data.baseUrl !== undefined) this.validateBaseUrl(platformKey, parsed.data.baseUrl);
    if (parsed.data.baseUrl !== undefined && !parsed.data.apiKey && !existing.api_key_ciphertext)
      this.environmentCredential(parsed.data.baseUrl);
    const values: unknown[] = [id];
    const assignments: string[] = [];
    const add = (column: string, value: unknown) => { values.push(value); assignments.push(`${column} = $${values.length}`); };
    if (parsed.data.name !== undefined) add('name', parsed.data.name);
    if (parsed.data.baseUrl !== undefined) add('base_url', parsed.data.baseUrl);
    if (parsed.data.model !== undefined) add('model', parsed.data.model);
    if (parsed.data.apiKey !== undefined) add('api_key_ciphertext', this.secrets.encrypt(parsed.data.apiKey));
    if (parsed.data.timeoutMs !== undefined) add('timeout_ms', parsed.data.timeoutMs);
    if (parsed.data.contextWindowTokens !== undefined) add('context_window_tokens', parsed.data.contextWindowTokens);
    if (parsed.data.maxOutputTokens !== undefined) add('max_output_tokens', parsed.data.maxOutputTokens);
    if (parsed.data.supportsToolCalls !== undefined) add('supports_tool_calls', parsed.data.supportsToolCalls);
    if (parsed.data.supportsStreaming !== undefined) add('supports_streaming', parsed.data.supportsStreaming);
    assignments.push('updated_at = now()');
    const row = await this.database.transaction(async (client) => {
      await client.query('LOCK TABLE llm_profiles IN SHARE ROW EXCLUSIVE MODE');
      const updated = await client.query<ProfileRow>(`UPDATE llm_profiles SET ${assignments.join(', ')} WHERE id = $1 RETURNING ${this.returningColumns()}`, values);
      const result = updated.rows[0];
      if (!result) throw new NotFoundException('LLM profile not found');
      await client.query(`INSERT INTO audit_logs(actor_admin_id, action, target_type, target_id, details)
        VALUES ($1, 'llm_profile.updated', 'llm_profile', $2, $3)`, [actorId, String(id), JSON.stringify({ fields: Object.keys(parsed.data).filter(field => field !== 'platformKey') })]);
      return result;
    });
    if (row.is_default) await this.activateRuntime(row);
    return this.toView(row);
  }

  async activate(actorId: number, id: number): Promise<LlmProfileView> {
    const row = await this.find(id);
    if (!row) throw new NotFoundException('LLM profile not found');
    if (!row.enabled) throw new BadRequestException('Disabled profile cannot be activated');
    if (!row.supports_tool_calls) throw new BadRequestException('此 Agent 需要支持原生工具调用的模型');
    const active = await this.database.transaction(async (client) => {
      await client.query('LOCK TABLE llm_profiles IN SHARE ROW EXCLUSIVE MODE');
      const current = await client.query<ProfileRow>(this.selectSql('WHERE id = $1 LIMIT 1'), [id]);
      if (!current.rows[0]) throw new NotFoundException('LLM profile not found');
      if (!current.rows[0].enabled) throw new BadRequestException('Disabled profile cannot be activated');
      if (!current.rows[0].supports_tool_calls) throw new BadRequestException('此 Agent 需要支持原生工具调用的模型');
      await client.query('UPDATE llm_profiles SET is_default = FALSE, updated_at = now() WHERE is_default = TRUE');
      const updated = await client.query<ProfileRow>(`UPDATE llm_profiles SET is_default = TRUE, updated_at = now() WHERE id = $1 RETURNING ${this.returningColumns()}`, [id]);
      await client.query(`INSERT INTO audit_logs(actor_admin_id, action, target_type, target_id)
        VALUES ($1, 'llm_profile.activated', 'llm_profile', $2)`, [actorId, String(id)]);
      return updated.rows[0];
    });
    await this.activateRuntime(active);
    return this.toView(active);
  }

  async setEnabled(actorId: number, id: number, enabled: boolean): Promise<LlmProfileView> {
    const updated = await this.database.transaction(async (client) => {
      await client.query('LOCK TABLE llm_profiles IN SHARE ROW EXCLUSIVE MODE');
      const current = await client.query<ProfileRow>(this.selectSql('WHERE id = $1 LIMIT 1'), [id]);
      if (!current.rows[0]) throw new NotFoundException('LLM profile not found');
      if (!enabled && current.rows[0].is_default) throw new BadRequestException('请先切换当前模型，再停用这份配置');
      const result = await client.query<ProfileRow>(`UPDATE llm_profiles SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING ${this.returningColumns()}`, [id, enabled]);
      await client.query(`INSERT INTO audit_logs(actor_admin_id, action, target_type, target_id, details)
        VALUES ($1, 'llm_profile.updated', 'llm_profile', $2, $3)`, [actorId, String(id), JSON.stringify({ enabled })]);
      return result.rows[0];
    });
    return this.toView(updated);
  }

  async remove(actorId: number, id: number, input: unknown = {}): Promise<{ deleted: true; activeProfileId: number | null }> {
    const parsed = deleteInput.safeParse(input ?? {});
    if (!parsed.success) throw new BadRequestException('Invalid replacement model profile');
    const nextProfile = await this.database.transaction(async (client) => {
      // Serialize default selection and deletion so the active profile cannot disappear mid-switch.
      await client.query('LOCK TABLE llm_profiles IN SHARE ROW EXCLUSIVE MODE');
      const existing = await client.query<ProfileRow>(this.selectSql('WHERE id = $1 LIMIT 1'), [id]);
      const row = existing.rows[0];
      if (!row) throw new NotFoundException('模型配置不存在');
      let replacement: LlmProfileRecord | null = null;
      if (row.is_default) {
        const replacementId = parsed.data.replacementId;
        if (!replacementId || replacementId === id) throw new ConflictException('删除当前模型前，请选择另一份已启用的配置');
        const next = await client.query<ProfileRow>(this.selectSql('WHERE id = $1 LIMIT 1'), [replacementId]);
        if (!next.rows[0] || !next.rows[0].enabled) throw new BadRequestException('替代模型不存在或尚未启用');
        if (!next.rows[0].supports_tool_calls) throw new BadRequestException('替代模型必须支持原生工具调用');
        replacement = await this.hydrate(next.rows[0]);
        await client.query('UPDATE llm_profiles SET is_default = FALSE, updated_at = now() WHERE id = $1', [id]);
        await client.query('UPDATE llm_profiles SET is_default = TRUE, updated_at = now() WHERE id = $1', [replacementId]);
        await client.query(`INSERT INTO audit_logs(actor_admin_id, action, target_type, target_id)
          VALUES ($1, 'llm_profile.activated', 'llm_profile', $2)`, [actorId, String(replacementId)]);
      } else if (parsed.data.replacementId !== undefined) {
        throw new BadRequestException('非当前配置不需要指定替代模型');
      }
      await client.query('DELETE FROM llm_profiles WHERE id = $1', [id]);
      await client.query(`INSERT INTO audit_logs(actor_admin_id, action, target_type, target_id, details)
        VALUES ($1, 'llm_profile.deleted', 'llm_profile', $2, $3)`, [actorId, String(id), JSON.stringify({ name: row.name, model: row.model, replacementId: replacement?.id ?? null })]);
      return replacement;
    });
    if (nextProfile) this.registry.activateProfile(nextProfile);
    return { deleted: true, activeProfileId: nextProfile?.id ?? null };
  }

  async test(id: number): Promise<ConnectionTestResult> {
    const row = await this.find(id);
    if (!row) throw new NotFoundException('LLM profile not found');
    return this.runConnectionTest(await this.hydrate(row));
  }

  async testConnection(input: unknown): Promise<ConnectionTestResult> {
    const parsed = connectionTestInput.safeParse(input);
    if (!parsed.success) throw new BadRequestException('请检查模型连接参数');
    this.validateBaseUrl(parsed.data.platformKey, parsed.data.baseUrl);
    let apiKey: string | undefined = parsed.data.apiKey;
    if (parsed.data.profileId !== undefined) {
      const row = await this.find(parsed.data.profileId);
      if (!row) throw new NotFoundException('模型配置不存在');
      this.fixedPlatform(row, parsed.data.platformKey);
      if (!apiKey) apiKey = row.api_key_ciphertext
        ? (await this.hydrate(row)).apiKey
        : this.environmentCredential(parsed.data.baseUrl);
    }
    if (!apiKey) apiKey = this.environmentCredential(parsed.data.baseUrl);
    if (!apiKey) throw new BadRequestException('请填写 API Key');
    return this.runConnectionTest({
      ...parsed.data, id: parsed.data.profileId ?? 0, apiKey,
      providerKey: 'openai-compatible', adapterType: 'openai-compatible',
      structuredOutput: 'required', enabled: true, isDefault: false,
    });
  }

  private async runConnectionTest(profile: LlmProfileRecord): Promise<ConnectionTestResult> {
    const provider = this.registry.createFromProfile(profile);
    try {
      const response = await provider.chat({ model: profile.model, messages: [{ role: 'user', content: '仅返回 JSON 对象：{"message":"连接成功"}' }], responseFormat: connectionResponseFormat, maxTokens: 64 });
      if (!response.content.trim()) throw new BadRequestException('模型返回为空，连接测试未完成');
      let body: unknown;
      try { body = JSON.parse(response.content); } catch { throw new BadRequestException('模型未返回合法 JSON，不满足 Agent 结构化输出要求'); }
      if (!z.object({ message: z.literal('连接成功') }).strict().safeParse(body).success || response.toolCalls?.length) throw new BadRequestException('模型未遵守结构化输出要求');
      const name = 'connection_probe';
      const probe = await provider.chat({
        model: profile.model,
        messages: [{ role: 'user', content: '请通过原生工具调用 connection_probe，参数为 {"probe":"connection-test"}。正文只返回 JSON 对象 {}，不要在正文中写工具指令。' }],
        tools: [{ name, description: '无副作用的连接能力测试，不执行任何业务操作', parameters: { type: 'object', properties: { probe: { type: 'string', enum: ['connection-test'] } }, required: ['probe'], additionalProperties: false } }],
        toolChoice: { name }, responseFormat: connectionResponseFormat, maxTokens: 128,
      });
      if (probe.toolCalls?.length !== 1 || probe.toolCalls[0]?.name !== name || !probe.toolCalls[0].id || !z.object({ probe: z.literal('connection-test') }).strict().safeParse(probe.toolCalls[0].arguments).success) throw new BadRequestException('模型未返回标准 tool_calls，不支持此 Agent 的原生工具调用要求');
      return { ok: true, model: response.model, durationMs: response.durationMs + probe.durationMs, responsePreview: '连接成功', capabilities: { nativeTools: true, structuredOutput: true } };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      const messages: Record<string, string> = {
        provider_authentication: '密钥无效或没有模型访问权限，请检查 API Key。',
        provider_rate_limit: '模型服务限流或额度不足，请稍后重试。',
        provider_timeout: '连接超时，请检查服务地址或调整请求超时。',
        provider_model_not_found: '模型不存在或尚未开通，请检查模型 ID。',
        provider_unavailable: '模型服务暂时不可用，请稍后重试。',
        provider_invalid_response: '模型返回格式异常，连接测试未完成。',
        provider_unsupported_response_format: '此端点不支持 JSON 输出模式，不满足 Agent 要求；不会自动降级。',
      };
      throw new BadRequestException({ code: error.code, message: messages[error.code] ?? '模型连接测试失败，请检查配置。' });
    }
  }

  private async find(id: number): Promise<ProfileRow | null> {
    const result = await this.database.query<ProfileRow>(`${this.selectSql('WHERE id = $1 LIMIT 1')}`, [id]);
    return result.rows[0] ?? null;
  }

  private async hydrate(row: ProfileRow): Promise<LlmProfileRecord> {
    const profile = this.toRecord(row);
    if (typeof row.api_key_ciphertext === 'string' && row.api_key_ciphertext) profile.apiKey = this.secrets.decrypt(row.api_key_ciphertext);
    else profile.apiKey = this.environmentCredential(profile.baseUrl);
    if (!profile.apiKey) throw new BadRequestException('API Key is not configured');
    return profile;
  }

  private async activateRuntime(row: ProfileRow): Promise<void> { this.registry.activateProfile(await this.hydrate(row)); }

  private fixedPlatform(row: ProfileRow, requested: string | undefined): string {
    const platform = isLlmPlatformKey(row.platform_key) ? row.platform_key : 'custom';
    if (requested !== undefined && requested !== platform) {
      throw new BadRequestException('配置创建后不可修改平台，请新建配置并设为当前使用');
    }
    return platform;
  }

  private validateBaseUrl(platformKey: string, value: string): void {
    if (!isLlmPlatformKey(platformKey)) throw new BadRequestException('Invalid model platform');
    try {
      normalizeModelBaseUrl(value);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  private environmentCredential(value: string): string {
    const { baseUrl, apiKey } = this.config.llm;
    if (!apiKey) throw new BadRequestException('API Key is required');
    if (!baseUrl || normalizeModelBaseUrl(value) !== normalizeModelBaseUrl(baseUrl))
      throw new BadRequestException('使用其他服务地址时请填写该服务的 API Key，不能借用环境密钥');
    return apiKey;
  }

  private selectSql(suffix: string): string {
    return `SELECT id::int, name, platform_key, provider_key, adapter_type, base_url, model, api_key_ciphertext,
      timeout_ms, context_window_tokens, max_output_tokens, structured_output,
      supports_tool_calls, supports_streaming, enabled, is_default FROM llm_profiles ${suffix}`;
  }

  private returningColumns(): string {
    return `id::int, name, platform_key, provider_key, adapter_type, base_url, model, api_key_ciphertext,
      timeout_ms, context_window_tokens, max_output_tokens, structured_output,
      supports_tool_calls, supports_streaming, enabled, is_default`;
  }

  private insertSql(): string {
    return `INSERT INTO llm_profiles
      (name, platform_key, provider_key, adapter_type, base_url, model, api_key_ciphertext,
       timeout_ms, context_window_tokens, max_output_tokens, structured_output,
       supports_tool_calls, supports_streaming)
      VALUES ($1, $2, 'openai-compatible', 'openai-compatible', $3, $4, $5, $6, $7, $8, $9, $10, $11)`;
  }

  private toRecord(row: ProfileRow): LlmProfileRecord {
    return {
      id: Number(row.id), name: String(row.name), platformKey: isLlmPlatformKey(row.platform_key) ? row.platform_key : 'custom', providerKey: 'openai-compatible', adapterType: 'openai-compatible',
      baseUrl: String(row.base_url), model: String(row.model), timeoutMs: Number(row.timeout_ms), contextWindowTokens: Number(row.context_window_tokens),
      maxOutputTokens: Number(row.max_output_tokens), structuredOutput: 'required',
      supportsToolCalls: Boolean(row.supports_tool_calls), supportsStreaming: Boolean(row.supports_streaming), enabled: Boolean(row.enabled), isDefault: Boolean(row.is_default),
    };
  }

  private toView(row: ProfileRow): LlmProfileView {
    const key = typeof row.api_key_ciphertext === 'string' && row.api_key_ciphertext
      ? this.secrets.decrypt(row.api_key_ciphertext) : this.config.llm.apiKey;
    const apiKeyPreview = key ? (key.length >= 8 ? `${key.slice(0, 2)}***${key.slice(-2)}` : '********') : null;
    return { ...this.toRecord(row), hasApiKey: Boolean(key), apiKeyPreview };
  }
}
