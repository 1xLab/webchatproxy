import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexOAuth } from '../src/providers/codex/oauth.mjs';
import { CodexProvider } from '../src/providers/codex/provider.mjs';

test('Codex refreshes OAuth credentials and persists the rotated refresh token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webchatproxy-codex-'));
  const file = join(dir, 'auth.json');
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(file, JSON.stringify({ type: 'oauth', access: 'expired', refresh: 'old-refresh', expires: 0 }));
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return Response.json({ id_token: '', access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    };
    const auth = new CodexOAuth({ file, issuer: 'https://auth.test', clientId: 'client-test' });
    const result = await auth.accessToken();
    assert.equal(result.access, 'new-access');
    assert.equal(request.url, 'https://auth.test/oauth/token');
    assert.match(await readFile(file, 'utf8'), /new-refresh/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Codex provider maps Responses output and usage to OpenAI chat format', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'webchatproxy-codex-'));
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(join(dir, 'codex'), { recursive: true });
    await writeFile(join(dir, 'codex/auth.json'), JSON.stringify({ type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000, accountId: 'acct-1' }));
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return Response.json({ model: 'gpt-5.4', output_text: 'CODEX_OK', usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } });
    };
    const provider = new CodexProvider({ runtimeDir: dir, endpoint: 'https://chatgpt.test/backend-api/codex/responses' });
    const result = await provider.chat({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'test' }] });
    assert.equal(result.content, 'CODEX_OK');
    assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
    assert.equal(request.url, 'https://chatgpt.test/backend-api/codex/responses');
    assert.equal(request.options.headers['ChatGPT-Account-Id'], 'acct-1');
    assert.equal(JSON.parse(request.options.body).input[0].content, 'test');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Codex catalog includes Kilo OAuth model aliases and context metadata', async () => {
  const provider = new CodexProvider({ runtimeDir: '/tmp/webchatproxy-codex-test' });
  assert.equal(provider.concurrency, 1);
  const models = await provider.models();
  const sol = models.data.find(model => model.id === 'gpt-5.6-sol-wm');
  assert.ok(sol);
  assert.equal(sol.context_window, 1_050_000);
  assert.equal(sol.max_output_tokens, 128_000);
});
