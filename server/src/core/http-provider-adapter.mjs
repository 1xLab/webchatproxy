import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export class HttpProviderAdapter {
  constructor({ id, baseUrl, concurrency = 1, runtimeDir, staticToken = null, tokenFile = null, capabilities = null, nativeCapabilities = null }) {
    this.id = id;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.runtimeDir = runtimeDir;
    this.staticToken = staticToken;
    this.tokenFile = tokenFile;
    this.capabilities = Object.freeze(capabilities || { models: true, chat: true, streaming: true, conversations: false });
    this.nativeCapabilities = Object.freeze(nativeCapabilities || {});
  }

  describe() {
    return { id: this.id, concurrency: this.concurrency, capabilities: this.capabilities, native_capabilities: this.nativeCapabilities, upstream: this.baseUrl };
  }

  async #token() {
    if (this.staticToken) return this.staticToken;
    const file = this.tokenFile
      ? (isAbsolute(this.tokenFile) ? this.tokenFile : join(this.runtimeDir, this.tokenFile))
      : join(this.runtimeDir, this.id, '.api-key');
    try { return (await readFile(file, 'utf8')).split(/\r?\n/)[0].trim(); }
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
  async native(method, path, body = null, { signal } = {}) { return this.#request(method, path, body, { signal }); }

  async chat(request, { signal } = {}) {
    const { provider: _provider, async: _async, request_id: _requestId, ...providerPayload } = request;
    const payload = await this.#request('POST', '/v1/chat/completions', { ...providerPayload, stream: false }, { signal });
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
