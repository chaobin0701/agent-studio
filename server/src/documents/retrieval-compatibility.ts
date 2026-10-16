import { BadRequestException } from '@nestjs/common';
import { embeddingFingerprint, embeddingProfileSchema } from './profile-embedding';

/** Compare vector spaces, never just dimensions or mutable plan names. */
export function indexEmbeddingFingerprint(snapshot: unknown): string | null {
  const parsed = embeddingProfileSchema.safeParse(snapshot);
  return parsed.success ? embeddingFingerprint(parsed.data) : null;
}

export function retrievalDecision(indexMode: string, requested: 'auto'|'fulltext'|'vector'|'hybrid',
  indexFingerprint: string | null, selectedFingerprint?: string) {
  const desired = requested === 'auto' ? (indexMode === 'economy' ? 'fulltext' : 'hybrid') : requested;
  const reason = desired === 'fulltext' ? null
    : indexMode !== 'high_quality' ? 'index_has_no_vectors'
    : !indexFingerprint ? 'index_model_unavailable'
    : selectedFingerprint && selectedFingerprint !== indexFingerprint ? 'model_mismatch' : null;
  if (desired === 'vector' && reason) throw new BadRequestException('向量检索仅支持已开启向量索引且与 Agent 所选模型兼容的知识库');
  return { mode: reason ? 'fulltext' as const : desired, fallbackReason: reason };
}
