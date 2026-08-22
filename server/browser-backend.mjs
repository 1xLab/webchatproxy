import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const CHATGPT_JS_PATH = require.resolve("@kudoai/chatgpt.js");

const CHATGPT_URL = "https://chatgpt.com/";
const COMPOSER = "#prompt-textarea";
const ASSISTANT = '[data-message-author-role="assistant"]';
const STOP = '[data-testid="stop-button"], button[aria-label*="Stop" i]';
const POLL_INTERVAL = 1500;
const STABLE_POLLS = 2;
const CONVERSATION_ID_WAIT_MS = 5000;

export function conversationIdFromUrl(url = "") {
  return String(url).match(/\/c\/([A-Za-z0-9_-]+)/)?.[1] || null;
}

export class BrowserBackend {
  constructor({ profileDir, headless = false } = {}) {
    this.profileDir = profileDir || join(process.cwd(), "browser-profile");
    this.headless = headless;
    this.context = null;
    this.page = null;
    this.queue = Promise.resolve();
    this.lastNetworkText = "";
    this.lastThinkingText = "";
    this.networkComplete = false;
    this.currentRequestId = null;
    this.lastConversationId = null;
    this.progress = new Map();
  }

  async start() {
    if (this.context && this.page && !this.page.isClosed()) return;
    await mkdir(this.profileDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      channel: process.env.REMOTE_IA_BROWSER_CHANNEL || "chrome",
      headless: this.headless,
      viewport: null,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    await this.context.addInitScript({ path: CHATGPT_JS_PATH });
    try {
      await this.context.exposeFunction("__pushDomState", (payload) => this.#onDomPush(payload));
    } catch (error) {
      console.warn(`[browser] exposeFunction __pushDomState: ${error.message}`);
    }
    await this.context.addInitScript(() => {
      if (window.__pushInstalled) return;
      window.__pushInstalled = true;
      let lastSignal = "";
      const emit = () => {
        const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (!nodes.length) return;
        const latest = nodes[nodes.length - 1];
        const text = (latest.textContent || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
        const signal = `${nodes.length}\u0000${text}`;
        if (signal === lastSignal) return;
        lastSignal = signal;
        try { window.__pushDomState({ text, thought: "", count: nodes.length, url: location.href }); } catch {}
      };
      const install = () => {
        if (!document.body) return setTimeout(install, 50);
        new MutationObserver(() => {
          clearTimeout(window.__pushTimer);
          window.__pushTimer = setTimeout(emit, 200);
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
      };
      install();
    });

    this.page = this.context.pages()[0] || await this.context.newPage();
    this.#observeNetwork(this.page);
    this.#rememberConversationId(conversationIdFromUrl(this.page.url()));
    await this.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
    await this.#ensureChatGptJs();
  }

  #onDomPush(state) {
    if (!state) return;
    this.#rememberConversationId(conversationIdFromUrl(state.url));
    if (!this.currentRequestId) return;
    const p = this.progress.get(this.currentRequestId);
    if (!p) return;
    if (typeof state.text === "string" && state.text) p.content = state.text;
    if (typeof state.thought === "string" && state.thought) p.thinking = state.thought;
    p.updatedAt = Date.now();
  }

  #rememberConversationId(id) {
    if (id) this.lastConversationId = id;
    return this.lastConversationId;
  }

  conversationId() {
    return conversationIdFromUrl(this.page && !this.page.isClosed() ? this.page.url() : "") || this.lastConversationId || null;
  }

  health() {
    return {
      enabled: true,
      running: !!this.context,
      page: this.page && !this.page.isClosed() ? this.page.url() : null,
    };
  }

  ask(messages, options = {}) {
    const run = () => this.#ask(messages, options);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  progressOf(requestId) {
    return requestId ? this.progress.get(requestId) || null : null;
  }

  async readConversationMeta(conversationId) {
    if (!this.page || !this.context || this.page.isClosed()) return { error: "sem browser" };
    const cid = String(conversationId || "").replace(/[^A-Za-z0-9_-]/g, "");
    try {
      const target = cid ? `https://chatgpt.com/c/${cid}` : CHATGPT_URL;
      if (cid && !this.page.url().includes(`/c/${cid}`)) {
        await this.page.goto(target, { waitUntil: "domcontentloaded" });
        await this.page.waitForTimeout(1500);
      }
      this.#rememberConversationId(conversationIdFromUrl(this.page.url()));
      return await this.page.evaluate(() => {
        const messages = [...document.querySelectorAll('[data-message-author-role]')].map((node) => ({
          role: node.getAttribute("data-message-author-role") || "?",
          text: (node.textContent || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().slice(0, 4000),
        }));
        const byRole = {};
        for (const message of messages) byRole[message.role] = (byRole[message.role] || 0) + 1;
        return {
          url: location.href,
          total_messages: messages.length,
          by_role: byRole,
          assistant_count: byRole.assistant || 0,
          user_count: byRole.user || 0,
          last: messages.at(-1) || null,
        };
      });
    } catch (error) {
      return { error: error.message };
    }
  }

  async readDomThinking() {
    if (!this.page || !this.context || this.page.isClosed()) return null;
    try {
      return await this.page.evaluate(() => {
        const assistants = document.querySelectorAll('[data-message-author-role="assistant"]');
        const latest = assistants[assistants.length - 1];
        return {
          streaming: !!document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop" i]'),
          hasPendingUser: !!document.querySelector('[data-message-author-role="user"]'),
          latestThought: "",
          latestAnswer: (latest?.textContent || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().slice(0, 8000),
          assistantCount: assistants.length,
          url: location.href,
        };
      });
    } catch (error) {
      return { error: error.message };
    }
  }

  async debugDom() {
    if (!this.page || !this.context || this.page.isClosed()) return { error: "sem browser" };
    try {
      return await this.page.evaluate(() => ({
        url: location.href,
        composer_present: !!document.querySelector("#prompt-textarea"),
        assistant_count: document.querySelectorAll('[data-message-author-role="assistant"]').length,
        user_count: document.querySelectorAll('[data-message-author-role="user"]').length,
        streaming: !!document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop" i]'),
      }));
    } catch (error) {
      return { error: error.message };
    }
  }

  async #ask(messages, { newConversation = true, timeout = 210_000, requestId = null, conversationId = null } = {}) {
    await this.start();
    const page = this.page;
    this.currentRequestId = requestId;
    this.lastConversationId = conversationId ? String(conversationId).replace(/[^A-Za-z0-9_-]/g, "") : null;
    if (requestId) {
      this.progress.set(requestId, {
        thinking: "",
        content: "",
        status: "pensando",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    this.lastNetworkText = "";
    this.lastThinkingText = "";
    this.networkComplete = false;

    const startUrl = conversationId
      ? `https://chatgpt.com/c/${String(conversationId).replace(/[^A-Za-z0-9_-]/g, "")}`
      : CHATGPT_URL;
    const wrongConversation = conversationId && !page.url().includes(`/c/${conversationId}`);
    const offChatGpt = !page.url().startsWith(CHATGPT_URL);
    if (newConversation || offChatGpt || wrongConversation) {
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(1500);
    }
    this.#rememberConversationId(conversationIdFromUrl(page.url()));
    await page.locator(COMPOSER).waitFor({ state: "visible", timeout: 30_000 });

    const prompt = buildPrompt(messages);
    if (!prompt) throw new Error("Empty prompt");
    const baseline = await this.#readAssistantState();
    const hasChatGptJs = await this.#ensureChatGptJs();

    if (hasChatGptJs) {
      try {
        await page.evaluate((text) => window.chatgpt.send(text), prompt);
      } catch (error) {
        console.warn(`[browser] chatgpt.js send fallback: ${error.message}`);
        const composer = page.locator(COMPOSER);
        await composer.fill(prompt);
        await composer.press("Enter");
      }
    } else {
      const composer = page.locator(COMPOSER);
      await composer.fill(prompt);
      await composer.press("Enter");
    }

    const text = await this.#waitForCompletion(baseline, timeout);
    if (!text) {
      this.#markProgress(requestId, "erro", "");
      throw new Error("No response captured");
    }
    if (!conversationId) await this.#waitForConversationId(CONVERSATION_ID_WAIT_MS);
    this.#markProgress(requestId, "concluido", text);
    return text;
  }

  async #waitForConversationId(waitMs) {
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    while (Date.now() <= deadline) {
      const id = conversationIdFromUrl(this.page && !this.page.isClosed() ? this.page.url() : "");
      if (id) return this.#rememberConversationId(id);
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.lastConversationId;
  }

  async #waitForCompletion(baseline, timeout) {
    const deadline = Date.now() + timeout;
    let lastText = "";
    let stableCount = 0;

    while (Date.now() < deadline) {
      if (this.networkComplete && this.lastNetworkText.trim()) {
        return this.lastNetworkText.trim();
      }

      const state = await this.#readAssistantState();
      const isNew = state.count > baseline.count || (state.text && state.text !== baseline.text);
      if (isNew && state.text) {
        if (state.text === lastText) stableCount++;
        else {
          lastText = state.text;
          stableCount = 0;
        }
        if (!state.streaming && stableCount >= STABLE_POLLS) return state.text;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    if (this.networkComplete && this.lastNetworkText.trim()) return this.lastNetworkText.trim();
    if (lastText) return lastText;
    throw new Error(`Response timeout after ${timeout}ms`);
  }

  async #readAssistantState() {
    return this.page.evaluate(({ assistant, stop }) => {
      const nodes = [...document.querySelectorAll(assistant)];
      return {
        count: nodes.length,
        text: nodes.at(-1)?.innerText?.trim() || "",
        streaming: !!document.querySelector(stop),
      };
    }, { assistant: ASSISTANT, stop: STOP });
  }

  #markProgress(requestId, status, text) {
    if (!requestId) return;
    const p = this.progress.get(requestId);
    if (!p) return;
    p.status = status;
    if (text) p.content = text;
    p.updatedAt = Date.now();
  }

  #observeNetwork(page) {
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.#rememberConversationId(conversationIdFromUrl(frame.url()));
    });
    page.on("websocket", (socket) => {
      socket.on("framereceived", (event) => this.#recordNetworkText(framePayload(event)));
    });
    page.on("response", async (response) => {
      if (!response.url().includes("conversation")) return;
      console.log(`[browser] response ${response.status()} ${response.url()}`);
      try { this.#recordNetworkText(await response.text()); } catch {}
    });
  }

  async #ensureChatGptJs() {
    const loaded = await this.page.evaluate(() => !!window.chatgpt?.send).catch(() => false);
    console.log(`[browser] chatgpt.js loaded=${loaded}`);
    return loaded;
  }

  #recordNetworkText(payload) {
    this.#rememberConversationId(extractConversationIdFromPayload(payload));
    const updates = extractAssistantUpdates(payload);
    for (const update of updates) {
      if (update.type === "replace") this.lastNetworkText = update.text;
      else if (update.type === "append") this.lastNetworkText += update.text;
      else if (update.type === "thinking_append") this.lastThinkingText += update.text;
      else if (update.type === "thinking_replace") this.lastThinkingText = update.text;
      else if (update.type === "complete") this.networkComplete = true;
    }
    if (updates.length && (this.lastNetworkText || this.lastThinkingText)) {
      console.log("[browser] assistant network text", summarize(this.lastNetworkText));
    }
    const p = this.currentRequestId ? this.progress.get(this.currentRequestId) : null;
    if (p) {
      if (this.lastNetworkText) p.content = this.lastNetworkText;
      if (this.lastThinkingText) p.thinking = this.lastThinkingText;
      if (this.networkComplete) p.status = "complete";
      p.updatedAt = Date.now();
    }
  }
}

function buildPrompt(messages = []) {
  const system = messages.filter((m) => m.role === "system").map((m) => contentText(m.content)).filter(Boolean).join("\n\n");
  const user = [...messages].reverse().find((m) => m.role === "user");
  return [system, contentText(user?.content)].filter(Boolean).join("\n\n");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((part) => typeof part === "string" ? part : part?.text || "").join("\n");
}

function summarize(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
  return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

function framePayload(event) {
  return event && typeof event === "object" && "payload" in event ? event.payload : event;
}

export function extractConversationIdFromPayload(payload) {
  const raw = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload || "");
  const parsed = parseJson(raw);
  return findConversationId(parsed) || conversationIdFromUrl(raw);
}

function findConversationId(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = findConversationId(item, seen);
      if (id) return id;
    }
    return null;
  }
  for (const key of ["conversation_id", "conversationId"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && /^[A-Za-z0-9_-]+$/.test(candidate)) return candidate;
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const id = findConversationId(child, seen);
      if (id) return id;
    }
    if (typeof child === "string") {
      const id = conversationIdFromUrl(child);
      if (id) return id;
    }
  }
  return null;
}

