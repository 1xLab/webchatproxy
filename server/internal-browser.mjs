// Internal Browser Gateway
// OpenAI-compatible HTTP server that owns a persistent Chrome session
// (Playwright, profile at browser-profile/) — no browser extension needed.
//
// The browser runs as a REAL Chrome (headed, off-screen) because chatgpt.com
// blocks headless Chrome with a Cloudflare challenge. A headed browser using
// the logged-in persistent profile passes the challenge; the window is simply
// positioned off-screen so nothing is visible on the desktop.
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const CHATGPT_JS_PATH = require.resolve("@kudoai/chatgpt.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const PROFILE_DIR = process.env.REMOTE_IA_PROFILE || join(__dirname, "browser-profile");

const CHATGPT_URL = "https://chatgpt.com/";
const COMPOSER = "#prompt-textarea";
const ASSISTANT = '[data-message-author-role="assistant"]';
const STOP = '[data-testid="stop-button"], button[aria-label*="Stop" i]';
const DONE = '[data-testid="copy-turn-action-button"]';

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
}

class InternalBrowser {
  constructor({ profileDir, headless = false } = {}) {
    this.profileDir = profileDir || PROFILE_DIR;
    this.headless = headless;
    this.context = null;
    this.page = null;
    this.queue = Promise.resolve();
    this.lastNetworkText = "";
    this.networkComplete = false;
    this.lastReasoningText = "";
    this.lastReasoningRecap = "";
    this.onReasoning = null;
  }

