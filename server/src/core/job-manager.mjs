import crypto from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const now = () => new Date().toISOString();

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
}
function hashRequest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
function safeId(value) {
  if (!value) return null;
  const id = String(value).trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error('request_id must match [A-Za-z0-9._:-] and be <= 128 chars');
  return id;
}

export class JobManager {
  constructor({ registry, runtimeDir, usageStore = null }) {
    this.registry = registry;
    this.jobsDir = join(runtimeDir, 'jobs');
    this.usageStore = usageStore;
    this.jobs = new Map();
    this.providerState = new Map();
    this.waiters = new Map();
  }

  async init() {
    await mkdir(this.jobsDir, { recursive: true });
    for (const id of this.registry.ids()) this.providerState.set(id, { running: new Set(), queue: [] });
    for (const file of await readdir(this.jobsDir).catch(() => [])) {
      if (!file.endsWith('.json')) continue;
      try {
        const job = JSON.parse(await readFile(join(this.jobsDir, file), 'utf8'));
        if (!TERMINAL.has(job.status)) {
          job.status = 'interrupted'; job.error = 'Gateway restarted before job completion'; job.updated_at = now(); job.finished_at = job.updated_at;
          await this.#persist(job);
        }
        this.jobs.set(job.id, job);
        if (TERMINAL.has(job.status)) await this.usageStore?.recordJob(job);
      } catch {}
    }
    return this;
  }

  async create(payload, { requestId = null } = {}) {
    const provider = String(payload?.provider || '').trim().toLowerCase();
    const adapter = this.registry.get(provider);
    if (!Array.isArray(payload?.messages) || payload.messages.length === 0) throw new Error('messages must be a non-empty array');
    const id = safeId(requestId || payload.request_id) || `job_${crypto.randomUUID()}`;
    const request = {
      ...payload,
      provider,
      model: payload.model || null,
      messages: payload.messages,
      conversation_id: payload.conversation_id || null,
      timeout: Math.max(1000, Number(payload.timeout) || 240000),
    };
    const request_hash = hashRequest(request);
    const existing = this.jobs.get(id);
    if (existing) {
      if (existing.request_hash !== request_hash) { const e = new Error('request_id_conflict'); e.code = 'REQUEST_ID_CONFLICT'; throw e; }
      return { job: this.public(existing), reused: true };
    }
    const created = now();
    const job = {
      id, provider, model: request.model, request, request_hash, status: 'queued',
      conversation_id: request.conversation_id, result: null, usage: null, error: null,
      created_at: created, updated_at: created, started_at: null, finished_at: null,
    };
    this.jobs.set(id, job);
    this.providerState.get(provider).queue.push(id);
    await this.#persist(job);
    this.#drain(provider, adapter);
    return { job: this.public(job), reused: false };
  }

  list({ limit = 100 } = {}) {
    return [...this.jobs.values()].sort((a,b) => b.created_at.localeCompare(a.created_at)).slice(0, Math.max(1, Number(limit)||100)).map(j => this.public(j));
  }
  get(id) { const job = this.jobs.get(id); return job ? this.public(job) : null; }
  stats() {
    return Object.fromEntries([...this.providerState].map(([id,s]) => [id,{ running:s.running.size, queued:s.queue.length, concurrency:this.registry.get(id).concurrency }]));
  }

  async cancel(id) {
    const job = this.jobs.get(id); if (!job) return null; if (TERMINAL.has(job.status)) return this.public(job);
    const state = this.providerState.get(job.provider);
    if (job.status === 'queued') state.queue = state.queue.filter((x) => x !== id);
    job.status = 'cancelled'; job.updated_at = now(); job.finished_at = job.updated_at;
    job.abortController?.abort(); delete job.abortController;
    await this.#persist(job); await this.usageStore?.recordJob(job); this.#notify(job); return this.public(job);
  }

  async waitFor(id, timeoutMs = 270000) {
    const job = this.jobs.get(id); if (!job) throw new Error('job_not_found'); if (TERMINAL.has(job.status)) return this.public(job);
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('timeout_waiting_for_job')), timeoutMs);
      const list = this.waiters.get(id) || new Set();
      list.add((j) => { clearTimeout(timer); resolve(this.public(j)); }); this.waiters.set(id,list);
    });
  }

  #drain(provider, adapter = this.registry.get(provider)) {
    const state = this.providerState.get(provider);
    while (state.running.size < adapter.concurrency && state.queue.length) {
      const id = state.queue.shift(); const job = this.jobs.get(id); if (!job || job.status !== 'queued') continue;
      state.running.add(id);
      this.#run(job, adapter).finally(() => { state.running.delete(id); this.#drain(provider, adapter); });
    }
  }

  async #run(job, adapter) {
    job.status='running'; job.started_at=now(); job.updated_at=job.started_at; job.abortController=new AbortController(); await this.#persist(job);
    const timer=setTimeout(() => job.abortController.abort(), job.request.timeout);
    try {
      const result=await adapter.chat(job.request,{signal:job.abortController.signal});
      if (job.status === 'cancelled') return;
      job.status='completed'; job.result={content:result.content,finish_reason:result.finish_reason};
      job.conversation_id=result.conversation_id || job.conversation_id; job.model=result.model || job.model; job.usage=result.usage || null;
    } catch (error) {
      if (job.status !== 'cancelled') { job.status='failed'; job.error=error.name === 'AbortError' ? 'job_timeout' : error.message; }
    } finally {
      clearTimeout(timer); delete job.abortController; job.updated_at=now(); job.finished_at=job.updated_at;
      await this.#persist(job);
      if (TERMINAL.has(job.status)) await this.usageStore?.recordJob(job);
      this.#notify(job);
    }
  }

  #notify(job) { const set=this.waiters.get(job.id); if (!set) return; this.waiters.delete(job.id); for (const fn of set) fn(job); }
  async #persist(job) {
    const serial={...job}; delete serial.abortController;
    const target=join(this.jobsDir,`${encodeURIComponent(job.id)}.json`); const temp=`${target}.${process.pid}.tmp`;
    await writeFile(temp,`${JSON.stringify(serial,null,2)}\n`,'utf8'); await rename(temp,target);
  }
  public(job) {
    return { id:job.id, provider:job.provider, model:job.model, status:job.status, conversation_id:job.conversation_id, result:job.result, usage:job.usage, error:job.error, created_at:job.created_at, updated_at:job.updated_at, started_at:job.started_at, finished_at:job.finished_at };
  }
}
