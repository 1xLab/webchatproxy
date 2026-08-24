import { join } from 'node:path';
import { CodexOAuth } from './oauth.mjs';

const CODEX_ENDPOINT = process.env.CODEX_API_ENDPOINT || 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_MODELS = ['gpt-5.5', 'gpt-5.3-codex-spark', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.2-codex'];

function responseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const output = Array.isArray(payload?.output) ? payload.output : [];
  return output.flatMap(item => Array.isArray(item.content) ? item.content : [])
    .filter(item => item.type === 'output_text' || item.type === 'text')
    .map(item => item.text || '').join('');
}

export class CodexProvider {
  constructor({ runtimeDir, authFile = 'codex/auth.json', endpoint = CODEX_ENDPOINT } = {}) {
    this.id = 'codex';
    this.runtimeDir = runtimeDir;
    this.endpoint = endpoint;
    this.auth = new CodexOAuth({ file: join(runtimeDir, authFile) });
    this.modelsList = (process.env.CODEX_MODELS || DEFAULT_MODELS.join(',')).split(',').map(x => x.trim()).filter(Boolean);
  }

  describe() { return { id: this.id, concurrency: 1, capabilities: { models: true, chat: true, streaming: true, conversations: false }, upstream: this.endpoint }; }

  async health() { return { ok: (await this.auth.status()).authenticated }; }

  async models() {
    return { object: 'list', data: this.modelsList.map(id => ({ id, object: 'model', created: 0, owned_by: 'openai-codex' })) };
  }

  async chat(request, { signal } = {}) {
    const auth = await this.auth.accessToken();
    const input = Array.isArray(request.messages) ? request.messages.map(({ role, content }) => ({ role, content })) : request.input;
    const body = { model: request.model || this.modelsList[0], input, stream: false };
    let response = await this.#fetch(auth, body, signal);
    if (response.status === 401) response = await this.#fetch(await this.auth.refresh(), body, signal);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) { const error = new Error(payload?.error?.message || `Codex HTTP ${response.status}`); error.status = response.status; error.provider = this.id; throw error; }
    const usage = payload.usage ? { prompt_tokens: payload.usage.input_tokens ?? payload.usage.prompt_tokens ?? 0, completion_tokens: payload.usage.output_tokens ?? payload.usage.completion_tokens ?? 0, total_tokens: payload.usage.total_tokens ?? 0 } : null;
    return { content: responseText(payload), conversation_id: null, model: payload.model || body.model, finish_reason: 'stop', usage, raw: payload };
  }

  async #fetch(auth, body, signal) {
    const headers = { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${auth.access}` };
    if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;
    headers.originator = 'webchatproxy';
    return fetch(this.endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
  }
}