export function extractAssistantUpdates(payload) {
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

  if (["message_stream_complete", "done", "finished_successfully"].includes(String(value.type || "").toLowerCase())) {
    updates.push({ type: "complete" });
  }
  if (typeof value.v === "string" && /^finished_successfully$/i.test(value.v)) {
    updates.push({ type: "complete" });
  }
  if (typeof value.status === "string" && /^(finished_successfully|completed|complete|done)$/i.test(value.status)) {
    updates.push({ type: "complete" });
  }

  const message = value.message || value.v?.message;
  if (message?.author?.role === "assistant" && message.content?.content_type === "text") {
    const text = message.content.parts?.filter((part) => typeof part === "string").join("") || "";
    if (text) updates.push({ type: "replace", text });
  }
  if (message?.content?.content_type && /reasoning|thinking/i.test(String(message.content.content_type))) {
    const text = message.content.parts?.map((part) => typeof part === "string" ? part : part?.content || "").join("") || "";
    if (text) updates.push({ type: "thinking_replace", text });
  }

  if (typeof value.p === "string" && value.p.includes("/message/content/parts/") && typeof value.v === "string") {
    const isReasoning = /\/reasoning\/|\/thinking\//i.test(value.p);
    if (!/^finished_successfully$/i.test(value.v)) {
      if (value.o === "append") updates.push({ type: isReasoning ? "thinking_append" : "append", text: value.v });
      else if (value.o === "replace") updates.push({ type: isReasoning ? "thinking_replace" : "replace", text: value.v });
    }
  }

  for (const child of Object.values(value)) {
    if (typeof child === "object" && child) parseNetworkValue(child, updates);
  }
}

function parseJson(value) {
  try { return JSON.parse(value); }
  catch { return value; }
}
