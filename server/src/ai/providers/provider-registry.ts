import { ModelManagementService } from '../../model-management/model-management.service';
import { ManagedRuntimeProvider } from '../../model-management/model-route';
import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { AppConfigService } from '../../config/config.service';
import { DatabaseService } from '../../database.service';
import { SecretBox } from '../../security/secret-box';
import { LlmProvider } from './llm-provider';
import { LangChainOpenAIProvider, type OpenAICompatibleProviderOptions } from './langchain-openai.provider';
import type { LlmProfileRecord } from './llm-profile.types';

export class UnsupportedProviderError extends Error {
  constructor(provider: string) {
    super(`Unsupported LLM provider: ${provider}`);
    this.name = 'UnsupportedProviderError';
  }
}

type ProviderFactory = (config: Pick<OpenAICompatibleProviderOptions, 'apiKey' | 'baseUrl' | 'model' | 'timeoutMs' | 'maxOutputTokens' | 'contextWindowTokens'>) => LlmProvider;

@Injectable()
export class ProviderRegistry implements OnModuleInit {
  private readonly factories = new Map<string, ProviderFactory>();
  private runtimeProvider: RuntimeLlmProvider | undefined;
  private managedProvider?: ManagedRuntimeProvider;

  constructor(private readonly config: AppConfigService, @Optional() private readonly database?: DatabaseService, @Optional() private readonly secrets?: SecretBox, @Optional() private readonly management?: ModelManagementService) {
    this.factories.set('openai-compatible', (llm) => new LangChainOpenAIProvider({
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      model: llm.model,
      timeoutMs: llm.timeoutMs,
      maxOutputTokens: llm.maxOutputTokens,
      contextWindowTokens: llm.contextWindowTokens,
    }));
  }

  async onModuleInit(): Promise<void> {
    if (!this.database) return;
    const result = await this.database.query<Record<string, unknown>>(`
      SELECT id::int, name, platform_key, provider_key, adapter_type, base_url, model,
             api_key_ciphertext, timeout_ms, context_window_tokens, max_output_tokens,
             structured_output, supports_tool_calls, supports_streaming, enabled, is_default
      FROM llm_profiles WHERE enabled = TRUE AND is_default = TRUE LIMIT 1
    `);
    const row = result.rows[0];
    if (row) {
      this.createLlmProvider();
      this.runtimeProvider!.set(this.createFromProfile(this.hydrateProfile(toProfile(row), row.api_key_ciphertext)));
    }
  }

  createLlmProvider(): LlmProvider {
    if (!this.runtimeProvider) this.runtimeProvider = new RuntimeLlmProvider(this.createFromRuntimeConfig());
    if (this.management) {
      this.managedProvider ??= new ManagedRuntimeProvider(this.management, () => this.runtimeProvider!);
      return this.managedProvider;
    }
    return this.runtimeProvider;
  }

  activateProfile(profile: LlmProfileRecord): void {
    this.createLlmProvider();
    this.runtimeProvider!.set(this.createFromProfile(profile));
  }

  createFromProfile(profile: LlmProfileRecord): LlmProvider {
    const factory = this.factories.get(profile.adapterType);
    if (!factory) throw new UnsupportedProviderError(profile.adapterType);
    return factory({
      apiKey: profile.apiKey ?? '',
      baseUrl: profile.baseUrl,
      model: profile.model,
      timeoutMs: profile.timeoutMs,
      maxOutputTokens: profile.maxOutputTokens,
      contextWindowTokens: profile.contextWindowTokens,
    });
  }

  private createFromRuntimeConfig(): LlmProvider {
    const providerName = this.config.llm.provider;
    const factory = this.factories.get(providerName);
    if (!factory) throw new UnsupportedProviderError(providerName);
    return factory(this.config.llm);
  }

  private hydrateProfile(profile: LlmProfileRecord, ciphertext: unknown): LlmProfileRecord {
    if (typeof ciphertext === 'string' && ciphertext && this.secrets) return { ...profile, apiKey: this.secrets.decrypt(ciphertext) };
    return { ...profile, apiKey: this.config.llm.apiKey };
  }
}

class RuntimeLlmProvider implements LlmProvider {
  constructor(private current: LlmProvider) {}

  get model(): string { return this.current.model; }
  get implementationVersion(): string | undefined { return this.current.implementationVersion; }
  get maxOutputTokens(): number | undefined { return this.current.maxOutputTokens; }
  get contextWindowTokens(): number | undefined { return this.current.contextWindowTokens; }
  chat(request: Parameters<LlmProvider['chat']>[0]): ReturnType<LlmProvider['chat']> { return this.current.chat(request); }
  stream(request: Parameters<LlmProvider['stream']>[0]): ReturnType<LlmProvider['stream']> { return this.current.stream(request); }
  set(provider: LlmProvider): void { this.current = provider; }
}

function toProfile(row: Record<string, unknown>): LlmProfileRecord {
  return {
    id: Number(row.id), name: String(row.name), platformKey: row.platform_key === 'volcengine' || row.platform_key === 'openai' || row.platform_key === 'deepseek' ? row.platform_key : 'custom', providerKey: 'openai-compatible', adapterType: 'openai-compatible',
    baseUrl: String(row.base_url), model: String(row.model), apiKey: undefined,
    timeoutMs: Number(row.timeout_ms), contextWindowTokens: Number(row.context_window_tokens), maxOutputTokens: Number(row.max_output_tokens),
    structuredOutput: 'required',
    supportsToolCalls: Boolean(row.supports_tool_calls), supportsStreaming: Boolean(row.supports_streaming),
    enabled: Boolean(row.enabled), isDefault: Boolean(row.is_default),
  };
}