  async start() {
    if (this.context) return;
    mkdirSync(this.profileDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      channel: process.env.REMOTE_IA_BROWSER_CHANNEL || "chrome",
      headless: this.headless,
      viewport: { width: 1280, height: 900 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        // Headed Chrome passes Cloudflare; the window is moved off-screen so
        // nothing shows on the desktop.
        "--window-position=-32000,-32000",
        "--window-size=1280,900",
      ],
    });
    await this.context.addInitScript({ path: CHATGPT_JS_PATH });
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.#observeNetwork(this.page);
    await this.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await this.#ensureChatGptJs();
    log("[browser] started, url=" + this.page.url());
  }

  health() {
    return {
      enabled: true,
      running: !!this.context,
      page: this.page?.url() || null,
      profile: this.profileDir,
    };
  }

  ask(messages, options = {}) {
    const run = () => this.#ask(messages, options);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async #ask(messages, { newConversation = true, timeout = 210_000, onReasoning = null } = {}) {
    await this.start();
    const page = this.page;
    this.onReasoning = onReasoning;
    this.lastReasoningText = "";
    this.lastReasoningRecap = "";
    if (onReasoning) {
      onReasoning("Iniciando raciocínio...", "status");
    }

    if (newConversation || !page.url().startsWith(CHATGPT_URL)) {
      await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    }
    await page.locator(COMPOSER).waitFor({ state: "visible", timeout: 30_000 });
    const hasChatGptJs = await this.#ensureChatGptJs();

    const prompt = buildPrompt(messages);
    if (!prompt) throw new Error("Empty prompt");
    this.lastNetworkText = "";
    this.networkComplete = false;
    log(`[ask] prompt len=${prompt.length}: ${summarize(prompt)}`);

    const baseline = await page.evaluate(({ assistant }) => {
      const nodes = [...document.querySelectorAll(assistant)];
      return {
        count: nodes.length,
        text: nodes.at(-1)?.innerText?.trim() || "",
      };
    }, { assistant: ASSISTANT });
    log(`[ask] baseline assistant count=${baseline.count} text=${summarize(baseline.text)}`);

    if (hasChatGptJs) {
      await page.evaluate((text) => window.chatgpt.send(text), prompt);
      log("[ask] sent via chatgpt.js");
    } else {
      const composer = page.locator(COMPOSER);
      await composer.fill(prompt);
      await composer.press("Enter");
      log("[ask] sent via composer fill+Enter");
    }

    log("[ask] waiting DOM completion...");
    await page.waitForFunction(
      ({ assistant, stop, done, baseline }) => {
        const nodes = [...document.querySelectorAll(assistant)];
        const latest = nodes.at(-1);
        const text = latest?.innerText?.trim() || "";
        const isNew = nodes.length > baseline.count || (text && text !== baseline.text);
        if (!isNew || !text) return false;
        const generating = !!document.querySelector(stop);
        const completed = !!latest?.querySelector(done) || !!document.querySelector(done);
        return !generating && completed;
      },
      { assistant: ASSISTANT, stop: STOP, done: DONE, baseline },
      { timeout, polling: 500 },
    );

    const text = await page.evaluate(({ assistant }) => {
      const latest = [...document.querySelectorAll(assistant)].at(-1);
      if (!latest) return "";
      const clone = latest.cloneNode(true);
      clone.querySelectorAll(".katex-mathml").forEach((node) => node.remove());
      return clone.innerText?.trim() || "";
    }, { assistant: ASSISTANT });
    log(`[ask] DOM captured text len=${text.length}: ${summarize(text)}`);

    if (text) return text;

    if (hasChatGptJs) {
      try {
        const idle = await page.evaluate(
          (limit) => window.chatgpt.isIdle(limit),
          timeout,
        );
        const libraryText = await page.evaluate(async () => {
          const value = await window.chatgpt.getLastResponse();
          if (typeof value === "string") return value;
          if (Array.isArray(value)) {
            return [...value].reverse().find((item) => typeof item === "string") || "";
          }
          if (value && typeof value === "object") {
            return value.chatgpt || value.response || value.content || value.text || "";
          }
          return "";
        });
        if (idle !== false && this.networkComplete && this.lastNetworkText) {
          log(`[ask] fallback networkComplete text=${summarize(this.lastNetworkText)}`);
          return this.lastNetworkText.trim();
        }
        if (idle !== false && libraryText && libraryText !== baseline.text) {
          log(`[ask] fallback library text=${summarize(libraryText)}`);
          return libraryText.trim();
        }
        log(`[ask] fallback idle=${idle} networkComplete=${this.networkComplete} libLen=${libraryText?.length || 0}`);
      } catch (error) {
        log("[browser] chatgpt.js fallback: " + error.message);
      }
    }

    if (this.networkComplete && this.lastNetworkText) {
      log(`[ask] fallback network text=${summarize(this.lastNetworkText)}`);
      return this.lastNetworkText.trim();
    }

    throw new Error("No response captured");
  }

  #observeNetwork(page) {
    page.on("websocket", (socket) => {
      log(`[ws] OPEN ${socket.url()}`);
      socket.on("framereceived", (event) => {
        const payload = framePayload(event);
        const raw = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload || "");
        const markers = ["reasoning", "content_type", "/message/content/parts", "message_stream_complete", "DONE"];
        if (markers.some((m) => raw.includes(m))) {
          log(`[ws] RX len=${raw.length}: ${summarize(raw)}`);
        }
        this.#recordNetworkText(payload);
      });
      socket.on("framesent", (event) => {
        const payload = framePayload(event);
        const raw = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload || "");
        log(`[ws] TX len=${raw.length}: ${summarize(raw)}`);
      });
    });
    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes("conversation")) return;
      log(`[http] RESPONSE ${response.status()} ${url}`);
      try {
        const body = await response.text();
        this.#recordNetworkText(body);
      } catch {}
    });
  }

  async #ensureChatGptJs() {
    const loaded = await this.page.evaluate(() => !!window.chatgpt?.send).catch(() => false);
    if (!loaded) log("[browser] chatgpt.js NOT loaded");
    return loaded;
  }

  #recordNetworkText(payload) {
    const updates = extractAssistantUpdates(payload);
    for (const update of updates) {
      if (update.type === "replace") {
        this.lastNetworkText = update.text;
        log(`[net] replace len=${update.text.length}: ${summarize(update.text)}`);
      }
      if (update.type === "append") {
        this.lastNetworkText += update.text;
        log(`[net] append +${update.text.length}: ${summarize(update.text)}`);
      }
      if (update.type === "complete") {
        this.networkComplete = true;
        log("[net] COMPLETE (message_stream_complete/DONE)");
      }
      if (update.type === "reasoning") {
        if (update.text !== this.lastReasoningText) {
          this.lastReasoningText = update.text;
          log(`[net] reasoning len=${update.text.length}: ${summarize(update.text)}`);
          this.onReasoning?.(update.text, "reasoning");
        }
      }
      if (update.type === "reasoning_recap") {
        if (update.text !== this.lastReasoningRecap) {
          this.lastReasoningRecap = update.text;
          const full = this.lastReasoningText
            ? `${this.lastReasoningText}\n\n${update.text}`
            : update.text;
          this.lastReasoningText = full;
          log(`[net] reasoning_recap: ${summarize(update.text)}`);
          this.onReasoning?.(update.text, "reasoning_recap");
        }
      }
    }
    if (updates.length && this.lastNetworkText) {
      log("[browser] assistant network text: " + summarize(this.lastNetworkText));
    }
  }
}

