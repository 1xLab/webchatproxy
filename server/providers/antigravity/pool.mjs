#!/usr/bin/env node
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';

const host = process.env.ANTIGRAVITY_POOL_HOST || '127.0.0.1';
const port = Number(process.env.ANTIGRAVITY_POOL_PORT || 3240);
const poolKeyFile = process.env.ANTIGRAVITY_POOL_API_KEY_FILE || `${process.cwd()}/runtime/antigravity-pool/.api-key`;
const timeoutMs = Number(process.env.ANTIGRAVITY_POOL_TIMEOUT || 300000);
const cooldownMs = Number(process.env.ANTIGRAVITY_POOL_COOLDOWN || 30000);
const workers = (process.env.ANTIGRAVITY_POOL_WORKERS || Array.from({ length: 10 }, (_, i) => `http://127.0.0.1:${3251 + i}`).join(','))
  .split(',').map((url, index) => ({ url: url.trim().replace(/\/$/, ''), index, failedUntil: 0 })).filter(worker => worker.url);
let cursor = 0;

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
  return keyFrom(process.env[`ANTIGRAVITY_WORKER_${suffix}_API_KEY_FILE`] || `${process.cwd()}/runtime/antigravity-${suffix}/.api-key`);
}
function available() {
  const now = Date.now();
  return workers.filter(worker => worker.failedUntil <= now && workerKey(worker));
}
function nextWorker() {
  const pool = available();
  if (!pool.length) return null;
  const worker = pool[cursor % pool.length];
  cursor = (cursor + 1) % Math.max(1, pool.length);
  return worker;
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
function markFailed(worker) { worker.failedUntil = Date.now() + cooldownMs; }
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
async function forward(worker, req, res) {
  const body = await readJson(req);
  const upstream = await call(worker, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': upstream.headers.get('cache-control') || 'no-cache' });
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(res); else res.end();
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
      const worker = nextWorker();
      if (!worker) return error(res, 503, 'no Antigravity account is available', 'accounts_unavailable');
      try { return await forward(worker, req, res); } catch (err) { markFailed(worker); return error(res, 502, err.message); }
    }
    return error(res, 404, 'not found', 'not_found');
  } catch (err) { if (!res.headersSent) error(res, 502, err.message); else res.end(); }
});
server.listen(port, host, () => console.log(`Antigravity account pool listening on http://${host}:${port} with ${workers.length} workers`));
