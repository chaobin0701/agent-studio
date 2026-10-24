import { z } from 'zod';

const DEFAULT_LLM_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_LLM_ALLOWED_BASE_URLS = [
  DEFAULT_LLM_BASE_URL,
  'https://api.openai.com/v1',
  'https://api.deepseek.com/v1',
];
const DEFAULT_LLM_MODEL = 'deepseek-v4-1-flash-260910';
const DEFAULT_LLM_TIMEOUT_MS = 20_000;
const DEFAULT_LLM_CONTEXT_WINDOW_TOKENS = 32_000;
const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 1_200;
const DEFAULT_UPLOAD_ROOT = '/data/uploads';
const DEFAULT_TRUST_PROXY = 1;
const DEFAULT_CHAT_WINDOW_MS = 60_000;
const DEFAULT_CHAT_WINDOW_LIMIT = 10;
const DEFAULT_CHAT_CONCURRENCY = 5;
const DEFAULT_ADMIN_LOGIN_WINDOW_MS = 60_000;
const DEFAULT_ADMIN_LOGIN_LIMIT = 5;
const DEFAULT_DOCUMENT_UPLOAD_WINDOW_MS = 60_000;
const DEFAULT_DOCUMENT_UPLOAD_LIMIT = 50;
const DEFAULT_DOCUMENT_UPLOAD_CONCURRENCY = 2;
const DEFAULT_EMBEDDING_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_EMBEDDING_MODEL = 'doubao-embedding-vision-251215';

