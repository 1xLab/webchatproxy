import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventJournal } from "./event-journal.mjs";
import { FileStore } from "./file-store.mjs";
import { JobManager } from "./job-manager.mjs";
import { ResourceCatalog } from "./resource-catalog.mjs";
import { Web2ApiEngine } from "./web2api-engine.mjs";

function anonymousAccount() {
  return {
    authenticated: false,
    plan: null,
    subscription_active: false,
    classification: "unknown",
    confidence: "none",
    evidence: "engine_not_connected",
    observed_at: null,
    source: "chatgpt-web2api",
  };
}

function unsupported(message, code = "ENGINE_DEBUG_UNSUPPORTED") {
  const error = new Error(message);
  error.code = code;
  error.status = 501;
  return error;
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
      backend: "chatgpt-web2api",
      engine_url: env.WEBCHAT_ENGINE_URL || `http://${env.WEBCHAT_ENGINE_HOST || "127.0.0.1"}:${Number(env.WEBCHAT_ENGINE_PORT || 3211)}`,
      engine_cdp_port: Number(env.WEBCHAT_ENGINE_CDP_PORT || 9222),
      upload_max_bytes: Math.max(1024, Number(env.WEBCHAT_UPLOAD_MAX_BYTES || 50 * 1024 * 1024)),
      upload_retention_days: Math.max(1, Number(env.WEBCHAT_UPLOAD_RETENTION_DAYS || 2)),
    });
    this.apiToken = env.WEBCHAT_API_TOKEN || "";
    this.journal = null;
    this.engine = null;
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
    this.engine = new Web2ApiEngine({
      baseDir: this.baseDir,
      runtimeDir: this.config.runtime_dir,
      profileDir: this.config.profile_dir,
      headless: this.config.headless,
      journal: this.journal,
      env: this.env,
    });
    this.browser = this.engine;
    this.control = this.engine;
    this.jobs = new JobManager({
      backend: this.engine,
      journal: this.journal,
      runtimeDir: this.config.runtime_dir,
      fileStore: this.fileStore,
    });
    await this.jobs.init();
    this.initialized = true;
    return this;
  }

  assertReady() {
    if (!this.initialized || !this.engine || !this.catalog || !this.fileStore || !this.jobs || !this.journal) {
      throw new Error("gateway_runtime_not_initialized");
    }
  }

  health() {
    this.assertReady();
    const engine = this.engine.snapshot();
    return {
      status: engine.status === "broken" ? "degraded" : "ok",
      service: "webchat-gateway",
      backend: "chatgpt-web2api",
      pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
      engine,
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
    return this.startEngine();
  }

  async startEngine() {
    this.assertReady();
    const health = await this.engine.start();
    await this.#captureEngineState(health);
    this.journal.record("web2api_engine_started", { status: health?.status || null, account: this.account() });
    return { ...health, account: this.account() };
  }

  async ready() {
    this.assertReady();
    try {
      const engine = await this.engine.health();
      await this.#captureEngineState(engine);
      return {
        ready: engine.driver_connected === true,
        status: engine.driver_connected === true ? "ready" : "auth_required",
        engine,
        persistent_account: this.account(),
      };
    } catch (error) {
      return {
        ready: false,
        status: error.code === "ENGINE_AUTH_REQUIRED" ? "auth_required" : "engine_unavailable",
        error: error.message,
        code: error.code || null,
        engine: this.engine.snapshot(),
        persistent_account: this.account(),
      };
    }
  }

  async doctor() {
    this.assertReady();
    const state = await this.ready();
    let models = [];
    let projects = [];
    const errors = [];
    if (state.ready) {
      try { models = await this.engine.listModels(); } catch (error) { errors.push({ check: "models", error: error.message, code: error.code || null }); }
      try { projects = await this.engine.listProjects(); } catch (error) { errors.push({ check: "projects", error: error.message, code: error.code || null }); }
    }
    return {
      ok: state.ready && errors.length === 0,
      service: "webchat-gateway",
      backend: "chatgpt-web2api",
      engine: state.engine,
      account: this.account(),
      checks: { models: models.length, projects: projects.length },
      errors,
      timestamp: new Date().toISOString(),
    };
  }

  async listModels() {
    this.assertReady();
    const models = await this.engine.listModels();
    return models.map((model) => ({
      id: model.id ?? model.slug,
      object: "model",
      created: 0,
      owned_by: "chatgpt-web",
      title: model.title ?? null,
    })).filter((model) => typeof model.id === "string" && model.id.length > 0);
  }

  async listProjects({ live = false, sync = true } = {}) {
    this.assertReady();
    if (!live) return { source: "catalog", projects: this.catalog.listProjects() };
    const items = await this.engine.listProjects();
    const projects = sync
      ? await this.catalog.syncProjects(items, { source: "chatgpt-web2api" })
      : items;
    return { source: "live", projects, cursor: null, pages: 1, raw_count: items.length };
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
      const live = await this.engine.listProjects();
      await this.catalog.syncProjects(live, { source: "chatgpt-web2api" });
      project = this.catalog.resolveProject(ref);
    } catch (error) {
      this.journal.record("project_live_resolve_failed", { ref: String(ref), error: error.message, code: error.code || null }, "warn");
      throw error;
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
    return this.engine.listConversations({
      projectId,
      all: options.all === true,
      offset: options.offset || 0,
      limit: options.limit || 50,
    });
  }

  async getConversation(id) {
    this.assertReady();
    return this.engine.getConversation(id);
  }

  async listProjectFiles(ref) {
    this.assertReady();
    const project = await this.resolveProject(ref);
    if (!project) {
      const error = new Error(`project not found: ${ref}`);
      error.code = "PROJECT_NOT_FOUND";
      throw error;
    }
    const result = await this.engine.listProjectFiles(project.id);
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
      if (prepared.attachments.length) throw unsupported(
        "message attachments are staged but the pinned ChatGPT-Web2API engine does not support attaching them to a turn",
        "ENGINE_ATTACHMENTS_UNSUPPORTED",
      );
    }
    if (prepared.reasoning_effort) throw unsupported(
      "reasoning_effort is not implemented by the pinned ChatGPT-Web2API engine",
      "ENGINE_REASONING_EFFORT_UNSUPPORTED",
    );
    return prepared;
  }

  async dom() {
    throw unsupported("DOM debug is disabled: ChatGPT-Web2API owns the browser/CDP runtime");
  }

  async debugSnapshot() {
    this.assertReady();
    const engine = await this.engine.health().catch(() => this.engine.snapshot());
    return {
      service: "webchat-gateway",
      backend: "chatgpt-web2api",
      timestamp: new Date().toISOString(),
      account: this.account(),
      engine,
      catalog: { projects: this.catalog.listProjects().length },
      jobs: this.jobs.stats(),
    };
  }

  events({ limit = 200, jobId = null, level = null } = {}) {
    this.assertReady();
    return this.journal.list({ limit, jobId, level });
  }

  async screenshot() {
    throw unsupported("screenshot debug is disabled: the upstream engine owns Chrome");
  }

  async diagnosticBundle() {
    this.assertReady();
    const dir = join(this.config.runtime_dir, "debug");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `engine-${stamp}.json`);
    const payload = {
      created_at: new Date().toISOString(),
      backend: "chatgpt-web2api",
      engine: await this.engine.health().catch(() => this.engine.snapshot()),
      account: this.account(),
      jobs: this.jobs.stats(),
      recent_events: this.events({ limit: 100 }),
    };
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    this.journal.record("diagnostic_bundle_created", { file });
    return { file, backend: "chatgpt-web2api" };
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
    this.journal.record("engine_restart_requested");
    const state = await this.engine.restart();
    await this.#captureEngineState(state);
    return { ...state, persistent_account: this.account() };
  }

  async createSmokeJob() {
    this.assertReady();
    const id = `diag_${crypto.randomUUID()}`;
    const payload = await this.prepareJobPayload({
      model: "auto",
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
    try { await this.engine?.close?.(); } catch {}
    await this.journal?.flush?.();
  }

  async #loadAccountState() {
    try {
      const parsed = JSON.parse(await readFile(this.accountStateFile, "utf8"));
      if (parsed && typeof parsed === "object") this.accountState = { ...anonymousAccount(), ...parsed };
    } catch {}
  }

  async #captureEngineState(engineState = {}) {
    const next = {
      ...this.accountState,
      authenticated: engineState.driver_connected === true,
      plan: null,
      subscription_active: false,
      classification: engineState.driver_connected === true ? "authenticated" : "unknown",
      confidence: engineState.driver_connected === true ? "engine" : "none",
      evidence: engineState.driver_connected === true ? "chatgpt_web2api_driver_connected" : "engine_not_connected",
      observed_at: new Date().toISOString(),
      source: "chatgpt-web2api",
    };
    this.accountState = next;
    const temp = `${this.accountStateFile}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temp, this.accountStateFile);
  }
}
