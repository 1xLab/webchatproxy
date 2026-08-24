import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../src/core/provider-registry.mjs';
import { JobManager } from '../src/core/job-manager.mjs';
import { HttpProviderAdapter } from '../src/core/http-provider-adapter.mjs';
import { createHttpServer } from '../src/http/server.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

class RecordingAdapter {
  constructor(id, { concurrency = 2, delay = 0 } = {}) {
    this.id = id;
    this.concurrency = concurrency;
    this.delay = delay;
    this.requests = [];
    this.running = 0;
    this.maxRunning = 0;
    this.capabilities = { models: true, chat: true, conversations: true };
  }
  describe() { return { id: this.id, concurrency: this.concurrency, capabilities: this.capabilities }; }
  async models() { return { object: 'list', data: [{ id: `${this.id}-model`, object: 'model' }] }; }
  async chat(request, { signal } = {}) {
    this.requests.push(structuredClone(request));
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      if (this.delay) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, this.delay);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      return {
        content: `${this.id}:${request.messages.at(-1).content}`,
        conversation_id: request.conversation_id || `${this.id}-conversation`,
        model: request.model,
        finish_reason: 'stop',
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      };
    } finally {
      this.running -= 1;
    }
  }
}

async function fixture(adapters) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'webchatproxy-int-'));
  const registry = new ProviderRegistry();
  for (const adapter of adapters) registry.register(adapter);
  const jobs = await new JobManager({ registry, runtimeDir }).init();
  return { runtimeDir, registry, jobs };
}

test('provider facade injects provider and preserves model plus extension parameters', async () => {
  const adapter = new RecordingAdapter('deepseek');
  const fx = await fixture([adapter]);
  const server = createHttpServer({ registry: fx.registry, jobs: fx.jobs, fixedProvider: 'deepseek' });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-test-model',
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0.25,
        top_p: 0.8,
        conversation_id: 'conv-123',
        metadata: { task: 'coding', trace: 'abc' },
        provider_options: { experimental: true },
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.model, 'deepseek-test-model');
    assert.equal(payload.gateway.provider, 'deepseek');
    assert.equal(payload.gateway.conversation_id, 'conv-123');
    assert.equal(adapter.requests.length, 1);
    const request = adapter.requests[0];
    assert.equal(request.provider, 'deepseek');
    assert.equal(request.model, 'deepseek-test-model');
    assert.equal(request.temperature, 0.25);
    assert.equal(request.top_p, 0.8);
    assert.deepEqual(request.metadata, { task: 'coding', trace: 'abc' });
    assert.deepEqual(request.provider_options, { experimental: true });
  } finally {
    await close(server);
    await rm(fx.runtimeDir, { recursive: true, force: true });
  }
});

test('provider facade rejects a provider that conflicts with its port', async () => {
  const adapter = new RecordingAdapter('kimi');
  const fx = await fixture([adapter]);
  const server = createHttpServer({ registry: fx.registry, jobs: fx.jobs, fixedProvider: 'kimi' });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'chatgpt', model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, 'provider_port_mismatch');
    assert.equal(adapter.requests.length, 0);
  } finally {
    await close(server);
    await rm(fx.runtimeDir, { recursive: true, force: true });
  }
});

test('universal endpoint routes explicit providers through one JobManager', async () => {
  const chatgpt = new RecordingAdapter('chatgpt');
  const kimi = new RecordingAdapter('kimi');
  const fx = await fixture([chatgpt, kimi]);
  const server = createHttpServer({ registry: fx.registry, jobs: fx.jobs });
  const base = await listen(server);
  try {
    for (const provider of ['chatgpt', 'kimi']) {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, model: `${provider}-model`, messages: [{ role: 'user', content: provider }] }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.gateway.provider, provider);
      assert.equal(payload.choices[0].message.content, `${provider}:${provider}`);
    }
    assert.equal(chatgpt.requests.length, 1);
    assert.equal(kimi.requests.length, 1);
  } finally {
    await close(server);
    await rm(fx.runtimeDir, { recursive: true, force: true });
  }
});

test('idempotency key reuses the same job and rejects payload mutation', async () => {
  const adapter = new RecordingAdapter('antigravity', { delay: 10 });
  const fx = await fixture([adapter]);
  const server = createHttpServer({ registry: fx.registry, jobs: fx.jobs, fixedProvider: 'antigravity' });
  const base = await listen(server);
  try {
    const headers = { 'content-type': 'application/json', 'idempotency-key': 'same-request' };
    const body = JSON.stringify({ model: 'agy-model', messages: [{ role: 'user', content: 'same' }], async: true });
    const first = await fetch(`${base}/v1/jobs`, { method: 'POST', headers, body });
    assert.equal(first.status, 202);
    const firstPayload = await first.json();
    const second = await fetch(`${base}/v1/jobs`, { method: 'POST', headers, body });
    const secondPayload = await second.json();
    assert.equal(second.status, 202);
    assert.equal(secondPayload.reused, true);
    assert.equal(secondPayload.job.id, firstPayload.job.id);

    const conflict = await fetch(`${base}/v1/jobs`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'agy-model', messages: [{ role: 'user', content: 'different' }], async: true }),
    });
    assert.equal(conflict.status, 409);
    await fx.jobs.waitFor(firstPayload.job.id, 1000);
  } finally {
    await close(server);
    await rm(fx.runtimeDir, { recursive: true, force: true });
  }
});

test('JobManager enforces concurrency independently per provider', async () => {
  const deepseek = new RecordingAdapter('deepseek', { concurrency: 2, delay: 40 });
  const chatgpt = new RecordingAdapter('chatgpt', { concurrency: 1, delay: 40 });
  const fx = await fixture([deepseek, chatgpt]);
  try {
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      jobs.push((await fx.jobs.create({ provider: 'deepseek', model: 'm', messages: [{ role: 'user', content: `d${i}` }] })).job.id);
      jobs.push((await fx.jobs.create({ provider: 'chatgpt', model: 'm', messages: [{ role: 'user', content: `c${i}` }] })).job.id);
    }
    await Promise.all(jobs.map((id) => fx.jobs.waitFor(id, 3000)));
    assert.equal(deepseek.maxRunning, 2);
    assert.equal(chatgpt.maxRunning, 1);
  } finally {
    await rm(fx.runtimeDir, { recursive: true, force: true });
  }
});

test('HttpProviderAdapter normalizes OpenAI responses and conversation ids', async () => {
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'upstream-model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'chatcmpl-upstream', object: 'chat.completion', model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'upstream-ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        gateway: { conversation_id: 'upstream-conversation' },
      }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const baseUrl = await listen(upstream);
  try {
    const dir = await mkdtemp(join(tmpdir(), 'webchatproxy-adapter-'));
    try {
      const adapter = new HttpProviderAdapter({ id: 'fake', baseUrl, concurrency: 3, runtimeDir: dir });
      const models = await adapter.models();
      assert.equal(models.data[0].id, 'upstream-model');
      const result = await adapter.chat({ model: 'upstream-model', messages: [{ role: 'user', content: 'x' }], custom: 1 });
      assert.equal(result.content, 'upstream-ok');
      assert.equal(result.conversation_id, 'upstream-conversation');
      assert.equal(result.usage.total_tokens, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await close(upstream);
  }
});