export const configSchema = z.object({
  port: z.coerce.number().int().min(1).max(65_535).default(3000),
  databaseUrl: z.string().trim().min(1).default(''),
  uploadRoot: z.string().trim().min(1).default(DEFAULT_UPLOAD_ROOT),
  jwt: z.object({
    secret: z.string().default(''),
    issuer: z.string().trim().min(1).default('agent-studio'),
    audience: z.string().trim().min(1).default('agent-studio-admin'),
    expiresInSeconds: z.coerce.number().int().min(60).max(86_400).default(86_400),
  }).default({ secret: '', issuer: 'agent-studio', audience: 'agent-studio-admin', expiresInSeconds: 86_400 }),
  modelConfigEncryptionKey: z.string().default(''),
  security: z.object({
    trustProxy: z.coerce.number().int().min(0).max(10).default(DEFAULT_TRUST_PROXY),
    allowedOrigins: z.array(z.string().url()).default([]),
    chatWindowMs: z.coerce.number().int().min(1_000).max(3_600_000).default(DEFAULT_CHAT_WINDOW_MS),
    chatWindowLimit: z.coerce.number().int().min(1).max(100).default(DEFAULT_CHAT_WINDOW_LIMIT),
    chatConcurrency: z.coerce.number().int().min(1).max(100).default(DEFAULT_CHAT_CONCURRENCY),
    adminLoginWindowMs: z.coerce.number().int().min(1_000).max(3_600_000).default(DEFAULT_ADMIN_LOGIN_WINDOW_MS),
    adminLoginLimit: z.coerce.number().int().min(1).max(50).default(DEFAULT_ADMIN_LOGIN_LIMIT),
    documentUploadWindowMs: z.coerce.number().int().min(1_000).max(3_600_000).default(DEFAULT_DOCUMENT_UPLOAD_WINDOW_MS),
    documentUploadLimit: z.coerce.number().int().min(1).max(50).default(DEFAULT_DOCUMENT_UPLOAD_LIMIT),
    documentUploadConcurrency: z.coerce.number().int().min(1).max(20).default(DEFAULT_DOCUMENT_UPLOAD_CONCURRENCY),
  }).default({
    trustProxy: DEFAULT_TRUST_PROXY,
    allowedOrigins: [],
    chatWindowMs: DEFAULT_CHAT_WINDOW_MS,
    chatWindowLimit: DEFAULT_CHAT_WINDOW_LIMIT,
    chatConcurrency: DEFAULT_CHAT_CONCURRENCY,
    adminLoginWindowMs: DEFAULT_ADMIN_LOGIN_WINDOW_MS,
    adminLoginLimit: DEFAULT_ADMIN_LOGIN_LIMIT,
    documentUploadWindowMs: DEFAULT_DOCUMENT_UPLOAD_WINDOW_MS,
    documentUploadLimit: DEFAULT_DOCUMENT_UPLOAD_LIMIT,
    documentUploadConcurrency: DEFAULT_DOCUMENT_UPLOAD_CONCURRENCY,
  }),
  embedding: z.object({
    apiKey: z.string().default(''),
    baseUrl: z.string().url().default(DEFAULT_EMBEDDING_BASE_URL),
    model: z.string().trim().min(1).default(DEFAULT_EMBEDDING_MODEL),
    // Legacy environment compatibility only; managed supplier URLs no longer use an allowlist.
    allowedBaseUrls: z.array(z.string().url()).default([DEFAULT_EMBEDDING_BASE_URL, 'https://api.openai.com/v1']),
    connections: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/u), z.object({
      baseUrl: z.string().url(), apiKey: z.string().min(1),
    }).strict()).default({}),
  }).default({ apiKey: '', baseUrl: DEFAULT_EMBEDDING_BASE_URL, model: DEFAULT_EMBEDDING_MODEL, allowedBaseUrls: [DEFAULT_EMBEDDING_BASE_URL, 'https://api.openai.com/v1'], connections: {} }),
  llm: z.object({
    provider: z.enum(['openai-compatible']).default('openai-compatible'),
    apiKey: z.string().default(''),
    baseUrl: z.string().url().default(DEFAULT_LLM_BASE_URL),
    model: z.string().trim().min(1).default(DEFAULT_LLM_MODEL),
    timeoutMs: z.coerce.number().int().min(1_000).max(120_000).default(DEFAULT_LLM_TIMEOUT_MS),
    contextWindowTokens: z.coerce.number().int().min(1_024).max(1_000_000).default(DEFAULT_LLM_CONTEXT_WINDOW_TOKENS),
    maxOutputTokens: z.coerce.number().int().min(128).max(32_000).default(DEFAULT_LLM_MAX_OUTPUT_TOKENS),
    // Legacy environment compatibility only; managed supplier URLs no longer use an allowlist.
    allowedBaseUrls: z.array(z.string().url()).default(DEFAULT_LLM_ALLOWED_BASE_URLS),
  }).default({
    provider: 'openai-compatible',
    apiKey: '',
    baseUrl: DEFAULT_LLM_BASE_URL,
    model: DEFAULT_LLM_MODEL,
    timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    contextWindowTokens: DEFAULT_LLM_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: DEFAULT_LLM_MAX_OUTPUT_TOKENS,
    allowedBaseUrls: DEFAULT_LLM_ALLOWED_BASE_URLS,
  }),
});

export type AppConfig = z.infer<typeof configSchema>;
export type LlmConfig = AppConfig['llm'];
export type JwtConfig = AppConfig['jwt'];
export type SecurityConfig = AppConfig['security'];
export type EmbeddingConfig = AppConfig['embedding'];

