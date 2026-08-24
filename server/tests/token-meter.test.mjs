import assert from 'node:assert/strict';
import test from 'node:test';
import { meterUsage, estimateInputTokens, estimateCompletionTokens } from '../src/core/token-meter.mjs';

test('preserves provider-reported OpenAI usage as exact', () => {
  const result = meterUsage({
    request: { messages: [{ role: 'user', content: 'hello' }] },
    content: 'world',
    providerUsage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
  assert.deepEqual(result.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  assert.equal(result.measurement.source, 'provider_reported');
  assert.equal(result.measurement.estimated, false);
});

test('falls back to non-zero proxy estimate when provider usage is missing', () => {
  const request = {
    messages: [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Write a short PHP function.' },
    ],
  };
  const result = meterUsage({ request, content: 'function ok() { return true; }', providerUsage: null });
  assert.ok(result.usage.prompt_tokens > 0);
  assert.ok(result.usage.completion_tokens > 0);
  assert.equal(result.usage.total_tokens, result.usage.prompt_tokens + result.usage.completion_tokens);
  assert.equal(result.measurement.source, 'proxy_estimate');
  assert.equal(result.measurement.quality, 'estimated');
  assert.equal(result.measurement.estimated, true);
});

test('zero-filled provider usage is treated as unavailable and estimated', () => {
  const result = meterUsage({
    request: { messages: [{ role: 'user', content: 'count me' }] },
    content: 'count this response too',
    providerUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
  assert.equal(result.measurement.source, 'proxy_estimate');
  assert.ok(result.usage.total_tokens > 0);
});

test('estimator supports multilingual text and tool payloads', () => {
  const input = estimateInputTokens({
    messages: [{ role: 'user', content: 'Olá 世界' }],
    tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
  });
  const output = estimateCompletionTokens('Resposta テスト');
  assert.ok(input > 0);
  assert.ok(output > 0);
});
