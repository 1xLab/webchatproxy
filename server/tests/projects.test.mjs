import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../src/core/provider-registry.mjs';
import { JobManager } from '../src/core/job-manager.mjs';
import { createHttpServer } from '../src/http/server.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

class NativeAdapter {
  constructor(id, capabilities) {
    this.id = id;
    this.concurrency = 1;
    this.capabilities = capabilities;
    this.nativeCapabilities = capabilities;
    this.calls = [];
  }
  describe() { return { id: this.id, concurrency: 1, capabilities: this.capabilities, native_capabilities: this.nativeCapabilities }; }
  async models() { return { object: 'list', data: [] }; }
  async chat() { return { content: 'ok', finish_reason: 'stop' }; }
  async native(method, path, body = null) {
    this.calls.push({ method, path, body });
    if (path === '/v1/projects') return { projects: [{ id: 'p1', name: 'webagent' }] };
    return { ok: true, method, path, body };
  }
}

async function fixture(adapter) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'webchatproxy-projects-'));
  const registry = new ProviderRegistry();
  registry.register(adapter);
  const jobs = await new JobManager({ registry, runtimeDir }).init();
  return { runtimeDir, registry, jobs };
}

test('Kimi facade exposes projects and preserves normalized project routes', async () => {
  const adapter = new NativeAdapter('kimi', { projects: true, conversations: true, project_conversations: true, project_files: true });
  const fx = await fixture(adapter);
  const server = createHttpServer({ registry: fx.registry, jobs: fx.jobs, fixedProvider: 'kimi' });
  const base = await listen(server);
  try {
    const projects = await fetch(`${base}/v1/projects`);
    assert.equal(projects.status, 200);
    assert.equal((await projects.json()).projects[0].name, 'webagent');

    const chats = await fetch(`${base}/v1/projects/project%201/conversations`);
    assert.equal(chats.status, 200);
    assert.deepEqual(adapter.calls.at(-1), { method: 'GET', path: '/v1/projects/project%201/conversations', body: null });

    const files = await fetch(`${base}/v1/projects/project%201/files`);
    assert.equal(files.status, 200);
    assert.deepEqual(adapter.calls.at(-1), { method: 'GET', path: '/v1/projects/project%201/files', body: null });
  } finally {
    await close(server);
    await rm(fx.runtimeDir, { recursive: true, force: true });
  }
});

test('universal Kimi project routes use provider only for routing and do not leak it upstream', async () => {
  const adapter = new NativeAdapter('kimi', { projects: true, conversations: true, project_conversations: true, project_files: true });
  const fx = await fixture(adapter);
  const server = createHttpServer({ registry: fx.registry, jobs: fx.jobs });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/conversations?provider=kimi&project_id=p-123&limit=20`);
    assert.equal(response.status, 200);
    assert.deepEqual(adapter.calls.at(-1), {
      method: 'GET',
      path: '/v1/conversations?project_id=p-123&limit=20',
      body: null,
    });
  } finally {
    await close(server);
    await rm(fx.runtimeDir, { recursive: true, force: true });
  }
});

test('project conversation creation preserves body and project path', async () => {
  const adapter = new NativeAdapter('kimi', { projects: true, conversations: true, project_conversations: true, project_files: true });
  const fx = await fixture(adapter);
  const server = createHttpServer({ registry: fx.registry, jobs: fx.jobs, fixedProvider: 'kimi' });
  const base = await listen(server);
  try {
    const body = { name: 'new chat', scenario: 'kimi', metadata: { source: 'webagent' } };
    const response = await fetch(`${base}/v1/projects/p1/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(adapter.calls.at(-1), { method: 'POST', path: '/v1/projects/p1/conversations', body });
  } finally {
    await close(server);
    await rm(fx.runtimeDir, { recursive: true, force: true });
  }
});

test('providers without exposed project capability return 501 instead of proxying blindly', async () => {
  const adapter = new NativeAdapter('deepseek', { projects: false, conversations: false });
  const fx = await fixture(adapter);
  const server = createHttpServer({ registry: fx.registry, jobs: fx.jobs, fixedProvider: 'deepseek' });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/projects`);
    assert.equal(response.status, 501);
    const payload = await response.json();
    assert.equal(payload.error.code, 'capability_not_exposed');
    assert.equal(adapter.calls.length, 0);
  } finally {
    await close(server);
    await rm(fx.runtimeDir, { recursive: true, force: true });
  }
});

test('history contract discovers providers and forwards provider-neutral resources', async () => {
  const adapter = new NativeAdapter('kimi', { projects: true, conversations: true, project_conversations: true, project_files: true });
  const fx = await fixture(adapter);
  const server = createHttpServer({ registry: fx.registry, jobs: fx.jobs });
  const base = await listen(server);
  try {
    const providers = await fetch(`${base}/v1/history/providers`);
    assert.equal(providers.status, 200);
    assert.equal((await providers.json())[0].id, 'kimi');

    const capabilities = await fetch(`${base}/v1/history/kimi/capabilities`);
    assert.equal(capabilities.status, 200);
    assert.equal((await capabilities.json()).capabilities.projects, true);

    const messages = await fetch(`${base}/v1/history/kimi/conversations/chat-1/messages?limit=25`);
    assert.equal(messages.status, 200);
    assert.deepEqual(adapter.calls.at(-1), { method: 'GET', path: '/v1/conversations/chat-1/messages?limit=25', body: null });
  } finally {
    await close(server);
    await rm(fx.runtimeDir, { recursive: true, force: true });
  }
});
