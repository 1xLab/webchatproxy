import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function engineError(message, code = "ENGINE_UPSTREAM_ERROR", status = null, details = null) {
  const error = new Error(message);
  error.code = code;
  if (status != null) error.status = status;
  if (details != null) error.details = details;
  return error;
}

function normalizeErrorPayload(payload, status) {
  const message = payload?.error || payload?.message || `engine request failed (${status})`;
  const code = payload?.code
    || (status === 401 || status === 403 ? "ENGINE_AUTH_REQUIRED" : status === 501 ? "ENGINE_UNSUPPORTED" : "ENGINE_UPSTREAM_ERROR");
  return engineError(String(message), code, status, payload);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text || part?.content || "").join("\n");
  }
  return content == null ? "" : String(content);
}

export class Web2ApiEngine {
  constructor({ baseDir, runtimeDir, profileDir, headless = false, journal = null, env = process.env } = {}) {
    if (!baseDir) throw new Error("baseDir is required");
    this.baseDir = baseDir;
    this.runtimeDir = runtimeDir || join(baseDir, "runtime");
    this.profileDir = profileDir || join(baseDir, "browser-profile");
    this.headless = headless;
    this.journal = journal;
    this.env = env;
    this.host = env.WEBCHAT_ENGINE_HOST || "127.0.0.1";
    this.port = Number(env.WEBCHAT_ENGINE_PORT || 3211);
    this.baseUrl = env.WEBCHAT_ENGINE_URL || `http://${this.host}:${this.port}`;
    this.cdpPort = Number(env.WEBCHAT_ENGINE_CDP_PORT || 9222);
    this.python = env.WEBCHAT_ENGINE_PYTHON || join(baseDir, ".venv-engine", "bin", "python");
    this.bridge = env.WEBCHAT_ENGINE_BRIDGE || join(baseDir, "engine", "web2api_bridge.py");
    this.autoStart = env.WEBCHAT_ENGINE_AUTOSTART !== "0";
    this.child = null;
    this.started = false;
    this.lastHealth = {
      status: "starting",
      engine: "chatgpt-web2api",
      chrome_running: false,
      driver_connected: false,
      last_error: null,
    };
    this.lastConversationId = null;
    this.currentRequestId = null;
    this.progress = new Map();
  }

  async #raw(path, { method = "GET", body = null, timeout = 30_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body == null ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; }
      catch { payload = { error: text || `invalid JSON from engine (${response.status})` }; }
      if (!response.ok) throw normalizeErrorPayload(payload, response.status);
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") throw engineError(`engine request timed out: ${path}`, "ENGINE_TIMEOUT");
      if (error?.code) throw error;
      throw engineError(`engine unavailable: ${error.message}`, "ENGINE_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  }

  async #probe() {
    try {
      const health = await this.#raw("/health", { timeout: 2_000 });
      this.lastHealth = { ...this.lastHealth, ...(health || {}) };
      return health;
    } catch {
      return null;
    }
  }

  #spawnBridge() {
    if (this.child && this.child.exitCode == null) return;
    if (!existsSync(this.python)) {
      throw engineError(`engine python not installed: ${this.python}; run ./start.sh engine-install`, "ENGINE_NOT_INSTALLED");
    }
    if (!existsSync(this.bridge)) throw engineError(`engine bridge not found: ${this.bridge}`, "ENGINE_NOT_INSTALLED");

