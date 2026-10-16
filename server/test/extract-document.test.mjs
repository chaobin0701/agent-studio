import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { parseDocument, ScannedPdfError } from '../dist/documents/extract-document.js';

async function docxFixture() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Warranty is twelve months.</w:t></w:r></w:p><w:p><w:r><w:t>Keep the receipt.</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

function pdfFixture(text = 'Warranty is twelve months.') {
  const content = text ? `BT /F1 12 Tf 50 150 Td (${text}) Tj ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, '0')} 00000 n \n`;
  source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(source);
}

test('DOCX raw text is chunked with paragraph locations', async () => {
  const parsed = await parseDocument(await docxFixture(), '123e4567-e89b-12d3-a456-426614174000.docx');
  assert.match(parsed.extractedText, /Warranty is twelve months/);
  assert.match(parsed.chunks[0].content, /Keep the receipt/);
  assert.equal(parsed.chunks[0].sourceStartLine, 1);
  assert.equal(parsed.chunks[0].sourceEndLine, 2);
});

test('PDF selectable text is chunked with page location', async () => {
  const parsed = await parseDocument(pdfFixture(), '123e4567-e89b-12d3-a456-426614174000.pdf');
  assert.match(parsed.extractedText, /Warranty is twelve months/);
  assert.equal(parsed.chunks[0].sourceStartLine, 1);
  assert.equal(parsed.chunks[0].sourceEndLine, 1);
});

test('image-only PDF is reported as unsupported rather than indexed', async () => {
  await assert.rejects(() => parseDocument(pdfFixture(''), '123e4567-e89b-12d3-a456-426614174000.pdf'), ScannedPdfError);
});

test('Markdown extraction still works', async () => {
  const parsed = await parseDocument(Buffer.from('# Returns\n\nSeven days.'), '123e4567-e89b-12d3-a456-426614174000.md');
  assert.match(parsed.extractedText, /Seven days/);
  assert.equal(parsed.chunks[0].sourceStartLine, 3);
});
