import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, loadCases } from '../scripts/evaluate-agent.mjs';

test('offline evaluation covers the baseline cases without a remote model', async () => {
  const report = await evaluate(await loadCases());
  assert.equal(report.mode, 'offline');
  assert.equal(report.executionEngine, 'deepagents');
  assert.equal(report.summary.total, 8);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.passed, true);
});

test('evaluation can run one named case', async () => {
  const report = await evaluate(await loadCases(), 'returns-basic');
  assert.deepEqual(report.cases.map((item) => item.caseId), ['returns-basic']);
  assert.equal(report.passed, true);
});
