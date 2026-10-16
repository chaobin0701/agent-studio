import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatService, retrievalQuery, validateAnswer } from '../dist/chat/chat.service.js';
import { ChatRateLimitService } from '../dist/chat/chat-rate-limit.service.js';
import { LlmService, calculateLlmRetryDelayMs } from '../dist/chat/llm.service.js';
import { ProviderQuotaExhaustedError, ProviderTimeoutError } from '../dist/ai/providers/provider-errors.js';
import { OpenAICompatibleProvider } from '../dist/ai/providers/openai-compatible.provider.js';

function testLlmProvider(apiKey) {
  return new OpenAICompatibleProvider({
    apiKey,
    baseUrl: 'https://test.example.invalid/api/v3',
    model: 'deepseek-v4-1-flash-260910',
    timeoutMs: 1000,
  });
}

const hit = {
  chunkId: 12, documentId: 3, documentTitle: '退货政策', originalFilename: 'returns.md',
  ordinal: 0, headingPath: '退货', content: '七天内可申请。', sourceStartLine: 2, sourceEndLine: 4, score: 0.8,
};

test('accepts an answer only with retrieved citations', () => {
  const result = validateAnswer(JSON.stringify({ status: 'answered', answer: '七天内可申请。', citationIds: [12] }), [hit]);
  assert.equal(result.refused, false);
  assert.deepEqual(result.citations, [{
    chunkId: 12, documentId: 3, documentTitle: '退货政策', originalFilename: 'returns.md',
    sourceStartLine: 2, sourceEndLine: 4,
  }]);
});

test('refuses invented, missing, or malformed citations', () => {
  for (const raw of [
    JSON.stringify({ status: 'answered', answer: '可以', citationIds: [999] }),
    JSON.stringify({ status: 'answered', answer: '可以', citationIds: [] }),
    'not JSON',
    JSON.stringify({ status: 'refused', answer: '可以', citationIds: [12] }),
  ]) {
    assert.deepEqual(validateAnswer(raw, [hit]), { answer: '无法确定，建议联系人工。', refused: true, citations: [] });
  }
});

test('limits anonymous requests per IP', async () => {
  const limiter = new ChatRateLimitService();
  for (let i = 0; i < 10; i += 1) assert.equal(await limiter.run('visitor', async () => 'ok'), 'ok');
  await assert.rejects(() => limiter.run('visitor', async () => 'no'), (error) => error.getStatus() === 429);
  assert.equal(await limiter.run('another', async () => 'ok'), 'ok');
});

test('follow-up question expands retrieval query before the orchestrator runs', () => {
  const history = [{ question: '退货政策是什么？', answer: '七天内可申请。' }];
  assert.equal(retrievalQuery('那它需要什么条件？', history), '退货政策是什么？ 那它需要什么条件？');
  assert.equal(retrievalQuery('保修多久？', history), '保修多久？');
});

test('answer model retries an empty response without logging secrets or prompt text', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.LLM_API_KEY;
  const warnings = [];
  let attempts = 0;
  process.env.LLM_API_KEY = 'test-secret-do-not-log';
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ id: `test-${attempts}`, object: 'chat.completion', created: 1, model: 'deepseek-v4-1-flash-260910', choices: [{ index: 0, finish_reason: attempts === 1 ? 'length' : 'stop', message: { role: 'assistant', content: attempts === 1 ? '' : 'valid' } }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const llm = new LlmService(testLlmProvider(process.env.LLM_API_KEY));
    llm.logger.warn = (message) => warnings.push(message);
    const result = await llm.completeDetailed('private system', 'private user');
    assert.equal(result.content, 'valid');
    assert.deepEqual([result.inputTokens, result.outputTokens, result.totalTokens], [24, 8, 32]);
    assert.equal(attempts, 2);
    assert.match(warnings[0], /empty_response:length/);
    assert.ok(!warnings.join(' ').includes('test-secret-do-not-log'));
    assert.ok(!warnings.join(' ').includes('private'));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = originalKey;
  }
});

test('answer model fails closed after three retries (four empty responses)', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.LLM_API_KEY;
  let attempts = 0;
  process.env.LLM_API_KEY = 'test-key';
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ id: `test-${attempts}`, object: 'chat.completion', created: 1, model: 'deepseek-v4-1-flash-260910', choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const llm = new LlmService(testLlmProvider(process.env.LLM_API_KEY));
    llm.logger.warn = () => {};
    await assert.rejects(() => llm.complete('system', 'user'), (error) => error.getStatus() === 503 && error.retryExhausted === true && error.attempts === 4);
    assert.equal(attempts, 4);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = originalKey;
  }
});

test('LLM retry delay uses exponential backoff [1000, 2000, 4000] and respects Retry-After with 1s buffer', () => {
  assert.equal(calculateLlmRetryDelayMs(1), 1000);
  assert.equal(calculateLlmRetryDelayMs(2), 2000);
  assert.equal(calculateLlmRetryDelayMs(3), 4000);
  assert.equal(calculateLlmRetryDelayMs(1, 2500), 3500);
});

test('LlmService streamDetailed retries up to 3 times before first token, emits retry_status events and stops immediately on quota exhaustion', async () => {
  let streamAttempts = 0;
  const retryEvents = [];
  const flakyProvider = {
    model: 'fixture',
    async *stream() {
      streamAttempts += 1;
      if (streamAttempts <= 3) throw new ProviderTimeoutError();
      yield { type: 'text_delta', delta: '恢复成功' };
      yield { type: 'completed', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, finishReason: 'stop' };
    },
  };
  const llm = new LlmService(flakyProvider);
  llm.logger.warn = () => {};
  const recovered = await llm.streamDetailed('sys', 'usr', 'fixture', 'answer', {}, { onRetryStatus: (e) => retryEvents.push(e) });
  assert.equal(streamAttempts, 4);
  assert.equal(recovered.attempts, 4);
  assert.equal(recovered.content, '恢复成功');
  assert.deepEqual(retryEvents.map((e) => [e.state, e.attempt]), [
    ['waiting', 1],
    ['waiting', 2],
    ['waiting', 3],
    ['recovered', 3],
  ]);

  let quotaAttempts = 0;
  const quotaProvider = {
    model: 'fixture',
    async *stream() {
      quotaAttempts += 1;
      throw new ProviderQuotaExhaustedError(429);
    },
  };
  const quotaLlm = new LlmService(quotaProvider);
  quotaLlm.logger.warn = () => {};
  await assert.rejects(
    () => quotaLlm.streamDetailed('sys', 'usr', 'fixture', 'planner'),
    (err) => err instanceof ProviderQuotaExhaustedError && err.attempts === 1 && err.retryExhausted === false,
  );
  assert.equal(quotaAttempts, 1);
});
