import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, rename, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const CODEX_ISSUER = process.env.CODEX_OAUTH_ISSUER || 'https://auth.openai.com';
export const CODEX_CLIENT_ID = process.env.CODEX_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function accountId(tokens) {
  const token = tokens.id_token || tokens.access_token;
  if (!token) return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return claims.chatgpt_account_id
      || claims['https://api.openai.com/auth']?.chatgpt_account_id
      || claims.organizations?.[0]?.id
      || null;
  } catch { return null; }
}

async function saveJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
}

export class CodexOAuth {
  constructor({ file, port = 1455, issuer = CODEX_ISSUER, clientId = CODEX_CLIENT_ID } = {}) {
    this.file = file;
    this.port = Number(port);
    this.issuer = issuer;
    this.clientId = clientId;
    this.server = null;
    this.pending = null;
    this.device = null;
  }

  async load() {
    try { return JSON.parse(await readFile(this.file, 'utf8')); } catch { return null; }
  }

  async saveTokens(tokens) {
    const current = await this.load();
    const value = {
      type: 'oauth',
      access: tokens.access_token,
      refresh: tokens.refresh_token || current?.refresh || '',
      id_token: tokens.id_token || current?.id_token || '',
      accountId: accountId(tokens) || current?.accountId || null,
      expires: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
    };
    await saveJson(this.file, value);
    return value;
  }

  async refresh() {
    const current = await this.load();
    if (!current?.refresh) throw new Error('Codex OAuth login required');
    const response = await fetch(`${this.issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'webchatproxy-codex' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refresh, client_id: this.clientId }),
    });
    if (!response.ok) throw new Error(`Codex token refresh failed: ${response.status}`);
    return this.saveTokens(await response.json());
  }

  async accessToken() {
    const current = await this.load();
    if (current?.access && current.expires > Date.now() + 60_000) return current;
    return this.refresh();
  }

  async startLogin() {
    if (this.pending) return this.pending.url;
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(24));
    const redirectUri = `http://localhost:${this.port}/auth/callback`;
    const params = new URLSearchParams({
      response_type: 'code', client_id: this.clientId, redirect_uri: redirectUri,
      scope: 'openid profile email offline_access', code_challenge: challenge,
      code_challenge_method: 'S256', id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true', state, originator: 'webchatproxy',
    });
    const url = `${this.issuer}/oauth/authorize?${params}`;
    this.pending = { verifier, state, redirectUri, url };
    if (!this.server) {
      this.server = createServer((req, res) => this.#callback(req, res));
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.port, '127.0.0.1', resolve);
      });
    }
    return url;
  }

  async startDeviceLogin() {
    if (this.device) return { url: `${this.issuer}/codex/device`, user_code: this.device.userCode, pending: true };
    const response = await fetch(`${this.issuer}/api/accounts/deviceauth/usercode`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'webchatproxy-codex' },
      body: JSON.stringify({ client_id: this.clientId }),
    });
    if (!response.ok) throw new Error(`Codex device authorization failed: ${response.status}`);
    const data = await response.json();
    this.device = { userCode: data.user_code, deviceId: data.device_auth_id, interval: Math.max(Number(data.interval) || 5, 1), status: 'pending' };
    this.#pollDevice(this.device).catch(() => {});
    return { url: `${this.issuer}/codex/device`, user_code: this.device.userCode, pending: true };
  }

  async #pollDevice(device) {
    const deadline = Date.now() + 5 * 60_000;
    while (this.device === device && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, device.interval * 1000));
      const response = await fetch(`${this.issuer}/api/accounts/deviceauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'webchatproxy-codex' },
        body: JSON.stringify({ device_auth_id: device.deviceId, user_code: device.userCode }),
      });
      if (response.status === 400 || response.status === 403 || response.status === 404) continue;
      if (!response.ok) { device.status = 'failed'; device.error = `device poll failed: ${response.status}`; return; }
      const authorization = await response.json();
      const tokens = await fetch(`${this.issuer}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', authorization_code: authorization.authorization_code, redirect_uri: `${this.issuer}/deviceauth/callback`, client_id: this.clientId, code_verifier: authorization.code_verifier }),
      });
      const tokenText = await tokens.text();
      if (!tokens.ok) { device.status = 'failed'; device.error = `token exchange failed: ${tokens.status} ${tokenText.slice(0, 300)}`; return; }
      await this.saveTokens(JSON.parse(tokenText));
      device.status = 'authenticated';
      this.device = null;
      return;
    }
    if (this.device === device) { device.status = 'expired'; }
  }

  async #callback(req, res) {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    if (url.pathname !== '/auth/callback') { res.writeHead(404); res.end('Not found'); return; }
    const pending = this.pending;
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!pending || !code || state !== pending.state) { res.writeHead(400); res.end('Invalid OAuth callback'); return; }
    try {
      const response = await fetch(`${this.issuer}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, client_id: this.clientId, code_verifier: pending.verifier }),
      });
      if (!response.ok) throw new Error(`Codex token exchange failed: ${response.status}`);
      await this.saveTokens(await response.json());
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Codex connected</title><h1>Codex connected</h1><p>You can close this window.</p>');
    } catch (error) { res.writeHead(500); res.end(String(error.message)); }
    this.pending = null;
  }

  async status() {
    const current = await this.load();
    return { authenticated: Boolean(current?.refresh), expires: current?.expires || null, accountId: current?.accountId || null, device: this.device ? { status: this.device.status, user_code: this.device.userCode, error: this.device.error || null } : null };
  }

  close() { this.server?.close(); this.server = null; this.pending = null; }
}
