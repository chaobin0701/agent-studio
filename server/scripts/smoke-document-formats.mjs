import assert from 'node:assert/strict';
import JSZip from 'jszip';

const base = process.env.EVAL_API_BASE_URL || 'http://localhost:8081';
const email = process.env.EVAL_ADMIN_EMAIL;
const password = process.env.EVAL_ADMIN_PASSWORD;
if (!email || !password) throw new Error('Set EVAL_ADMIN_EMAIL and EVAL_ADMIN_PASSWORD in the terminal environment');

async function docxFixture() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>E2E fixture warranty lasts twelve months.</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

function pdfFixture(text = 'E2E fixture warranty lasts twelve months.') {
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

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const login = await request('/api/admin/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
});
const headers = { Authorization: `Bearer ${login.accessToken}` };

async function uploadAndCheck(filename, bytes, expectedStatus, expectedUnit) {
  const form = new FormData();
  form.set('title', `格式验收 ${filename}`);
  form.set('file', new Blob([bytes]), filename);
  const created = await request('/api/admin/documents', { method: 'POST', headers, body: form });
  try {
    let detail;
    for (let attempt = 0; attempt < 45; attempt += 1) {
      detail = await request(`/api/admin/documents/${created.id}`, { headers });
      if (detail.status === 'ready' || detail.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    assert.equal(detail.status, expectedStatus, `${filename}: ${detail.errorMessage || 'processing did not finish'}`);
    if (expectedStatus === 'ready') {
      assert.match(detail.extractedText, /E2E fixture warranty lasts twelve months/);
      const chunks = await request(`/api/admin/documents/${created.id}/chunks`, { headers });
      assert.ok(chunks.length > 0);
      assert.equal(chunks[0].sourceStartLine, expectedUnit);
    } else {
      assert.match(detail.errorMessage, /scanned PDFs are not supported/);
    }
    console.log(`${filename}: ${detail.status}, document #${created.id}`);
  } finally {
    await request(`/api/admin/documents/${created.id}/archive`, { method: 'PATCH', headers });
  }
}

await uploadAndCheck('e2e-docx.docx', await docxFixture(), 'ready', 1);
await uploadAndCheck('e2e-text.pdf', pdfFixture(), 'ready', 1);
await uploadAndCheck('e2e-scan.pdf', pdfFixture(''), 'failed');
console.log('Format smoke test passed; all test documents archived.');
