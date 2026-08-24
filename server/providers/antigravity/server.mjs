#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';

const host = process.env.ANTIGRAVITY_HOST || '127.0.0.1';
const port = Number(process.env.ANTIGRAVITY_PORT || 3240);
const agyBin = process.env.AGY_BIN || 'agy';
const apiKeyFile = process.env.ANTIGRAVITY_API_KEY_FILE || `${process.cwd()}/runtime/antigravity/.api-key`;
const contextDir = process.env.ANTIGRAVITY_CONTEXT_DIR || `${process.cwd()}/runtime/antigravity-context`;
const printTimeout = process.env.AGY_PRINT_TIMEOUT || '5m';
const maxBody = Number(process.env.ANTIGRAVITY_MAX_BODY || 2 * 1024 * 1024);
mkdirSync(contextDir, { recursive: true, mode: 0o700 });

function apiKey() {
  try { return readFileSync(apiKeyFile, 'utf8').split(/\r?\n/)[0].trim(); } catch { return ''; }
}
function authorized(req) {
  const key = apiKey();
  return key && req.headers.authorization === `Bearer ${key}`;
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function openAIError(res, status, message, type = 'antigravity_error', code = null) {
  sendJson(res, status, { error: { message, type, param: null, code } });
}
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function runAgy(args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(agyBin, args, { cwd: contextDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`agy timeout after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((stderr || stdout || `agy exited ${code}`).trim()));
      resolve({ stdout, stderr });
    });
  });
}
function parseModels(text) {
  const now = Math.floor(Date.now() / 1000);
  const data = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([a-z0-9][a-z0-9._-]*)(?:\t+|\s{2,})(.+)$/i);
    if (!m) continue;
    data.push({ id: m[1], object: 'model', created: now, owned_by: 'google-antigravity', name: m[2].trim() });
  }
  return data;
}
function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(x => x && x.type === 'text').map(x => x.text || '').join('\n');
  return content == null ? '' : JSON.stringify(content);
}
function promptFromMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('messages must be a non-empty array');
  if (messages.length === 1 && messages[0]?.role === 'user') return textContent(messages[0].content);
  return messages.map(m => `${String(m.role || 'user').toUpperCase()}:\n${textContent(m.content)}`).join('\n\n') + '\n\nASSISTANT:';
}
function usageFromAgy(u = {}) {
  return {
    prompt_tokens: Number(u.input_tokens || 0),
    completion_tokens: Number(u.output_tokens || 0),
    total_tokens: Number(u.total_tokens || (Number(u.input_tokens || 0) + Number(u.output_tokens || 0)))
  };
}
function completionId() { return `chatcmpl-agy-${randomUUID().replaceAll('-', '')}`; }
function agyArgs(prompt, model, format) {
  const args = ['-p', prompt, '--output-format', format, '--print-timeout', printTimeout, '--disable-slash-commands'];
  if (model) args.push('--model', model);
  return args;
}
async function nonStream(body, res) {
  const prompt = promptFromMessages(body.messages);
  const model = String(body.model || '').trim();
  const { stdout } = await runAgy(agyArgs(prompt, model, 'json'));
  let result;
  try { result = JSON.parse(stdout.trim()); } catch { throw new Error(`invalid agy JSON output: ${stdout.slice(0, 500)}`); }
  if (result.status !== 'SUCCESS') throw new Error(result.error || `agy status ${result.status || 'unknown'}`);
  const created = Math.floor(Date.now() / 1000);
  sendJson(res, 200, {
    id: completionId(), object: 'chat.completion', created, model: model || 'antigravity-default',
    choices: [{ index: 0, message: { role: 'assistant', content: String(result.response || '') }, finish_reason: 'stop' }],
    usage: usageFromAgy(result.usage),
    system_fingerprint: result.conversation_id ? `agy:${createHash('sha256').update(result.conversation_id).digest('hex').slice(0, 16)}` : null
  });
}
async function stream(body, res) {
  const prompt = promptFromMessages(body.messages);
  const model = String(body.model || '').trim();
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const child = spawn(agyBin, agyArgs(prompt, model, 'stream-json'), { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const emit = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: model || 'antigravity-default', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  emit({ role: 'assistant' });
  let buf = '';
  let stderr = '';
  let terminal = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderr += d; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    for (;;) {
      const i = buf.indexOf('\n');
      if (i < 0) break;
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let evt; try { evt = JSON.parse(line); } catch { continue; }
      if (evt.event === 'step_update' && evt.step_update?.step_type === 'agent_response' && typeof evt.step_update.text_delta === 'string') emit({ content: evt.step_update.text_delta });
      if (evt.event === 'result') terminal = evt.result || {};
    }
  });
  reqAbort(res, child);
  child.on('close', code => {
    if (code === 0 && terminal?.status === 'SUCCESS') {
      emit({}, 'stop'); res.write('data: [DONE]\n\n'); res.end();
    } else {
      const msg = terminal?.error || stderr.trim() || `agy exited ${code}`;
      res.write(`data: ${JSON.stringify({ error: { message: msg, type: 'antigravity_error', param: null, code: null } })}\n\n`); res.write('data: [DONE]\n\n'); res.end();
    }
  });
  child.on('error', err => { res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'antigravity_error' } })}\n\n`); res.end(); });
}
function reqAbort(res, child) {
  res.on('close', () => { if (!child.killed) child.kill('SIGTERM'); });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      try {
        const { stdout } = await runAgy(['--version'], { timeoutMs: 10000 });
        return sendJson(res, 200, { service: 'webchatproxy-antigravity', ok: true, agy: stdout.trim(), port });
      } catch (err) { return sendJson(res, 503, { service: 'webchatproxy-antigravity', ok: false, error: err.message }); }
    }
    if (!authorized(req)) return openAIError(res, 401, 'unauthorized', 'authentication_error', 'invalid_api_key');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const { stdout } = await runAgy(['models'], { timeoutMs: 30000 });
      const data = parseModels(stdout);
      if (!data.length) throw new Error(`agy models returned no parseable models: ${stdout.slice(0, 500)}`);
      return sendJson(res, 200, { object: 'list', data });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await readJson(req);
      return body.stream ? await stream(body, res) : await nonStream(body, res);
    }
    return openAIError(res, 404, 'not found', 'invalid_request_error', 'not_found');
  } catch (err) {
    if (!res.headersSent) openAIError(res, 502, err.message || String(err));
    else { try { res.end(); } catch {} }
  }
});
server.listen(port, host, () => console.log(`Antigravity OpenAI-compatible provider listening on http://${host}:${port}`));
