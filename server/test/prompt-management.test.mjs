import assert from 'node:assert/strict';
import test from 'node:test';
import { extractVariables, renderPrompt } from '../dist/prompts/prompt-renderer.js';

test('prompt renderer validates declared variables and preserves structured values', () => {
  const variables = { question: { type: 'string', required: true }, context: { type: 'array', required: false } };
  assert.deepEqual(extractVariables('问题：{{ question }}\n{{context}}'), ['question', 'context']);
  assert.equal(renderPrompt('问题：{{ question }}\n资料：{{ context }}', variables, { question: '怎么退款？', context: [{ title: '退款规则' }] }), '问题：怎么退款？\n资料：[{"title":"退款规则"}]');
});

test('prompt renderer rejects undeclared, missing and invalid variables', () => {
  assert.throws(() => renderPrompt('{{unknown}}', {}, {}), /未声明/);
  assert.throws(() => renderPrompt('{{question}}', { question: { type: 'string', required: true } }, {}), /缺少必填/);
  assert.throws(() => renderPrompt('{{question}}', { question: { type: 'string', required: true } }, { question: 1 }), /类型/);
});

test('optional unset variables render as empty text, not undefined or null', () => {
  const variables = { optional: {type:'string',required:false} };
  assert.equal(renderPrompt('a{{optional}}b',variables,{}),'ab');
  assert.equal(renderPrompt('a{{optional}}b',variables,{optional:null}),'ab');
});
test('failed renders cannot corrupt subsequent placeholder scans or accept inherited declarations', () => {
  const variables = { first: {type:'string',required:true}, second: {type:'string',required:true} };
  assert.throws(() => renderPrompt('{{first}}{{second}}',variables,{first:1}), /first/);
  assert.equal(renderPrompt('{{first}}{{second}}',variables,{first:'a',second:'b'}),'ab');
  assert.throws(() => renderPrompt('{{constructor}}',{},{}),/未声明/);
});
