import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserBackend } from "../browser-backend.mjs";
import { ChatGptControl } from "./chatgpt-control.mjs";
import { EventJournal } from "./event-journal.mjs";
import { FileStore } from "./file-store.mjs";
import { JobManager } from "./job-manager.mjs";
import { ResourceCatalog } from "./resource-catalog.mjs";
import {
  doctorReport,
  domSnapshot,
  inspectBrowser,
  restartBrowser,
  saveDiagnosticBundle,
  screenshotBuffer,
} from "./diagnostics.mjs";

const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
const STOP_SELECTOR = '[data-testid="stop-button"], button[aria-label*="Stop" i]';
const DONE_SELECTOR = '[data-testid="copy-turn-action-button"]';

function anonymousAccount() {
  return {
    authenticated: false,
    plan: null,
    subscription_active: false,
    classification: "unknown",
    confidence: "none",
    evidence: "not_observed",
    observed_at: null,
    source: "persistent_detector",
  };
}

export class GatewayRuntime {
  constructor({ baseDir, env = process.env } = {}) {
    if (!baseDir) throw new Error("baseDir is required");
    this.env = env;
    this.baseDir = baseDir;
    this.config = Object.freeze({
      host: env.WEBCHAT_HOST || "127.0.0.1",
      port: Number(env.WEBCHAT_PORT || env.PORT || 3210),
      runtime_dir: env.WEBCHAT_RUNTIME_DIR || join(baseDir, "runtime"),
      profile_dir: env.WEBCHAT_PROFILE_DIR || join(baseDir, "browser-profile"),
      headless: env.WEBCHAT_HEADLESS === "1" || env.REMOTE_IA_HEADLESS === "1",
      auth_enabled: !!env.WEBCHAT_API_TOKEN,
      cors_origin: env.WEBCHAT_CORS_ORIGIN || null,
      backend: "playwright",
      browser_start_disabled: env.WEBCHAT_DISABLE_BROWSER_START === "1",
      chatgpt_account_id: env.WEBCHAT_CHATGPT_ACCOUNT_ID || null,
      upload_max_bytes: Math.max(1024, Number(env.WEBCHAT_UPLOAD_MAX_BYTES || 50 * 1024 * 1024)),
      upload_retention_days: Math.max(1, Number(env.WEBCHAT_UPLOAD_RETENTION_DAYS || 2)),
    });
    this.apiToken = env.WEBCHAT_API_TOKEN || "";
    this.journal = null;
    this.browser = null;
    this.control = null;
    this.catalog = null;
    this.fileStore = null;
    this.jobs = null;
    this.accountState = anonymousAccount();
    this.accountStateFile = join(this.config.runtime_dir, "account-state.json");
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    await mkdir(this.config.runtime_dir, { recursive: true });
    await this.#loadAccountState();
    this.journal = new EventJournal({
      file: join(this.config.runtime_dir, "logs", "events.jsonl"),
      maxMemory: Number(this.env.WEBCHAT_EVENT_MEMORY || 1500),
    });
    await this.journal.init();
    this.catalog = await new ResourceCatalog({ runtimeDir: this.config.runtime_dir }).init();
    this.fileStore = await new FileStore({
      runtimeDir: this.config.runtime_dir,
      maxBytes: this.config.upload_max_bytes,
      retentionDays: this.config.upload_retention_days,
    }).init();
    this.browser = new BrowserBackend({
      profileDir: this.config.profile_dir,
      headless: this.config.headless,
    });
    this.control = new ChatGptControl({
      backend: this.browser,
      journal: this.journal,
      accountId: this.config.chatgpt_account_id,
    });
    this.jobs = new JobManager({
      backend: this.browser,
      journal: this.journal,
      runtimeDir: this.config.runtime_dir,
      fileStore: this.fileStore,
    });
    await this.jobs.init();
    this.initialized = true;
    return this;
  }

  assertReady() {
    if (!this.initialized || !this.browser || !this.control || !this.catalog || !this.fileStore || !this.jobs || !this.journal) {
      throw new Error("gateway_runtime_not_initialized");
    }
  }

  health() {
    this.assertReady();
    return {
      status: "ok",
      service: "webchat-gateway",
      pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
      browser: {
        running: !!this.browser.context,
        page_ready: !!this.browser.page,
      },
      account: this.account(),
      catalog: { projects: this.catalog.listProjects().length },
      jobs: this.jobs.stats(),
      port: this.config.port,
    };
  }

  account() {
    return { ...this.accountState };
  }

  async startBrowser() {
    this.assertReady();
    if (this.config.browser_start_disabled) {
      this.journal.record("browser_start_skipped", { reason: "WEBCHAT_DISABLE_BROWSER_START=1" }, "warn");
      return { skipped: true, account: this.account() };
    }
    await this.browser.start();
    const state = await inspectBrowser(this.browser);
    await this.#captureAccountState(state);
    this.journal.record("browser_started", { status: state.status, url: state.url || null, account: this.account() });
    return { ...state, persistent_account: this.account() };
  }

