import type { LlmPlatformKey } from './llm-platforms';

export type LlmProfileRecord = {
  id: number;
  name: string;
  platformKey: LlmPlatformKey;
  providerKey: 'openai-compatible';
  adapterType: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  contextWindowTokens: number;
  maxOutputTokens: number;
  structuredOutput: 'required';
  supportsToolCalls: boolean;
  supportsStreaming: boolean;
  enabled: boolean;
  isDefault: boolean;
};

export type LlmProfileView = Omit<LlmProfileRecord, 'apiKey'> & { hasApiKey: boolean; apiKeyPreview: string | null };
