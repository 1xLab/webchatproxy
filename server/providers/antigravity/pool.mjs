#!/usr/bin/env node
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { loadCooldowns, persistCooldowns } from './pool-state.mjs';

const host = process.env.ANTIGRAVITY_POOL_HOST || '127.0.0.1';
const port = Number(process.env.ANTIGRAVITY_POOL_PORT || 3240);
const runtimeDir = process.env.ANTIGRAVITY_POOL_RUNTIME_DIR || join(process.cwd(), 'runtime');
const poolKeyFile = process.env.ANTIGRAVITY_POOL_API_KEY_FILE || join(runtimeDir, 'antigravity-pool/.api-key');
const cooldownFile = process.env.ANTIGRAVITY_POOL_COOLDOWN_FILE || join(runtimeDir, 'antigravity-pool/cooldowns.json');
const timeoutMs = Number(process.env.ANTIGRAVITY_POOL_TIMEOUT || 300000);
const cooldownMs = Number(process.env.ANTIGRAVITY_POOL_COOLDOWN || 30000);
const quotaCooldownMs = Number(process.env.ANTIGRAVITY_POOL_QUOTA_COOLDOWN || 3600000);
const workers = (process.env.ANTIGRAVITY_POOL_WORKERS || Array.from({ length: 10 }, (_, i) => `http://127.0.0.1:${3251 + i}`).join(','))
  .split(',').map((url, index) => ({ url: url.trim().replace(/\/$/, ''), index, failedUntil: 0 })).filter(worker => worker.url);
let activeIndex = null;
if (loadCooldowns(cooldownFile, workers)) {
  try { persistCooldowns(cooldownFile, workers); } catch (err) { console.error(`Unable to prune Antigravity cooldowns: ${err.message}`); }
}

function saveCooldowns() {
  try { persistCooldowns(cooldownFile, workers); }
  catch (err) { console.error(`Unable to persist Antigravity cooldowns: ${err.message}`); }
}

function keyFrom(file) {
  try { return readFileSync(file, 'utf8').split(/\r?\n/)[0].trim(); } catch { return ''; }
}
function authorized(req) {
  const key = keyFrom(poolKeyFile);
  return key && req.headers.authorization === `Bearer ${key}`;
}
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function error(res, status, message, code = null) {
  json(res, status, { error: { message, type: 'authentication_error' === code ? code : 'antigravity_pool_error', param: null, code } });
}
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function workerKey(worker) {
  const suffix = String(worker.index + 1);
  return keyFrom(process.env[`ANTIGRAVITY_WORKER_${suffix}_API_KEY_FILE`] || join(runtimeDir, `antigravity-${suffix}/.api-key`));
}
function available() {
  const now = Date.now();
  return workers.filter(worker => worker.failedUntil <= now && workerKey(worker));
}
function activeWorker() {
  const pool = available();
  if (!pool.length) return null;
  const current = activeIndex == null ? null : workers.find(worker => worker.index === activeIndex);
  if (current && pool.includes(current)) return current;
  const next = pool.find(worker => activeIndex == null || worker.index > activeIndex) || pool[0];
  activeIndex = next.index;
  return next;
}
async function call(worker, path, options = {}) {
  const key = workerKey(worker);
  if (!key) throw new Error(`worker ${worker.index + 1} API key is missing`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${worker.url}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${key}` },
    });
  } finally { clearTimeout(timer); }
}
function markFailed(worker) {
  worker.failedUntil = Date.now() + cooldownMs;
  saveCooldowns();
}
function markQuotaExhausted(worker) {
  worker.failedUntil = Date.now() + quotaCooldownMs;
  if (activeIndex === worker.index) activeIndex = null;
  saveCooldowns();
}
function accountLimit(status, text) {
  return status === 429 || status === 403 || status === 401
    || /quota|rate.?limit|resource.?exhausted|too many requests|limit exceeded|capacity/i.test(text);
}
async function models() {
  const results = await Promise.allSettled(workers.map(worker => call(worker, '/v1/models')));
  const data = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status !== 'fulfilled' || !result.value.ok) { markFailed(workers[i]); continue; }
    try {
      const payload = await result.value.json();
      for (const item of payload.data || []) if (!data.some(model => model.id === item.id)) data.push({ ...item, account_pool: true });
    } catch { markFailed(workers[i]); }
  }
  if (!data.length) throw new Error('no Antigravity account is available');
  return { object: 'list', data };
}
async function forward(worker, body, res) {
  const upstream = await call(worker, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!upstream.ok) {
    const text = await upstream.text();
    if (accountLimit(upstream.status, text)) {
      markQuotaExhausted(worker);
      return false;
    }
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
    res.end(text);
    return true;
  }
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': upstream.headers.get('cache-control') || 'no-cache' });
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(res); else res.end();
  return true;
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { service: 'webchatproxy-antigravity-pool', ok: true, port, accounts: workers.length, available: available().length });
    }
    if (!authorized(req)) return error(res, 401, 'unauthorized', 'authentication_error');
    if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, await models());
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await readJson(req);
      const worker = activeWorker();
      if (!worker) return error(res, 503, 'no Antigravity account is available', 'accounts_unavailable');
      try {
        if (await forward(worker, body, res)) return;
        const next = activeWorker();
        if (!next || next.index === worker.index) return error(res, 429, 'active Antigravity account quota exhausted', 'quota_exhausted');
        if (await forward(next, body, res)) return;
        return error(res, 429, 'all available Antigravity account quotas are exhausted', 'quota_exhausted');
      } catch (err) { markFailed(worker); return error(res, 502, err.message); }
    }
    return error(res, 404, 'not found', 'not_found');
  } catch (err) { if (!res.headersSent) error(res, 502, err.message); else res.end(); }
});
server.listen(port, host, () => console.log(`Antigravity account pool listening on http://${host}:${port} with ${workers.length} workers`));
