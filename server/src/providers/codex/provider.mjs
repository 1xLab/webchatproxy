import { join } from 'node:path';
import { CodexOAuth } from './oauth.mjs';

const CODEX_ENDPOINT = process.env.CODEX_API_ENDPOINT || 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_MODELS = [
  'gpt-5.5', 'gpt-5.3-codex-spark', 'gpt-5.4', 'gpt-5.4-mini',
  'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.2-codex',
  'gpt-5.6-sol-wm', 'gpt-5.6-terra-wm', 'gpt-5.6-luna-wm', 'gpt-5.6-mini', 'gpt-5.6-t-mini',
];

async function readStream(response) {
  const text = await response.text();
  let content = '';
  let usage = null;
  let model = null;
  let error = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    let event;
    try { event = JSON.parse(raw); } catch { continue; }
    if (event.type === 'response.output_text.delta') content += event.delta || '';
    if (event.type === 'response.output_text.done' && !content) content = event.text || '';
    if (event.type === 'response.completed') {
      const completed = event.response || {};
      model = completed.model || model;
      usage = completed.usage || usage;
    }
    if (event.type === 'response.failed' || event.type === 'error') error = event.error?.message || event.message || 'Codex response failed';
  }
  if (error) throw new Error(error);
  return { content, usage, model };
}

export class CodexProvider {
  constructor({ runtimeDir, authFile = 'codex/auth.json', endpoint = CODEX_ENDPOINT } = {}) {
    this.id = 'codex';
    this.concurrency = 1;
    this.runtimeDir = runtimeDir;
    this.endpoint = endpoint;
    this.auth = new CodexOAuth({ file: join(runtimeDir, authFile) });
    this.modelsList = (process.env.CODEX_MODELS || DEFAULT_MODELS.join(',')).split(',').map(x => x.trim()).filter(Boolean);
  }

  describe() { return { id: this.id, concurrency: 1, capabilities: { models: true, chat: true, streaming: true, conversations: false }, upstream: this.endpoint }; }

  async health() { return { ok: (await this.auth.status()).authenticated }; }

  async models() {
    return {
      object: 'list',
      data: this.modelsList.map(id => ({
        id, object: 'model', created: 0, owned_by: 'openai-codex',
        context_window: id.includes('5.6') ? 1_050_000 : 400_000,
        max_input_tokens: id.includes('5.6') ? 922_000 : 272_000,
        max_output_tokens: 128_000,
      })),
    };
  }

  async chat(request, { signal } = {}) {
    const auth = await this.auth.accessToken();
    const input = Array.isArray(request.messages) ? request.messages.map(({ role, content }) => ({ role, content })) : request.input;
    const body = { model: request.model || this.modelsList[0], input, stream: true, store: false };
    let response = await this.#fetch(auth, body, signal);
    if (response.status === 401) response = await this.#fetch(await this.auth.refresh(), body, signal);
    if (!response.ok) {
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch {}
      const error = new Error(payload?.error?.message || payload?.detail || `Codex HTTP ${response.status}`);
      error.status = response.status; error.provider = this.id; throw error;
    }
    const streamed = await readStream(response);
    const usage = streamed.usage ? { prompt_tokens: streamed.usage.input_tokens ?? streamed.usage.prompt_tokens ?? 0, completion_tokens: streamed.usage.output_tokens ?? streamed.usage.completion_tokens ?? 0, total_tokens: streamed.usage.total_tokens ?? 0 } : null;
    return { content: streamed.content, conversation_id: null, model: streamed.model || body.model, finish_reason: 'stop', usage, raw: streamed };
  }

  async #fetch(auth, body, signal) {
    const headers = { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${auth.access}` };
    if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;
    headers.originator = 'webchatproxy';
    return fetch(this.endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
  }
}
