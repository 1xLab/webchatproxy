import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStore, normalizeUsage } from '../src/core/usage-store.mjs';

test('normalizeUsage supports OpenAI and provider token aliases', () => {
  assert.deepEqual(normalizeUsage({
    prompt_tokens: 100,
    completion_tokens: 25,
    total_tokens: 125,
    prompt_tokens_details: { cached_tokens: 40 },
    completion_tokens_details: { reasoning_tokens: 7 },
  }), {
    input_tokens: 100,
    output_tokens: 25,
    total_tokens: 125,
    cached_input_tokens: 40,
    reasoning_tokens: 7,
  });

  assert.deepEqual(normalizeUsage({ input_tokens: 9, output_tokens: 3 }), {
    input_tokens: 9,
    output_tokens: 3,
    total_tokens: 12,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
  });
});

test('usage ledger persists terminal jobs and aggregates provider model and conversation', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'webchatproxy-usage-'));
  try {
    const store = await new UsageStore({ runtimeDir }).init();
    await store.recordJob({
      id: 'job-1', provider: 'kimi', model: 'k-model', conversation_id: 'conv-a', status: 'completed',
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      created_at: '2026-08-24T10:00:00.000Z', started_at: '2026-08-24T10:00:01.000Z', finished_at: '2026-08-24T10:00:03.000Z',
    });
    await store.recordJob({
      id: 'job-2', provider: 'kimi', model: 'k-model', conversation_id: 'conv-a', status: 'failed',
      usage: null,
      created_at: '2026-08-24T10:01:00.000Z', started_at: '2026-08-24T10:01:01.000Z', finished_at: '2026-08-24T10:01:02.000Z',
    });
    await store.recordJob({
      id: 'job-3', provider: 'deepseek', model: 'd-model', conversation_id: 'conv-b', status: 'completed',
      usage: { input_tokens: 50, output_tokens: 10 },
      created_at: '2026-08-24T10:02:00.000Z', started_at: '2026-08-24T10:02:01.000Z', finished_at: '2026-08-24T10:02:04.000Z',
    });

    const summary = store.summary();
    assert.equal(summary.totals.requests, 3);
    assert.equal(summary.totals.completed, 2);
    assert.equal(summary.totals.failed, 1);
    assert.equal(summary.totals.total_tokens, 180);
    assert.equal(summary.by_provider.kimi.total_tokens, 120);
    assert.equal(summary.by_model['deepseek:d-model'].total_tokens, 60);
    assert.equal(summary.by_conversation['conv-a'].requests, 2);

    const reloaded = await new UsageStore({ runtimeDir }).init();
    assert.equal(reloaded.summary().totals.requests, 3);
    assert.equal(reloaded.query({ jobId: 'job-1' })[0].tokens.total_tokens, 120);
    const ledger = await readFile(join(runtimeDir, 'usage', 'events.jsonl'), 'utf8');
    assert.equal(ledger.trim().split(/\r?\n/).length, 3);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('usage pricing is optional and estimates configured model cost', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'webchatproxy-price-'));
  try {
    const usageDir = join(runtimeDir, 'usage');
    await mkdir(usageDir, { recursive: true });
    await writeFile(join(usageDir, 'pricing.json'), JSON.stringify({
      'deepseek:model-x': {
        currency: 'USD',
        input_per_million: 1,
        cached_input_per_million: 0.25,
        output_per_million: 2,
      },
    }));
    const store = await new UsageStore({ runtimeDir }).init();
    const event = await store.recordJob({
      id: 'priced-job', provider: 'deepseek', model: 'model-x', conversation_id: null, status: 'completed',
      usage: { prompt_tokens: 1000000, completion_tokens: 500000, prompt_tokens_details: { cached_tokens: 200000 } },
      created_at: '2026-08-24T10:00:00.000Z', started_at: '2026-08-24T10:00:00.000Z', finished_at: '2026-08-24T10:00:01.000Z',
    });
    assert.equal(event.cost.currency, 'USD');
    assert.equal(event.cost.estimated, 1.85);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