  async ready() {
    this.assertReady();
    const state = await inspectBrowser(this.browser);
    await this.#captureAccountState(state);
    return { ...state, persistent_account: this.account() };
  }

  async doctor() {
    this.assertReady();
    const report = await doctorReport({
      backend: this.browser,
      jobs: this.jobs,
      journal: this.journal,
      config: this.config,
    });
    await this.#captureAccountState(report.browser);
    return { ...report, account: this.account() };
  }

  async listProjects({ live = false, sync = true, all = true, cursor = null } = {}) {
    this.assertReady();
    if (!live) return { source: "catalog", projects: this.catalog.listProjects() };
    const result = await this.control.listProjects({ all, cursor });
    const projects = sync
      ? await this.catalog.syncProjects(result.items, { source: "live" })
      : result.items;
    return { source: "live", projects, cursor: result.cursor, pages: result.pages, raw_count: result.items.length };
  }

  async importProjects(input) {
    this.assertReady();
    const result = await this.catalog.importProjects(input, { source: "admin_import" });
    this.journal.record("project_catalog_imported", { imported: result.imported, total: result.total });
    return result;
  }

  async resolveProject(ref, { syncOnMiss = true } = {}) {
    this.assertReady();
    let project = this.catalog.resolveProject(ref);
    if (project || !syncOnMiss) return project;
    try {
      const live = await this.control.listProjects({ all: true });
      await this.catalog.syncProjects(live.items, { source: "live" });
      project = this.catalog.resolveProject(ref);
    } catch (error) {
      this.journal.record("project_live_resolve_failed", { ref: String(ref), error: error.message }, "warn");
    }
    return project;
  }

  async listConversations(options = {}) {
    this.assertReady();
    let projectId = options.project_id || options.projectId || null;
    if (!projectId && options.project) {
      const project = await this.resolveProject(options.project);
      if (!project) {
        const error = new Error(`project not found: ${options.project}`);
        error.code = "PROJECT_NOT_FOUND";
        throw error;
      }
      projectId = project.id;
    }
    return this.control.listConversations({
      projectId,
      all: options.all === true,
      cursor: options.cursor || null,
      offset: options.offset || 0,
      limit: options.limit || 50,
    });
  }

  async getConversation(id) {
    this.assertReady();
    return this.control.getConversation(id);
  }

  async listProjectFiles(ref) {
    this.assertReady();
    const project = await this.resolveProject(ref);
    if (!project) {
      const error = new Error(`project not found: ${ref}`);
      error.code = "PROJECT_NOT_FOUND";
      throw error;
    }
    const result = await this.control.listProjectFiles(project.id);
    return { project, ...result };
  }

  async saveUpload(stream, metadata = {}) {
    this.assertReady();
    const upload = await this.fileStore.saveStream(stream, metadata);
    this.journal.record("upload_staged", { id: upload.id, name: upload.name, size: upload.size, sha256: upload.sha256 });
    return upload;
  }

  async getUpload(id) {
    this.assertReady();
    const { path: _path, ...metadata } = await this.fileStore.get(id);
    return metadata;
  }

  async deleteUpload(id) {
    this.assertReady();
    const result = await this.fileStore.remove(id);
    this.journal.record("upload_deleted", { id: result.id });
    return result;
  }

  async prepareJobPayload(payload = {}) {
    this.assertReady();
    let prepared = { ...payload };
    const projectRef = payload.project_id || payload.project || payload.project_url || null;
    if (projectRef) {
      const project = await this.resolveProject(projectRef);
      if (!project) {
        const error = new Error(`project not found: ${projectRef}`);
        error.code = "PROJECT_NOT_FOUND";
        throw error;
      }
      prepared = { ...prepared, project_id: project.id, project_url: project.url };
    }

    if (prepared.attachments != null) {
      if (!Array.isArray(prepared.attachments)) throw new Error("attachments must be an array of staged upload ids");
      await this.fileStore.resolveMany(prepared.attachments);
    }

    if (this.browser?.page && this.browser?.context) {
      const state = await inspectBrowser(this.browser).catch(() => null);
      if (state) await this.#captureAccountState(state);
    }

    const account = this.account();
    if (!account.observed_at) return prepared;

    const messages = Array.isArray(prepared.messages) ? [...prepared.messages] : [];
    const context = [
      "WebChat gateway account state (verified local control data; source of truth for this ChatGPT web account):",
      `authenticated=${account.authenticated === true ? "true" : "false"}`,
      `plan=${account.plan || "none"}`,
      `subscription_active=${account.subscription_active === true ? "true" : "false"}`,
      `observed_at=${account.observed_at}`,
      "When asked about login, account plan or subscription, answer from this control data. If plan=free, state that there is no active paid subscription. Do not invent a paid plan.",
    ].join("\n");

    messages.unshift({ role: "system", content: context });
    return { ...prepared, messages };
  }

