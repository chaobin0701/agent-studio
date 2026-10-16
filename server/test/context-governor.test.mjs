import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextGovernor, estimateTokens } from '../dist/chat/context-governor.js';

test('context governor calculates input budget and pressure without truncating content', () => {
  const governor = new ContextGovernor({ llm: { contextWindowTokens: 10_000, maxOutputTokens: 1_000 } });
  const budget = governor.inspect({
    systemPrompt: '系统规则',
    userPrompt: '用户问题和工具结果'.repeat(100),
    purpose: 'planner',
    rawMessageCount: 8,
    includedMessageCount: 8,
  });

  assert.equal(budget.contextWindowTokens, 10_000);
  assert.equal(budget.maxOutputTokens, 1_000);
  assert.equal(budget.safetyBufferTokens, 1_024);
  assert.equal(budget.inputBudgetTokens, 7_976);
  assert.equal(budget.measurementSource, 'heuristic');
  assert.equal(budget.compacted, false);
  assert.equal(budget.pressure, 'normal');
  assert.equal(budget.rawMessageCount, 8);
  assert.equal(budget.includedMessageCount, 8);
});

test('context governor reports overflow instead of silently dropping transcript data', () => {
  const governor = new ContextGovernor({ llm: { contextWindowTokens: 2_000, maxOutputTokens: 500 } });
  const budget = governor.inspect({ systemPrompt: '系统', userPrompt: 'x'.repeat(10_000), purpose: 'planner' });
  assert.equal(budget.pressure, 'overflow');
  assert.ok(budget.estimatedInputTokens > budget.inputBudgetTokens);
  assert.equal(estimateTokens('abcd'), 2);
});
