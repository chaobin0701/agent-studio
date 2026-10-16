import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { yaml, yamlFrontmatter } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import { frontmatterDiagnostics, frontmatterSection } from '../src/views/resources/skill/frontmatter.ts';

const valid = 'name: order-support # preserved\ndescription: |\n  核实订单异常\n  在订单咨询时使用\nmetadata:\n  author: support';
const skill = yaml => `---\n${yaml}\n---\n\n# 步骤\n\n核实后回答。\n`;

test('standard YAML supports comments, multiline descriptions and optional metadata', () => {
  assert.deepEqual(frontmatterDiagnostics(valid), []);
  assert.deepEqual(frontmatterDiagnostics(skill(valid), 'skill'), []);
});

test('required-field errors point at the actual value, with safe positions for empty input', () => {
  const text = 'name: BAD_NAME\ndescription: ""';
  const errors = frontmatterDiagnostics(text);
  assert.equal(errors.length, 2);
  assert.equal(text.slice(errors[0].from, errors[0].to), 'BAD_NAME');
  assert.equal(text.slice(errors[1].from, errors[1].to), '""');
  for (const e of frontmatterDiagnostics('')) assert.ok(e.from >= 0 && e.to <= 0);
});

test('syntax errors report line/column and include full-source frontmatter offset', () => {
  const input = 'name: order-support\ndescription: broken: yaml';
  const errors = frontmatterDiagnostics(input);
  assert.match(errors[0].message, /第 2 行、第/);
  const full = skill(input), fullErrors = frontmatterDiagnostics(full, 'skill');
  assert.match(fullErrors[0].message, /第 3 行、第/);
  assert.equal(fullErrors[0].from, errors[0].from + 4);
});

test('BOM and CRLF are recognized without corrupting marker positions or body', () => {
  const full = '\uFEFF' + skill(valid).replaceAll('\n', '\r\n');
  const section = frontmatterSection(full, 'skill');
  assert.equal(section.offset, 6);assert.match(section.body, /# 步骤/);
  assert.deepEqual(frontmatterDiagnostics(full, 'skill'), []);
});

test('missing delimiters and unsafe YAML are rejected; empty draft body gets a warning', () => {
  assert.match(frontmatterDiagnostics(valid, 'skill')[0].message, /分隔符/);
  assert.match(frontmatterDiagnostics('---\nname: test\ndescription: test\n---\n', 'skill')[0].message, /正文待补充/);
  assert.match(frontmatterDiagnostics('name: test\ndescription: &a hi\nmetadata: *a')[0].message, /别名/);
  assert.match(frontmatterDiagnostics('name: test\nname: again\ndescription: test')[0].message, /YAML 第/);
  assert.ok(frontmatterDiagnostics('name: test\ndescription: !env SECRET').length);
  assert.match(frontmatterDiagnostics('name: test\ndescription: test\n__proto__: {}')[0].message, /保留字段/);
});

test('native CodeMirror language support parses both YAML and Markdown inside SKILL.md', () => {
  const plain = EditorState.create({ doc: valid, extensions: [yaml()] });
  assert.match(syntaxTree(plain).toString(), /BlockMapping/);
  const full = EditorState.create({ doc: skill(valid), extensions: [yamlFrontmatter({ content: markdown() })] });
  assert.equal(syntaxTree(full).topNode.name, 'Document');
  const key = full.doc.toString().indexOf('order-support') + 2;
  const heading = full.doc.toString().indexOf('# 步骤') + 2;
  assert.match(syntaxTree(full).resolveInner(key).name, /Literal/);
  assert.match(syntaxTree(full).resolveInner(heading).name, /Heading/);
});
