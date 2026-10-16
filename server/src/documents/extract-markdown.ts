import MarkdownIt from 'markdown-it';
import { DocumentBlock } from './document-block';

const parser = new MarkdownIt({ html: false });
type MarkdownToken = ReturnType<typeof parser.parse>[number];
const DEFAULT_MAX_CHARS = 800;
const DEFAULT_OVERLAP_CHARS = 60;

export interface DocumentChunk {
  ordinal: number;
  headingPath: string;
  content: string;
  sourceStartLine: number;
  sourceEndLine: number;
}

interface TextBlock {
  content: string;
  startLine: number;
  endLine: number;
}

function inlineText(token: MarkdownToken): string {
  return (token.children ?? []).map((child) => {
    if (child.type === 'text' || child.type === 'code_inline' || child.type === 'image') return child.content;
    if (child.type === 'softbreak' || child.type === 'hardbreak') return '\n';
    return '';
  }).join('').trim();
}

function splitLongBlock(block: TextBlock, maxChars: number, overlapChars: number): TextBlock[] {
  const chars = Array.from(block.content);
  if (chars.length <= maxChars) return [block];
  const pieces: TextBlock[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + maxChars, chars.length);
    if (end < chars.length) {
      const earliest = start + Math.floor(maxChars * 0.6);
      for (let i = end - 1; i >= earliest; i--) {
        if (/[。！？；.!?;\n\s]/u.test(chars[i])) {
          end = i + 1;
          break;
        }
      }
    }
    const content = chars.slice(start, end).join('').trim();
    if (content) pieces.push({ ...block, content });
    if (end === chars.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return pieces;
}

export function parseMarkdownDocument(source: string, maxChars = DEFAULT_MAX_CHARS, overlapChars = DEFAULT_OVERLAP_CHARS): {
  extractedText: string;
  chunks: DocumentChunk[];
  blocks: DocumentBlock[];
} {
  if (!Number.isSafeInteger(maxChars) || maxChars < 200 || maxChars > 4000 ||
      !Number.isSafeInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error('Invalid chunk size or overlap');
  }
  const tokens = parser.parse(source, {});
  const headings: string[] = [];
  const extractedParts: string[] = [];
  const chunks: DocumentChunk[] = [];
  const structuredBlocks: DocumentBlock[] = [];
  let blocks: TextBlock[] = [];
  let sectionHeading = '';

  function flushSection(): void {
    let current: TextBlock | null = null;
    for (const block of blocks.flatMap((item) => splitLongBlock(item, maxChars, overlapChars))) {
      if (current && Array.from(current.content).length + 2 + Array.from(block.content).length > maxChars) {
        chunks.push({
          ordinal: chunks.length + 1,
          headingPath: sectionHeading,
          content: current.content,
          sourceStartLine: current.startLine,
          sourceEndLine: current.endLine,
        });
        current = null;
      }
      current = current
        ? { content: `${current.content}\n\n${block.content}`, startLine: current.startLine, endLine: block.endLine }
        : { ...block };
    }
    if (current) {
      chunks.push({
        ordinal: chunks.length + 1,
        headingPath: sectionHeading,
        content: current.content,
        sourceStartLine: current.startLine,
        sourceEndLine: current.endLine,
      });
    }
    blocks = [];
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open') {
      flushSection();
      const heading = tokens[i + 1]?.type === 'inline' ? inlineText(tokens[i + 1]) : '';
      const level = Number(token.tag.slice(1));
      if (Number.isInteger(level) && level >= 1 && level <= 6) {
        headings.length = level - 1;
        headings[level - 1] = heading;
        sectionHeading = headings.filter(Boolean).join(' > ');
      }
      if (heading) extractedParts.push(heading);
      continue;
    }
    if (token.type === 'inline' && tokens[i - 1]?.type === 'heading_open') continue;
    if (token.type !== 'inline' && token.type !== 'fence' && token.type !== 'code_block') continue;
    const content = token.type === 'inline' ? inlineText(token) : token.content.trim();
    if (!content) continue;
    extractedParts.push(content);
    structuredBlocks.push({
      ordinal: structuredBlocks.length + 1,
      blockType: token.type === 'inline' ? 'paragraph' : 'code',
      headingPath: sectionHeading, content,
      sourceLocator: { type: 'markdown_lines', start: (token.map?.[0] ?? 0) + 1, end: token.map?.[1] ?? 1 },
    });
    blocks.push({
      content,
      startLine: (token.map?.[0] ?? 0) + 1,
      endLine: token.map?.[1] ?? 1,
    });
  }
  flushSection();
  return { extractedText: extractedParts.join('\n\n').trim(), chunks, blocks: structuredBlocks };
}

export function extractMarkdownText(source: string): string {
  return parseMarkdownDocument(source).extractedText;
}
