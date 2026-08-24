import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class HttpProviderAdapter {
  constructor({ id, baseUrl, concurrency = 1, runtimeDir, staticToken = null }) {
    this.id = id;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.runtimeDir = runtimeDir;
    this.staticToken = staticToken;
    this.capabilities = Object.freeze({ models: true, chat: true, streaming: true, conversations: true });
  }

  describe() {
    return { id: this.id, concurrency: this.concurrency, capabilities: this.capabilities };
  }

  async #token() {
    if (this.staticToken) return this.staticToken;
    try { return (await readFile(join(this.runtimeDir, this.id, '.api-key'), 'utf8')).split(/\r?\n/)[0].trim(); }
    catch { return ''; }
  }

  async #request(method, path, body = null, { signal } = {}) {
    const headers = { Accept: 'application/json' };
    const token = await this.#token();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body != null) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${this.baseUrl}${path}`, {
      method, headers, body: body == null ? undefined : JSON.stringify(body), signal,
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || payload?.error || payload?.message || `${this.id} HTTP ${response.status}`);
      error.status = response.status;
      error.provider = this.id;
      error.details = payload;
      throw error;
    }
    return payload;
  }

  async health({ signal } = {}) { return this.#request('GET', '/health', null, { signal }); }
  async models({ signal } = {}) { return this.#request('GET', '/v1/models', null, { signal }); }

  async chat(request, { signal } = {}) {
    const payload = await this.#request('POST', '/v1/chat/completions', { ...request, stream: false }, { signal });
    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    const content = choice?.message?.content ?? payload?.content ?? '';
    const conversationId = payload?.conversation_id
      ?? payload?.gateway?.conversation_id
      ?? payload?.conversation?.id
      ?? request.conversation_id
      ?? null;
    return {
      content: String(content ?? ''),
      conversation_id: conversationId,
      model: payload?.model || request.model || null,
      finish_reason: choice?.finish_reason || 'stop',
      usage: payload?.usage || null,
      raw: payload,
    };
  }
}
