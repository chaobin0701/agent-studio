import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry, UnsupportedProviderError } from '../dist/ai/providers/provider-registry.js';

test('provider registry creates the configured OpenAI-compatible provider', () => {
  const registry = new ProviderRegistry({ llm: {
    provider: 'openai-compatible',
    apiKey: 'secret-value',
    baseUrl: 'https://provider.example.invalid/api/v3',
    model: 'test-model',
    timeoutMs: 5000,
  } });
  const provider = registry.createLlmProvider();
  assert.equal(provider.model, 'test-model');
});

test('provider registry rejects unsupported providers explicitly', () => {
  const registry = new ProviderRegistry({ llm: {
    provider: 'unsupported-provider',
    apiKey: '',
    baseUrl: 'https://provider.example.invalid/api/v3',
    model: 'test-model',
    timeoutMs: 5000,
  } });
  assert.throws(() => registry.createLlmProvider(), UnsupportedProviderError);
});