const internalBrowser = new InternalBrowser({ headless: process.env.REMOTE_IA_HEADLESS === "1" });

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(body);
}

// --- Job tracking (para o executor consultar o que o consultor esta fazendo) ---
const jobs = new Map(); // id -> { conversationId, status, reasoning, createdAt, updatedAt, kind, contentLen }

function registerJob(id, { timeout = 210000 } = {}) {
  const j = { id, status: "queued", conversationId: null, reasoning: "", kind: "status", createdAt: Date.now(), updatedAt: Date.now(), timeout };
  jobs.set(id, j);
  return j;
}
function touchJob(id, patch) {
  const j = jobs.get(id);
  if (!j) return;
  Object.assign(j, patch, { updatedAt: Date.now() });
}
function jobsJson() {
  return [...jobs.values()].map(j => ({ id: j.id, status: j.status, conversationId: j.conversationId, reasoning: j.reasoning?.slice(0, 2000) || "", kind: j.kind, createdAt: new Date(j.createdAt).toISOString(), updatedAt: new Date(j.updatedAt).toISOString() }));
}

function initSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.flushHeaders?.();
  return res;
}

function sseReasoning(sse, { id, created, model, text }) {
  if (sse.writableEnded) return;
  sse.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] })}\n\n`);
}

function sseChatCompletion(res, { id, created, model, content }) {
  const base = { id, object: "chat.completion.chunk", created, model };
  const delta = { index: 0, delta: { role: "assistant", content }, finish_reason: null };
  res.write(`data: ${JSON.stringify({ ...base, choices: [delta] })}\n\n`);
  const done = { index: 0, delta: {}, finish_reason: "stop" };
  res.write(`data: ${JSON.stringify({ ...base, choices: [done] })}\n\n`);
  res.write(`data: [DONE]\n\n`);
  res.end();
}

function summarize(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
  return text.length > 2000 ? `${text.slice(0, 2000)}…[truncated ${text.length}]` : text;
}

function sseError(res, message) {
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message, type: "server_error" } })}\n\n`);
      res.end();
    }
    return;
  }
  res.writeHead(500, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(`data: ${JSON.stringify({ error: { message, type: "server_error" } })}\n\n`);
  res.end();
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { status: "ok", browser: internalBrowser.health() });
  }

  if (req.method === "GET" && url.pathname === "/jobs") {
    return json(res, 200, { jobs: jobsJson() });
  }

  const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    const id = decodeURIComponent(jobMatch[1]);
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: "Job not found", id });
    return json(res, 200, { job: job });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return json(res, 200, {
      object: "list",
      data: [{ id: "gpt-5.6", object: "model", created: 1760000000, owned_by: "openai-via-internal-browser" }],
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return json(res, 400, { error: "Invalid JSON" });
    }
    const stream = payload.stream === true;
    const id = "chatcmpl-" + crypto.randomUUID();
    const created = Math.floor(Date.now() / 1000);
    const model = payload.model || "gpt-5.6";
    const timeout = parseInt(payload.timeout || "210000", 10);
    const job = registerJob(id, { timeout });
    log(`[gateway] REQUEST id=${id} model=${model} stream=${stream} messages=${payload.messages?.length || 0} newConversation=${payload.new_conversation !== false}`);
    log(`[gateway] REQUEST lastMsg=${JSON.stringify(payload.messages?.at(-1)?.content || "").slice(0, 200)}`);
    try {
      const onReasoningCb = (text, kind) => {
        touchJob(id, { status: kind === "reasoning_recap" ? "resumindo" : "pensando", reasoning: text, kind });
      };
      if (stream) {
        const sse = initSse(res);
        log(`[gateway] STREAM started id=${id}`);
        touchJob(id, { status: "trabalhando" });
        let reasoningSent = false;
        let content = await internalBrowser.ask(payload.messages || [], {
          newConversation: payload.new_conversation !== false,
          timeout,
          onReasoning: (text, kind) => {
            onReasoningCb(text, kind);
            if (!sse.writableEnded) {
              reasoningSent = true;
              log(`[gateway] STREAM reasoning kind=${kind} len=${text.length}: ${summarize(text)}`);
              sseReasoning(sse, { id, created, model, text });
              if (kind === "reasoning_recap") {
                sse.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_summary: text }, finish_reason: null }] })}\n\n`);
              }
            }
          },
        });
        if (reasoningSent) {
          sse.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_done: true }, finish_reason: null }] })}\n\n`);
        }
        log(`[gateway] STREAM content len=${content.length}: ${summarize(content)}`);
        touchJob(id, { status: "concluido", contentLen: content.length });
        sseChatCompletion(sse, { id, created, model, content });
        log(`[gateway] STREAM done id=${id}`);
        return;
      }
      touchJob(id, { status: "trabalhando" });
      const content = await internalBrowser.ask(payload.messages || [], {
        newConversation: payload.new_conversation !== false,
        timeout,
        onReasoning: onReasoningCb,
      });
      const reasoning = internalBrowser.lastReasoningText || undefined;
      touchJob(id, { status: "concluido", reasoning: reasoning || "", contentLen: content.length });
      log(`[gateway] RESPONSE id=${id} content len=${content.length} reasoning=${reasoning ? reasoning.length : 0}`);
      return json(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(reasoning ? { reasoning_content: reasoning, reasoning_summary: reasoning } : {}),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (error) {
      log("[gateway] error: " + error.message);
      touchJob(id, { status: "erro", reasoning: error.message });
      if (stream) return sseError(res, error.message);
      return json(res, 500, { error: error.message });
    }
  }

  return json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  log(`Internal Browser Gateway listening on http://127.0.0.1:${PORT}`);
  log(`Profile: ${PROFILE_DIR}`);
  internalBrowser.start().catch((error) => log("[browser] startup failed: " + error.message));
});

