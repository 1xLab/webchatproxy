import crypto from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const STOP_SELECTOR = '[data-testid="stop-button"], button[aria-label*="Stop" i]';
const now = () => new Date().toISOString();

function safeRequestId(value) {
  if (!value) return null;
  const id = String(value).trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error("request_id must match [A-Za-z0-9._:-] and be <= 128 chars");
  return id;
}

function conversationIdFromUrl(url = "") {
  return String(url).match(/\/c\/([A-Za-z0-9_-]+)/)?.[1] || null;
}

function requestSummary(payload = {}) {
  const last = [...(payload.messages || [])].reverse().find((m) => m?.role === "user");
  const content = typeof last?.content === "string"
    ? last.content
    : Array.isArray(last?.content)
      ? last.content.map((p) => typeof p === "string" ? p : p?.text || "").join("\n")
      : "";
  return content.slice(0, 500);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stableValue(value[k])]));
}

function requestHash(model, request) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue({ model, request }))).digest("hex");
}

export function looksLikeBrowserCrash(error) {
  const message = String(error?.message || error || "");
  return /target (page|context|browser).*closed|target.*has been closed|browser.*has been closed|context.*has been closed|browser.*disconnected|browser.*crash/i.test(message);
}

export class JobManager {
  constructor({ backend, journal, runtimeDir } = {}) {
    this.backend = backend;
    this.journal = journal;
    this.runtimeDir = runtimeDir;
    this.jobsDir = join(runtimeDir, "jobs");
    this.jobs = new Map();
    this.queue = [];
    this.runningId = null;
    this.waiters = new Map();
    this.retentionMs = Math.max(1, Number(process.env.WEBCHAT_JOB_RETENTION_DAYS || 14)) * 86400000;
  }

