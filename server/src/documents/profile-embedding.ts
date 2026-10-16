import { z } from 'zod';
import { AppConfigService } from '../config/config.service';
import { normalizeModelBaseUrl } from '../config/model-base-url';
import { createHash } from 'node:crypto';
import { providerDiagnostics } from '../ai/providers/provider-errors';

export const embeddingProfileSchema = z.object({
  provider: z.enum(['openai-compatible', 'volcengine-multimodal']),
  baseUrl: z.string().url(), model: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/u),
  dimensions: z.number().int().min(1).max(4096),
  maxInputChars: z.number().int().min(200).max(32000).default(8000),
  batchSize: z.number().int().min(1).max(64).default(16),
  secretRef: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/u).default('default'),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  profileId: z.number().int().positive().optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();
export type EmbeddingProfile = z.infer<typeof embeddingProfileSchema>;

export class EmbeddingDimensionError extends Error {
  constructor(readonly expectedDimensions: number, readonly actualDimensions: number) { super('Embedding dimension does not match configuration'); }
}

export class EmbeddingRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number,
    readonly diagnostics?: { message?: string; code?: string }) { super(message); }
}

export function embeddingFingerprint(profile: EmbeddingProfile): string {
  return createHash('sha256').update([profile.provider, profile.baseUrl.replace(/\/+$/, ''), profile.model, profile.dimensions].join('\n')).digest('hex');
}

export function validateManagedEndpoint(profile: EmbeddingProfile, _config: AppConfigService): void {
  normalizeModelBaseUrl(profile.baseUrl);
}

/** Explicit credential binding: a profile cannot read arbitrary environment variables.
 * Only managed, explicitly supplied credentials can use an arbitrary endpoint. */
export function validateProfileEndpoint(profile: EmbeddingProfile, config: AppConfigService): void {
  const target = new URL(profile.baseUrl);
  const connection = profile.secretRef === 'default' ? config.embedding : config.embedding.connections?.[profile.secretRef];
  if (!connection) throw new Error('Unknown embedding credential reference');
  const approved = new URL(connection.baseUrl);
  if (target.username || target.password || target.search || target.hash ||
      target.href.replace(/\/+$/, '') !== approved.href.replace(/\/+$/, '')) {
    throw new Error('Embedding base URL must match the configured EMBEDDING_BASE_URL');
  }
}

export async function embedWithProfile(profile: EmbeddingProfile, inputs: string[], config: AppConfigService, managedCredential?: { apiKey: string },signal?:AbortSignal): Promise<number[][]> {
  signal?.throwIfAborted();
  if (managedCredential) validateManagedEndpoint(profile, config);
  else {
    if (profile.profileId) throw new Error('Managed embedding profile requires credential resolution');
    validateProfileEndpoint(profile, config);
  }
  const connection = managedCredential ?? (profile.secretRef === 'default' ? config.embedding : config.embedding.connections?.[profile.secretRef]);
  if (!connection?.apiKey) throw new Error('Embedding credential is not configured');
  if (inputs.some((input) => !input.trim() || Array.from(input).length > profile.maxInputChars)) throw new Error('Embedding input exceeds profile limit');
  const batchSize = profile.provider === 'volcengine-multimodal' ? 1 : profile.batchSize;
  const vectors: number[][] = [];
  const vectorSchema = z.array(z.number().finite()).min(1).refine(v => v.some(n => n !== 0));
  const checkDimensions = (vector: number[]) => {
    if (vector.length !== profile.dimensions) throw new EmbeddingDimensionError(profile.dimensions, vector.length);
    return vector;
  };
  for (let offset = 0; offset < inputs.length; offset += batchSize) {
    signal?.throwIfAborted();
    const batch = inputs.slice(offset, offset + batchSize);
    const multimodal = profile.provider === 'volcengine-multimodal';
    let response: Response;
    try {
      response = await fetch(`${profile.baseUrl.replace(/\/+$/, '')}/embeddings${multimodal ? '/multimodal' : ''}`, {
        method: 'POST', redirect: 'error', signal: signal?AbortSignal.any([signal,AbortSignal.timeout(profile.timeoutMs ?? 30000)]):AbortSignal.timeout(profile.timeoutMs ?? 30000),
        headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: profile.model, encoding_format: 'float',
          input: multimodal ? [{ type: 'text', text: batch[0] }] : batch }),
      });
    } catch (error) {
      signal?.throwIfAborted();
      const timeout = error instanceof DOMException && error.name === 'TimeoutError';
      throw new EmbeddingRequestError('Embedding request failed or timed out', timeout ? 'provider_timeout' : 'provider_connection');
    }
    if (!response.ok) {
      let payload: unknown;
      try { payload = await response.json(); } catch { /* Status is still useful without JSON. */ }
      throw new EmbeddingRequestError(`Embedding returned HTTP ${response.status}`, 'embedding_http_error', response.status, providerDiagnostics(payload, connection.apiKey));
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error('Invalid embedding response'); }
    signal?.throwIfAborted();
    if (multimodal) vectors.push(checkDimensions(z.object({ data: z.object({ embedding: vectorSchema }) }).parse(payload).data.embedding));
    else {
      const data = z.object({ data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: vectorSchema })).length(batch.length) }).parse(payload).data;
      data.sort((a, b) => a.index - b.index);
      if (data.some((item, index) => item.index !== index)) throw new Error('Invalid embedding batch indexes');
      vectors.push(...data.map(item => checkDimensions(item.embedding)));
    }
  }
  return vectors;
}