process.on("SIGINT", async () => { await internalBrowser.context?.close().catch(() => {}); process.exit(0); });
process.on("SIGTERM", async () => { await internalBrowser.context?.close().catch(() => {}); process.exit(0); });

// ── shared helpers (same logic as browser-backend.mjs) ───────────────────

function buildPrompt(messages = []) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => contentText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const user = [...messages].reverse().find((message) => message.role === "user");
  const prompt = contentText(user?.content);
  return [system, prompt].filter(Boolean).join("\n\n");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((part) => typeof part === "string" ? part : part?.text || "").join("\n");
}

function framePayload(event) {
  return event && typeof event === "object" && "payload" in event ? event.payload : event;
}

function extractAssistantUpdates(payload) {
  const raw = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload || "");
  const updates = [];
  parseNetworkValue(parseJson(raw), updates);
  return updates;
}

function parseNetworkValue(value, updates) {
  if (typeof value === "string") {
    for (const line of value.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") updates.push({ type: "complete" });
      else parseNetworkValue(parseJson(data), updates);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => parseNetworkValue(item, updates));
    return;
  }
  if (value.type === "message_stream_complete" || value.type === "done") {
    updates.push({ type: "complete" });
  }
  const message = value.message || value.v?.message;
  if (message?.author?.role === "assistant" && message.content?.content_type === "text") {
    const text = message.content.parts?.filter((part) => typeof part === "string").join("") || "";
    updates.push({ type: "replace", text });
  }
  if (message?.author?.role === "assistant" && message.content?.content_type === "reasoning") {
    const text = message.content.parts?.filter((part) => typeof part === "string").join("") || "";
    if (text) updates.push({ type: "reasoning", text });
  }
  if (message?.author?.role === "assistant" && message.content?.content_type === "reasoning_recap") {
    const text = typeof message.content.content === "string" ? message.content.content : "";
    if (text) updates.push({ type: "reasoning_recap", text });
  }
  if (value.p === "/message/content/parts/0" && value.o === "append" && typeof value.v === "string") {
    updates.push({ type: "append", text: value.v });
  }
  for (const child of Object.values(value)) {
    if (typeof child === "object" || typeof child === "string") {
      parseNetworkValue(child, updates);
    }
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
