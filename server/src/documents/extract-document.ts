import { extname } from 'node:path';
import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { DocumentChunk, parseMarkdownDocument } from './extract-markdown';
import { DocumentBlock } from './document-block';
import { parseFragment, DefaultTreeAdapterTypes } from 'parse5';

const MAX_EXTRACTED_CHARS = 100_000;
const MAX_CHUNKS = 200;
const MAX_PDF_PAGES = 100;
const DEFAULT_CHUNK_CHARS = 800;
const DEFAULT_OVERLAP_CHARS = 60;

export class ScannedPdfError extends Error {
  constructor() { super('PDF contains no selectable text; scanned PDFs are not supported'); }
}

export type ParsedDocument = { extractedText: string; chunks: DocumentChunk[]; blocks: DocumentBlock[]; warnings?: string[] };
type TextBlock = { headingPath: string; content: string; sourceStartLine: number; sourceEndLine: number };

function chunkPlainText(blocks: TextBlock[], chunkChars: number, overlapChars: number): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let current: TextBlock | undefined;
  const flush = () => {
    if (current) chunks.push({ ...current, ordinal: chunks.length + 1 });
    current = undefined;
  };
  for (const block of blocks) {
    const characters = Array.from(block.content);
    const pieces: string[] = [];
    if (characters.length <= chunkChars) pieces.push(block.content);
    else {
      for (let start = 0; start < characters.length;) {
        const end = Math.min(start + chunkChars, characters.length);
        pieces.push(characters.slice(start, end).join('').trim());
        if (end === characters.length) break;
        start = Math.max(start + 1, end - overlapChars);
      }
    }
    for (const piece of pieces.filter(Boolean)) {
      if (current && (current.headingPath !== block.headingPath || Array.from(current.content).length + piece.length + 2 > chunkChars)) flush();
      current = current
        ? { ...current, content: `${current.content}\n\n${piece}`, sourceEndLine: block.sourceEndLine }
        : { ...block, content: piece };
    }
  }
  flush();
  return chunks;
}

function ensureLimits(parsed: ParsedDocument): ParsedDocument {
  if (!parsed.extractedText.trim() || !parsed.chunks.length) throw new Error('Document contains no readable text');
  if (Array.from(parsed.extractedText).length > MAX_EXTRACTED_CHARS || parsed.chunks.length > MAX_CHUNKS) {
    throw new Error('Document exceeds text or chunk limit');
  }
  return parsed;
}

async function parseDocx(bytes: Buffer, chunkChars: number, overlapChars: number): Promise<ParsedDocument> {
  const result = await mammoth.convertToHtml({ buffer: bytes }, { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
  const headings: string[] = [];
  const blocks: TextBlock[] = [];
  let paragraph = 0;
  function text(node: DefaultTreeAdapterTypes.Node): string {
    if ('value' in node) return node.value;
    if ('tagName' in node && node.tagName === 'br') return '\n';
    return 'childNodes' in node ? node.childNodes.map(text).join('') : '';
  }
  function visit(node: DefaultTreeAdapterTypes.Node): void {
    if ('tagName' in node && /^h[1-6]$/u.test(node.tagName)) {
      paragraph++;
      headings.length = Number(node.tagName[1]) - 1;
      headings.push(text(node).trim());
      return;
    }
    if ('tagName' in node && ['p', 'li', 'pre'].includes(node.tagName)) {
      paragraph++;
      const content = text(node).trim();
      if (content) blocks.push({ content, headingPath: headings.filter(Boolean).join(' > ') || '正文', sourceStartLine: paragraph, sourceEndLine: paragraph });
      return;
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  }
  visit(parseFragment(result.value));
  return ensureLimits({
    extractedText: blocks.map((block) => block.content).join('\n\n'),
    blocks: blocks.map((block, index) => ({ ordinal: index + 1, blockType: 'paragraph',
      headingPath: block.headingPath, content: block.content,
      sourceLocator: { type: 'docx_paragraph', start: block.sourceStartLine, end: block.sourceEndLine } })),
    chunks: chunkPlainText(blocks, chunkChars, overlapChars),
    warnings: result.messages.length ? ['Word parser reported unsupported formatting; check the extracted blocks.'] : [],
  });
}

async function parsePdf(bytes: Buffer, chunkChars: number, overlapChars: number): Promise<ParsedDocument> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true });
  try {
    const document = await task.promise;
    if (document.numPages > MAX_PDF_PAGES) throw new Error('PDF exceeds page limit');
    const blocks: TextBlock[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : ''))
        .join('').replace(/[ \t]+/gu, ' ').replace(/\n+/gu, '\n').trim();
      if (text) blocks.push({ headingPath: `第 ${pageNumber} 页`, content: text, sourceStartLine: pageNumber, sourceEndLine: pageNumber });
      page.cleanup();
    }
    if (!blocks.length) throw new ScannedPdfError();
    return ensureLimits({
      extractedText: blocks.map((block) => `${block.headingPath}\n${block.content}`).join('\n\n'),
      blocks: blocks.map((block, index) => ({ ordinal: index + 1, blockType: 'page',
        headingPath: block.headingPath, content: block.content,
        sourceLocator: { type: 'pdf_page', start: block.sourceStartLine, end: block.sourceEndLine } })),
      chunks: chunkPlainText(blocks, chunkChars, overlapChars),
      warnings: blocks.length < document.numPages ? ['Some PDF pages contain no selectable text and were skipped. OCR is not supported.'] : [],
    });
  } finally {
    await task.destroy();
  }
}

export async function parseDocument(bytes: Buffer, storageKey: string,
  chunkChars = DEFAULT_CHUNK_CHARS, overlapChars = DEFAULT_OVERLAP_CHARS,
  options?: { separatorMode?: 'auto' | 'heading_paragraph' | 'fixed'; preserveHeading?: boolean }): Promise<ParsedDocument> {
  let parsed: ParsedDocument;
  switch (extname(storageKey)) {
    case '.md': parsed = ensureLimits(parseMarkdownDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes), chunkChars, overlapChars)); break;
    case '.docx': parsed = await parseDocx(bytes, chunkChars, overlapChars); break;
    case '.pdf': parsed = await parsePdf(bytes, chunkChars, overlapChars); break;
    default: throw new Error('Unsupported stored document format');
  }
  if (options?.separatorMode === 'fixed') {
    parsed.chunks = chunkPlainText([{ headingPath: '', content: parsed.blocks.map(block => block.content).join('\n\n'),
      sourceStartLine: parsed.blocks[0].sourceLocator.start,
      sourceEndLine: parsed.blocks.at(-1)!.sourceLocator.end }], chunkChars, overlapChars);
  } else if (options?.separatorMode === 'heading_paragraph') {
    parsed.chunks = parsed.blocks.flatMap(block => chunkPlainText([{ headingPath: block.headingPath, content: block.content,
      sourceStartLine: block.sourceLocator.start, sourceEndLine: block.sourceLocator.end }], chunkChars, overlapChars))
      .map((chunk, index) => ({ ...chunk, ordinal: index + 1 }));
  }
  if (options?.preserveHeading === false) parsed.chunks = parsed.chunks.map(chunk => ({ ...chunk, headingPath: '' }));
  return ensureLimits(parsed);
}
