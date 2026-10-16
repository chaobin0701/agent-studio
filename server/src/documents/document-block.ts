export type SourceLocator =
  | { type: 'markdown_lines'; start: number; end: number }
  | { type: 'pdf_page'; start: number; end: number }
  | { type: 'docx_paragraph'; start: number; end: number }
  | { type: 'faq_entry'; start: number; end: number };

export interface DocumentBlock {
  ordinal: number;
  blockType: 'paragraph' | 'code' | 'page' | 'faq';
  headingPath: string;
  content: string;
  sourceLocator: SourceLocator;
}

export const DOCUMENT_PARSER_VERSION = 'structured-v1';
