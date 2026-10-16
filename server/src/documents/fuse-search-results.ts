export interface SearchHit {
  chunkId: number;
  documentId: number;
  documentTitle: string;
  originalFilename: string;
  ordinal: number;
  headingPath: string;
  content: string;
  sourceStartLine: number;
  sourceEndLine: number;
  sourceLocator?: { type: string; start: number; end: number };
  score: number;
  indexKind?: 'live' | 'published';
  indexVersionId?: number;
  knowledgeBaseId?: number;
  contentTruncated?: boolean;
}

export function fuseSearchResults(lexical: SearchHit[], vector: SearchHit[], limit: number): Array<SearchHit & {
  lexicalRank: number | null;
  vectorRank: number | null;
  fusionScore: number;
}> {
  const combined = new Map<number, SearchHit & { lexicalRank: number | null; vectorRank: number | null; fusionScore: number }>();
  for (const [source, hits] of [['lexical', lexical], ['vector', vector]] as const) {
    hits.forEach((hit, index) => {
      const current = combined.get(hit.chunkId) ?? { ...hit, lexicalRank: null, vectorRank: null, fusionScore: 0 };
      if (source === 'lexical') current.lexicalRank = index + 1;
      else current.vectorRank = index + 1;
      current.fusionScore += 1 / (60 + index + 1);
      combined.set(hit.chunkId, current);
    });
  }
  return [...combined.values()]
    .sort((a, b) => b.fusionScore - a.fusionScore || a.documentId - b.documentId || a.ordinal - b.ordinal)
    .slice(0, limit)
    .map((hit) => ({ ...hit, fusionScore: Number(hit.fusionScore.toFixed(6)) }));
}