    const childEnv = {
      ...process.env,
      ...this.env,
      WEBCHAT_ENGINE_HOST: this.host,
      WEBCHAT_ENGINE_PORT: String(this.port),
      WEBCHAT_ENGINE_CDP_PORT: String(this.cdpPort),
      WEBCHAT_PROFILE_DIR: this.profileDir,
      WEBCHAT_RUNTIME_DIR: this.runtimeDir,
      WEBCHAT_HEADLESS: this.headless ? "1" : "0",
    };
    this.child = spawn(this.python, [this.bridge], {
      cwd: this.baseDir,
      env: childEnv,
      stdio: ["ignore", "inherit", "inherit"],
    });
    this.child.on("exit", (code, signal) => {
      this.started = false;
      this.lastHealth = {
        ...this.lastHealth,
        status: "broken",
        driver_connected: false,
        last_error: `engine exited code=${code ?? "null"} signal=${signal || "none"}`,
      };
      this.journal?.record("web2api_engine_exit", { code, signal }, "error");
    });
    this.journal?.record("web2api_engine_spawned", { pid: this.child.pid, port: this.port, cdpPort: this.cdpPort });
  }

  async start() {
    const existing = await this.#probe();
    if (existing) {
      this.started = true;
      return existing;
    }
    if (!this.autoStart) throw engineError(`engine is not reachable at ${this.baseUrl}`, "ENGINE_UNAVAILABLE");
    this.#spawnBridge();
    const deadline = Date.now() + Math.max(5_000, Number(this.env.WEBCHAT_ENGINE_START_TIMEOUT || 60_000));
    let health = null;
    while (Date.now() < deadline) {
      if (this.child && this.child.exitCode != null) break;
      health = await this.#probe();
      if (health) {
        this.started = true;
        return health;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw engineError(`engine failed to start at ${this.baseUrl}`, "ENGINE_UNAVAILABLE", null, this.lastHealth);
  }

  snapshot() {
    return { ...this.lastHealth, reachable: this.started };
  }

  async health() {
    await this.start();
    const health = await this.#raw("/health");
    this.lastHealth = { ...this.lastHealth, ...(health || {}) };
    return this.snapshot();
  }

  async listModels() {
    await this.start();
    const payload = await this.#raw("/v1/models");
    return Array.isArray(payload?.models) ? payload.models : [];
  }

  async listProjects() {
    await this.start();
    const payload = await this.#raw("/v1/projects");
    return Array.isArray(payload?.projects) ? payload.projects : [];
  }

  async listConversations({ projectId = null, all = false, offset = 0, limit = 50 } = {}) {
    await this.start();
    const params = new URLSearchParams({ offset: String(offset || 0), limit: String(limit || 50) });
    if (projectId) params.set("project_id", projectId);
    if (all) params.set("all", "1");
    const payload = await this.#raw(`/v1/conversations?${params}`);
    const items = Array.isArray(payload?.conversations) ? payload.conversations : [];
    return {
      project_id: projectId || null,
      items,
      offset: Number(payload?.offset ?? offset ?? 0),
      limit: Number(payload?.limit ?? limit ?? 50),
      pages: Number(payload?.pages_scanned || 1),
      cursor: null,
    };
  }

  async getConversation(id, { offset = 0, limit = 500 } = {}) {
    const conversationId = String(id || "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(conversationId)) throw engineError("invalid conversation id", "INVALID_CONVERSATION_ID");
    await this.start();
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    return this.#raw(`/v1/conversations/${encodeURIComponent(conversationId)}?${params}`);
  }

  async listProjectFiles(projectId) {
    const id = String(projectId || "").trim();
    if (!/^g-p-[A-Za-z0-9_-]+$/.test(id)) throw engineError("invalid project id", "INVALID_PROJECT_ID");
    await this.start();
    return this.#raw(`/v1/projects/${encodeURIComponent(id)}/files`);
  }

  async ask(messages, {
    timeout = 210_000,
    requestId = null,
    conversationId = null,
    projectId = null,
    attachments = [],
    reasoningEffort = null,
    model = "auto",
  } = {}) {
    if (attachments?.length) throw engineError("message attachments are not supported by the pinned engine", "ENGINE_ATTACHMENTS_UNSUPPORTED", 501);
    if (reasoningEffort) throw engineError("reasoning_effort is not supported by the pinned engine", "ENGINE_REASONING_EFFORT_UNSUPPORTED", 501);
    await this.start();
    this.currentRequestId = requestId || null;
    if (requestId) this.progress.set(requestId, { status: "running", content: "", thinking: "", updatedAt: Date.now() });
    try {
      const payload = await this.#raw("/v1/chat/completions", {
        method: "POST",
        timeout: Math.max(5_000, Number(timeout) || 210_000),
        body: {
          model: model === "chatgpt-web" ? "auto" : model,
          messages: (messages || []).map((message) => ({ ...message, content: contentText(message?.content) })),
          conversation_id: conversationId || null,
          project_id: projectId || null,
        },
      });
      this.lastConversationId = payload?.conversation_id || conversationId || this.lastConversationId;
      const content = String(payload?.content || "");
      if (requestId) this.progress.set(requestId, { status: "completed", content, thinking: "", updatedAt: Date.now() });
      return content;
    } finally {
      this.currentRequestId = null;
    }
  }

  conversationId() {
    return this.lastConversationId;
  }

  progressOf(id) {
    return this.progress.get(id) || null;
  }

  async restart() {
    await this.close();
    this.child = null;
    this.started = false;
    return this.start();
  }

  async close() {
    if (!this.child || this.child.exitCode != null) {
      this.started = false;
      return;
    }
    const child = this.child;
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode == null) child.kill("SIGKILL");
    this.started = false;
  }
}
