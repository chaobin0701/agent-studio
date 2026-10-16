import type { SearchHit } from '../../documents/fuse-search-results';
import type { ChatAnswer } from '../../chat/chat.service';

const REFUSAL = '无法确定，建议联系人工。';

export function validateAnswer(raw: string, hits: SearchHit[]): ChatAnswer {
  const refusal: ChatAnswer = { answer: REFUSAL, refused: true, citations: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return refusal;
  }
  if (!parsed || typeof parsed !== 'object') return refusal;
  const result = parsed as Record<string, unknown>;
  if (result.status !== 'answered' || typeof result.answer !== 'string' || !result.answer.trim()) return refusal;
  if (!Array.isArray(result.citationIds) || result.citationIds.length === 0) return refusal;
  const byId = new Map(hits.map((hit) => [hit.chunkId, hit]));
  const ids = result.citationIds;
  if (ids.some((id) => !Number.isInteger(id) || !byId.has(id))) return refusal;
  const citations = [...new Set(ids as number[])].map((id) => {
    const hit = byId.get(id)!;
    return {
      chunkId: hit.chunkId,
      documentId: hit.documentId,
      documentTitle: hit.documentTitle,
      originalFilename: hit.originalFilename,
      sourceStartLine: hit.sourceStartLine,
      sourceEndLine: hit.sourceEndLine,
    };
  });
  return { answer: result.answer.trim(), refused: false, citations };
}
