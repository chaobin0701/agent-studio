import { DocumentBlock, SourceLocator } from './document-block';
import { BuildConfig } from './knowledge-config';

export interface IndexChunk {
  ordinal: number;
  kind: 'general' | 'parent' | 'child' | 'faq';
  parentOrdinal: number | null;
  headingPath: string;
  content: string;
  sourceLocator: SourceLocator;
}

function split(content: string, size: number, overlap: number): { content: string; start: number; end: number }[] {
  const characters = Array.from(content);
  const result: { content: string; start: number; end: number }[] = [];
  for (let start = 0; start < characters.length;) {
    let end = Math.min(start + size, characters.length);
    if (end < characters.length) {
      for (let i=end-1; i >= start+Math.max(overlap+1,Math.floor(size*0.6)); i--) {
        if (/[\n。！？；.!?;\s]/u.test(characters[i])) { end=i+1; break; }
      }
    }
    const part = characters.slice(start, end).join('').trim();
    if (part) result.push({ content: part, start, end });
    if (end >= characters.length) break;
    start=Math.max(start+1,end-overlap);
  }
  return result;
}

/** Source blocks are never mutated. Sections and source types are never mixed. */
export function buildChunks(blocks: DocumentBlock[], config: BuildConfig): IndexChunk[] {
  const result: IndexChunk[] = [];
  const size = config.chunkMode === 'general' ? config.chunkChars : config.parentChars;
  const overlap = config.chunkMode === 'general' ? config.overlapChars : 0;
  let pending: DocumentBlock[] = [];
  const flush = () => {
    if (!pending.length) return;
    let offset = 0;
    const ranges = pending.map((block) => {
      const start = offset;
      offset += Array.from(block.content).length + 2;
      return { block, start, end: offset - 2 };
    });
    for (const piece of split(pending.map((block) => block.content).join('\n\n'), size, overlap)) {
      const covered = ranges.filter((range) => range.end > piece.start && range.start < piece.end);
      if (!covered.length) continue;
      const sourceLocator: SourceLocator = { ...covered[0].block.sourceLocator, end: covered[covered.length - 1].block.sourceLocator.end };
      const headingPath = pending[0].headingPath;
      const content = piece.content;
      const ordinal = result.length + 1;
      result.push({ headingPath, sourceLocator, content, ordinal, kind: config.chunkMode === 'general' ? 'general' : 'parent', parentOrdinal: null });
      if (config.chunkMode === 'parent_child') {
        for (const child of split(content, config.childChars, config.childOverlapChars)) {
          result.push({ headingPath, sourceLocator, content: child.content, ordinal: result.length + 1, kind: 'child', parentOrdinal: ordinal });
        }
      }
    }
    pending = [];
  };
  for (const block of blocks) {
    if (block.blockType === 'faq') {
      flush();
      result.push({ ordinal: result.length + 1, kind: 'faq', parentOrdinal: null,
        headingPath: block.headingPath, content: block.content, sourceLocator: block.sourceLocator });
      continue;
    }
    if (pending.length && (pending[0].headingPath !== block.headingPath || pending[0].sourceLocator.type !== block.sourceLocator.type ||
      (block.sourceLocator.type === 'pdf_page' && pending[0].sourceLocator.start !== block.sourceLocator.start))) flush();
    pending.push(block);
  }
  flush();
  if (result.length > 2000) throw new Error('Document exceeds 2000 index chunks');
  return result;
}

/** ICU word segmentation supports Chinese without a PostgreSQL extension. */
export function searchTokens(text: string): string {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  return Array.from(segmenter.segment(text.toLowerCase())).filter((part) => part.isWordLike).map((part) => part.segment).join(' ');
}