export function readConfigEnvironment(env: NodeJS.ProcessEnv = process.env): AppConfig {
  let embeddingConnections: unknown = {};
  if (env.EMBEDDING_CONNECTIONS_JSON?.trim()) {
    try { embeddingConnections = JSON.parse(env.EMBEDDING_CONNECTIONS_JSON); }
    catch { throw new Error('Invalid EMBEDDING_CONNECTIONS_JSON'); }
  }
  const parsed = configSchema.safeParse({
    port: env.PORT,
    databaseUrl: env.DATABASE_URL?.trim(),
    uploadRoot: env.UPLOAD_ROOT?.trim(),
    jwt: {
      secret: env.JWT_SECRET,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      expiresInSeconds: env.JWT_EXPIRES_IN_SECONDS,
    },
    modelConfigEncryptionKey: env.MODEL_CONFIG_ENCRYPTION_KEY?.trim(),
    security: {
      trustProxy: env.TRUST_PROXY,
      allowedOrigins: env.ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean),
      chatWindowMs: env.CHAT_RATE_WINDOW_MS,
      chatWindowLimit: env.CHAT_RATE_LIMIT,
      chatConcurrency: env.CHAT_CONCURRENCY,
      adminLoginWindowMs: env.ADMIN_LOGIN_RATE_WINDOW_MS,
      adminLoginLimit: env.ADMIN_LOGIN_RATE_LIMIT,
      documentUploadWindowMs: env.DOCUMENT_UPLOAD_RATE_WINDOW_MS,
      documentUploadLimit: env.DOCUMENT_UPLOAD_RATE_LIMIT,
      documentUploadConcurrency: env.DOCUMENT_UPLOAD_CONCURRENCY,
    },
    embedding: {
      apiKey: env.EMBEDDING_API_KEY?.trim(),
      baseUrl: env.EMBEDDING_BASE_URL?.trim(),
      model: env.EMBEDDING_MODEL?.trim(),
      allowedBaseUrls: env.EMBEDDING_ALLOWED_BASE_URLS?.split(',').map(value => value.trim()).filter(Boolean),
      connections: embeddingConnections,
    },
    llm: {
      provider: env.LLM_PROVIDER,
      apiKey: env.LLM_API_KEY?.trim(),
      baseUrl: env.LLM_BASE_URL?.trim(),
      model: env.LLM_MODEL?.trim(),
      timeoutMs: env.LLM_TIMEOUT_MS,
      contextWindowTokens: env.LLM_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
      allowedBaseUrls: env.LLM_ALLOWED_BASE_URLS?.split(',').map((value) => value.trim()).filter(Boolean),
    },
  });
  if (!parsed.success) {
    const names: Record<string, string> = {
      port: 'PORT',
      databaseUrl: 'DATABASE_URL',
      uploadRoot: 'UPLOAD_ROOT',
      'jwt.secret': 'JWT_SECRET',
      'jwt.issuer': 'JWT_ISSUER',
      'jwt.audience': 'JWT_AUDIENCE',
      'jwt.expiresInSeconds': 'JWT_EXPIRES_IN_SECONDS',
      modelConfigEncryptionKey: 'MODEL_CONFIG_ENCRYPTION_KEY',
      'security.trustProxy': 'TRUST_PROXY',
      'security.allowedOrigins': 'ALLOWED_ORIGINS',
      'security.chatWindowMs': 'CHAT_RATE_WINDOW_MS',
      'security.chatWindowLimit': 'CHAT_RATE_LIMIT',
      'security.chatConcurrency': 'CHAT_CONCURRENCY',
      'security.adminLoginWindowMs': 'ADMIN_LOGIN_RATE_WINDOW_MS',
      'security.adminLoginLimit': 'ADMIN_LOGIN_RATE_LIMIT',
      'security.documentUploadWindowMs': 'DOCUMENT_UPLOAD_RATE_WINDOW_MS',
      'security.documentUploadLimit': 'DOCUMENT_UPLOAD_RATE_LIMIT',
      'security.documentUploadConcurrency': 'DOCUMENT_UPLOAD_CONCURRENCY',
      'embedding.apiKey': 'EMBEDDING_API_KEY',
      'embedding.baseUrl': 'EMBEDDING_BASE_URL',
      'embedding.model': 'EMBEDDING_MODEL',
      'embedding.allowedBaseUrls': 'EMBEDDING_ALLOWED_BASE_URLS',
      'llm.provider': 'LLM_PROVIDER',
      'llm.apiKey': 'LLM_API_KEY',
      'llm.baseUrl': 'LLM_BASE_URL',
      'llm.model': 'LLM_MODEL',
      'llm.timeoutMs': 'LLM_TIMEOUT_MS',
      'llm.contextWindowTokens': 'LLM_CONTEXT_WINDOW_TOKENS',
      'llm.maxOutputTokens': 'LLM_MAX_OUTPUT_TOKENS',
      'llm.allowedBaseUrls': 'LLM_ALLOWED_BASE_URLS',
    };
    const details = parsed.error.issues
      .map((issue) => `${names[issue.path.join('.')] ?? (issue.path.join('.') || 'config')} ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  return parsed.data;
}
