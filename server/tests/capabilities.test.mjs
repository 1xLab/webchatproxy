import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpProviderAdapter } from '../src/core/http-provider-adapter.mjs';
import { CodexProvider } from '../src/providers/codex/provider.mjs';

test('HTTP providers do not claim conversation support by default', () => {
  const adapter = new HttpProviderAdapter({ id: 'deepseek', baseUrl: 'http://127.0.0.1:1' });
  assert.equal(adapter.describe().capabilities.conversations, false);
});

test('Codex does not claim local project or conversation support', () => {
  const provider = new CodexProvider({ runtimeDir: '/tmp/webchatproxy-codex-capabilities' });
  assert.deepEqual(provider.describe().capabilities, {
    models: true,
    chat: true,
    streaming: true,
    conversations: false,
    projects: false,
    project_conversations: false,
    project_files: false,
    cloud_environments: false,
    cloud_tasks: false,
  });
});