  async dom() {
    this.assertReady();
    return domSnapshot(this.browser);
  }

  async debugSnapshot() {
    this.assertReady();
    const runningId = this.jobs.stats().running || null;
    const progress = runningId ? this.browser.progressOf?.(runningId) || null : null;
    const page = this.browser.page;
    let dom = null;
    if (page) {
      dom = await page.evaluate(({ assistant, stop, done }) => {
        const assistants = [...document.querySelectorAll(assistant)];
        const latest = assistants.at(-1);
        return {
          assistant_count: assistants.length,
          latest_assistant_length: (latest?.innerText || "").trim().length,
          stop_present: !!document.querySelector(stop),
          done_present: !!document.querySelector(done),
          composer_present: !!document.querySelector("#prompt-textarea"),
          url: location.href,
        };
      }, { assistant: ASSISTANT_SELECTOR, stop: STOP_SELECTOR, done: DONE_SELECTOR }).catch((error) => ({ error: error.message }));
    }
    return {
      service: "webchat-gateway",
      timestamp: new Date().toISOString(),
      account: this.account(),
      job: runningId ? this.jobs.get(runningId, { live: true }) : null,
      browser: {
        context_running: !!this.browser.context,
        page_ready: !!page,
        current_request_id: this.browser.currentRequestId || null,
        network_complete: this.browser.networkComplete === true,
        network_text_length: (this.browser.lastNetworkText || "").length,
        thinking_text_length: (this.browser.lastThinkingText || "").length,
        chatgpt_account_id_observed: !!this.browser.chatgptAccountId,
        progress: progress ? {
          status: progress.status || null,
          content_length: (progress.content || "").length,
          thinking_length: (progress.thinking || "").length,
          updated_at: progress.updatedAt ? new Date(progress.updatedAt).toISOString() : null,
        } : null,
        dom,
      },
      catalog: { projects: this.catalog.listProjects().length },
      jobs: this.jobs.stats(),
    };
  }

  events({ limit = 200, jobId = null, level = null } = {}) {
    this.assertReady();
    return this.journal.list({ limit, jobId, level });
  }

  async screenshot() {
    this.assertReady();
    return screenshotBuffer(this.browser);
  }

  async diagnosticBundle() {
    this.assertReady();
    const bundle = await saveDiagnosticBundle(this.browser, this.config.runtime_dir, { account: this.account() });
    this.journal.record("diagnostic_bundle_created", { screenshot: bundle.screenshot });
    return bundle;
  }

  async restartBrowser() {
    this.assertReady();
    const running = this.jobs.stats().running;
    if (running) {
      const error = new Error("job_running");
      error.code = "JOB_RUNNING";
      error.jobId = running;
      throw error;
    }
    this.journal.record("browser_restart_requested");
    const state = await restartBrowser(this.browser);
    await this.#captureAccountState(state);
    this.journal.record("browser_restarted", { status: state.status, url: state.url || null, account: this.account() });
    return { ...state, persistent_account: this.account() };
  }

  async createSmokeJob() {
    this.assertReady();
    const id = `diag_${crypto.randomUUID()}`;
    const payload = await this.prepareJobPayload({
      model: "chatgpt-web",
      messages: [{ role: "user", content: "Responda apenas: WEBCHAT_OK" }],
      new_conversation: true,
      timeout: Number(this.env.WEBCHAT_SMOKE_TIMEOUT || 120000),
    });
    const created = await this.jobs.create(payload, { requestId: id });
    this.journal.record("diagnostic_smoke_queued", { jobId: id });
    return { ...created, expected: "WEBCHAT_OK" };
  }

  async close() {
    if (!this.initialized) return;
    try { await this.browser?.context?.close?.(); } catch {}
    await this.journal?.flush?.();
  }

  async #loadAccountState() {
    try {
      const parsed = JSON.parse(await readFile(this.accountStateFile, "utf8"));
      if (parsed && typeof parsed === "object") this.accountState = { ...anonymousAccount(), ...parsed };
    } catch {}
  }

  async #captureAccountState(browserState = {}) {
    const account = browserState?.account;
    const verifiableAuthenticated = account?.authenticated === true && ["ready", "degraded"].includes(browserState.status);
    const verifiableLoggedOut = browserState.status === "auth_required" && browserState.login_present === true;
    if (!verifiableAuthenticated && !verifiableLoggedOut) return this.account();

    const next = {
      ...anonymousAccount(),
      ...account,
      observed_at: new Date().toISOString(),
      source: "persistent_detector",
      browser_status: browserState.status,
    };
    if (JSON.stringify(next) === JSON.stringify(this.accountState)) return this.account();

    this.accountState = next;
    const temp = `${this.accountStateFile}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temp, this.accountStateFile);
    this.journal?.record("account_state_persisted", {
      authenticated: next.authenticated,
      plan: next.plan,
      subscription_active: next.subscription_active,
      confidence: next.confidence,
      evidence: next.evidence,
    });
    return this.account();
  }
}
