export type LlmPlatformKey = 'volcengine' | 'openai' | 'deepseek' | 'custom';

export type LlmPlatformPreset = {
  key: LlmPlatformKey;
  label: string;
  description: string;
  baseUrl: string;
  model: string;
};

/** Presets describe connection defaults; every entry still uses the same OpenAI-compatible adapter. */
export const LLM_PLATFORM_PRESETS: readonly LlmPlatformPreset[] = [
  {
    key: 'volcengine',
    label: '火山引擎方舟',
    description: '火山引擎 Ark 的 OpenAI Compatible 接口',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'deepseek-v4-1-flash-260910',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    description: 'OpenAI 官方接口',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek 官方 OpenAI Compatible 接口',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    key: 'custom',
    label: '其他兼容平台',
    description: '填写兼容接口的 HTTP 或 HTTPS 地址，支持代理及自建服务',
    baseUrl: '',
    model: '',
  },
];

export function isLlmPlatformKey(value: unknown): value is LlmPlatformKey {
  return LLM_PLATFORM_PRESETS.some((preset) => preset.key === value);
}

export function getLlmPlatformPreset(key: LlmPlatformKey): LlmPlatformPreset {
  return LLM_PLATFORM_PRESETS.find((preset) => preset.key === key) ?? LLM_PLATFORM_PRESETS[LLM_PLATFORM_PRESETS.length - 1]!;
}