  async init() {
    await mkdir(this.jobsDir, { recursive: true });
    const files = await readdir(this.jobsDir).catch(() => []);
    const cutoff = Date.now() - this.retentionMs;
    let removed = 0;
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const path = join(this.jobsDir, file);
      try {
        const job = JSON.parse(await readFile(path, "utf8"));
        const timestamp = Date.parse(job.finished_at || job.updated_at || job.created_at || 0);
        if (TERMINAL.has(job.status) && Number.isFinite(timestamp) && timestamp < cutoff) {
          await unlink(path).catch(() => {});
          removed++;
          continue;
        }
        if (["queued", "running", "cancel_requested"].includes(job.status)) {
          job.status = "interrupted";
          job.error = "Gateway restarted before the job finished";
          job.updated_at = now();
          job.finished_at = job.updated_at;
          await this.#persist(job);
        }
        this.jobs.set(job.id, job);
      } catch (error) {
        this.journal?.record("job_load_failed", { file, error: error.message }, "error");
      }
    }
    this.journal?.record("job_manager_ready", { recovered: this.jobs.size, removed });
  }

  async create(payload = {}, { requestId = null } = {}) {
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) throw new Error("messages must be a non-empty array");
    const externalId = safeRequestId(requestId || payload.request_id || null);
    const id = externalId || `job_${crypto.randomUUID()}`;
    const model = payload.model || "chatgpt-web";
    const request = {
      messages: payload.messages,
      conversation_id: payload.conversation_id || null,
      new_conversation: payload.new_conversation !== false,
      timeout: Math.max(1000, Number(payload.timeout) || 210000),
    };
    const hash = requestHash(model, request);
    const existing = this.jobs.get(id);
    if (existing) {
      if (existing.request_hash && existing.request_hash !== hash) {
        const error = new Error("request_id_conflict");
        error.code = "REQUEST_ID_CONFLICT";
        throw error;
      }
      this.journal?.record("job_idempotent_reuse", { jobId: id, status: existing.status });
      return { job: this.#public(existing), reused: true };
    }

    const created = now();
    const job = {
      id,
      status: "queued",
      model,
      request,
      request_hash: hash,
      prompt_preview: requestSummary(payload),
      conversation_id: payload.conversation_id || null,
      result: null,
      error: null,
      created_at: created,
      updated_at: created,
      started_at: null,
      finished_at: null,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    await this.#persist(job);
    this.journal?.record("job_queued", { jobId: id, conversationId: job.conversation_id });
    this.#drain();
    return { job: this.#public(job), reused: false };
  }

  list({ limit = 100 } = {}) {
    const safe = Math.max(1, Math.min(Number(limit) || 100, 1000));
    return [...this.jobs.values()]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, safe)
      .map((job) => this.#public(job));
  }

  get(id, { live = true } = {}) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const result = this.#public(job);
    if (live && id === this.runningId) {
      const p = this.backend?.progressOf?.(id);
      if (p) {
        result.live = {
          status: p.status || job.status,
          content: p.content || "",
          thinking: p.thinking || "",
          updated_at: p.updatedAt ? new Date(p.updatedAt).toISOString() : job.updated_at,
        };
      }
    }
    result.queue_position = job.status === "queued" ? this.queue.indexOf(id) + 1 : 0;
    return result;
  }

  stats() {
    const counts = {};
    for (const job of this.jobs.values()) counts[job.status] = (counts[job.status] || 0) + 1;
    return { running: this.runningId, queued: this.queue.length, total: this.jobs.size, counts };
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (TERMINAL.has(job.status)) return this.#public(job);
    if (job.status === "queued") {
      this.queue = this.queue.filter((q) => q !== id);
      job.status = "cancelled";
      job.updated_at = now();
      job.finished_at = job.updated_at;
      await this.#persist(job);
      this.#notify(job);
      return this.#public(job);
    }
    job.status = "cancel_requested";
    job.updated_at = now();
    await this.#persist(job);
    try {
      const page = this.backend?.page;
      if (page) {
        const stop = page.locator(STOP_SELECTOR).first();
        if (await stop.count() && await stop.isVisible().catch(() => false)) await stop.click({ timeout: 3000 }).catch(() => {});
      }
    } catch {}
    return this.#public(job);
  }

  async waitFor(id, timeoutMs = 240000) {
    const current = this.jobs.get(id);
    if (!current) throw new Error("Job not found");
    if (TERMINAL.has(current.status)) return this.#public(current);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.get(id)?.delete(waiter);
        reject(new Error("Timeout waiting for job completion"));
      }, timeoutMs);
      const waiter = (job) => {
        clearTimeout(timer);
        resolve(this.#public(job));
      };
      const set = this.waiters.get(id) || new Set();
      set.add(waiter);
      this.waiters.set(id, set);
    });
  }

  #drain() {
    if (this.runningId) return;
    const id = this.queue.shift();
    if (!id) return;
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued") {
      queueMicrotask(() => this.#drain());
      return;
    }
    this.runningId = id;
    this.#run(job)
      .catch((error) => this.journal?.record("job_run_unhandled", { jobId: id, error: error.message }, "error"))
      .finally(() => {
        this.runningId = null;
        this.#drain();
      });
  }

  async #askWithRecovery(job) {
    const options = {
      newConversation: job.request.new_conversation,
      timeout: job.request.timeout,
      requestId: job.id,
      conversationId: job.request.conversation_id,
    };
    try {
      return await this.backend.ask(job.request.messages, options);
    } catch (error) {
      if (!looksLikeBrowserCrash(error)) throw error;
      this.journal?.record("browser_auto_recovery", { jobId: job.id, error: error.message }, "warn");
      try { await this.backend.context?.close?.(); } catch {}
      this.backend.context = null;
      this.backend.page = null;
      this.backend.currentRequestId = null;
      this.backend.lastNetworkText = "";
      this.backend.lastThinkingText = "";
      this.backend.networkComplete = false;
      this.backend.lastConversationId = job.request.conversation_id || null;
      this.backend.queue = Promise.resolve();
      await this.backend.start();
      return await this.backend.ask(job.request.messages, options);
    }
  }

  async #run(job) {
    job.status = "running";
    job.started_at = now();
    job.updated_at = job.started_at;
    await this.#persist(job);
    this.journal?.record("job_started", { jobId: job.id, conversationId: job.conversation_id });
    try {
      const content = await this.#askWithRecovery(job);
      if (job.status === "cancel_requested") {
        job.status = "cancelled";
        job.result = null;
      } else {
        job.status = "completed";
        job.result = { content };
      }
      job.conversation_id = this.backend?.conversationId?.()
        || conversationIdFromUrl(this.backend?.page?.url?.())
        || job.conversation_id;
      job.updated_at = now();
      job.finished_at = job.updated_at;
      await this.#persist(job);
      this.journal?.record("job_finished", {
        jobId: job.id,
        status: job.status,
        conversationId: job.conversation_id,
        contentLength: content?.length || 0,
      });
    } catch (error) {
      job.status = job.status === "cancel_requested" ? "cancelled" : "failed";
      job.error = error.message;
      job.updated_at = now();
      job.finished_at = job.updated_at;
      await this.#persist(job);
      this.journal?.record("job_failed", { jobId: job.id, error: error.message }, "error");
    } finally {
      if (this.backend?.currentRequestId === job.id) this.backend.currentRequestId = null;
      this.backend?.progress?.delete?.(job.id);
      this.#notify(job);
    }
  }

  #notify(job) {
    const waiters = this.waiters.get(job.id);
    if (!waiters) return;
    this.waiters.delete(job.id);
    for (const waiter of waiters) waiter(job);
  }

  async #persist(job) {
    const target = join(this.jobsDir, `${encodeURIComponent(job.id)}.json`);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    await rename(temp, target);
  }

  #public(job) {
    return {
      id: job.id,
      status: job.status,
      model: job.model,
      conversation_id: job.conversation_id,
      prompt_preview: job.prompt_preview,
      result: job.result,
      error: job.error,
      created_at: job.created_at,
      updated_at: job.updated_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
    };
  }
}
