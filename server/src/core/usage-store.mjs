import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function n(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function normalizeUsage(usage = {}) {
  const input = n(usage.prompt_tokens ?? usage.input_tokens ?? usage.input);
  const output = n(usage.completion_tokens ?? usage.output_tokens ?? usage.output);
  const cached = n(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens);
  const reasoning = n(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens);
  const total = n(usage.total_tokens ?? usage.total) || input + output;
  return { input_tokens: input, output_tokens: output, total_tokens: total, cached_input_tokens: cached, reasoning_tokens: reasoning };
}

function sum(target, event) {
  target.requests += 1;
  target.completed += event.status === 'completed' ? 1 : 0;
  target.failed += event.status === 'failed' ? 1 : 0;
  target.cancelled += event.status === 'cancelled' ? 1 : 0;
  target.interrupted += event.status === 'interrupted' ? 1 : 0;
  target.metered_requests += event.measurement?.source && event.measurement.source !== 'unavailable' ? 1 : 0;
  target.exact_requests += event.measurement?.source === 'provider_reported' ? 1 : 0;
  target.estimated_requests += event.measurement?.estimated === true ? 1 : 0;
  target.input_tokens += event.tokens.input_tokens;
  target.output_tokens += event.tokens.output_tokens;
  target.total_tokens += event.tokens.total_tokens;
  target.cached_input_tokens += event.tokens.cached_input_tokens;
  target.reasoning_tokens += event.tokens.reasoning_tokens;
  target.duration_ms += event.duration_ms || 0;
  if (event.cost?.estimated != null) { target.priced_requests += 1; target.estimated_cost += event.cost.estimated; }
  return target;
}

function emptyTotals() {
  return { requests:0, completed:0, failed:0, cancelled:0, interrupted:0, metered_requests:0, exact_requests:0, estimated_requests:0, input_tokens:0, output_tokens:0, total_tokens:0, cached_input_tokens:0, reasoning_tokens:0, duration_ms:0, priced_requests:0, estimated_cost:0 };
}

export class UsageStore {
  constructor({ runtimeDir }) {
    this.dir = join(runtimeDir, 'usage');
    this.ledgerFile = join(this.dir, 'events.jsonl');
    this.pricingFile = join(this.dir, 'pricing.json');
    this.events = [];
    this.jobIds = new Set();
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    const text = await readFile(this.ledgerFile, 'utf8').catch(() => '');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const event = JSON.parse(line); if (!event?.job_id || this.jobIds.has(event.job_id)) continue; this.events.push(event); this.jobIds.add(event.job_id); } catch {}
    }
    return this;
  }

  async #pricing(provider, model) {
    const pricing = await readFile(this.pricingFile, 'utf8').then(JSON.parse).catch(() => ({}));
    return pricing?.[`${provider}:${model}`] ?? pricing?.[`${provider}:*`] ?? null;
  }

  async #estimate(provider, model, tokens, measurement) {
    if (!measurement?.source || measurement.source === 'unavailable') return { estimated:null, currency:null, pricing_key:null };
    const price = await this.#pricing(provider, model);
    if (!price) return { estimated:null, currency:null, pricing_key:null };
    const inputRate = Number(price.input_per_million ?? 0);
    const outputRate = Number(price.output_per_million ?? 0);
    const cachedRate = Number(price.cached_input_per_million ?? inputRate);
    const uncached = Math.max(0, tokens.input_tokens - tokens.cached_input_tokens);
    const estimated = (uncached * inputRate + tokens.cached_input_tokens * cachedRate + tokens.output_tokens * outputRate) / 1_000_000;
    return { estimated, currency:price.currency || 'USD', pricing_key:price.key || `${provider}:${model}`, based_on_estimated_tokens:measurement.estimated === true };
  }

  async recordJob(job) {
    if (!job?.id || this.jobIds.has(job.id)) return null;
    const tokens = normalizeUsage(job.usage || {});
    const measurement = job.usage_measurement || { source:tokens.total_tokens > 0 ? 'provider_reported' : 'unavailable', quality:tokens.total_tokens > 0 ? 'exact' : 'unknown', estimated:false };
    const cost = await this.#estimate(job.provider, job.model, tokens, measurement);
    const started = job.started_at ? new Date(job.started_at).getTime() : null;
    const finished = job.finished_at ? new Date(job.finished_at).getTime() : null;
    const event = {
      event_id:`usage_${job.id}`, job_id:job.id, provider:job.provider, model:job.model || null, conversation_id:job.conversation_id || null, status:job.status,
      measurement, tokens, cost, duration_ms:started != null && finished != null ? Math.max(0, finished - started) : 0,
      created_at:job.created_at, started_at:job.started_at, finished_at:job.finished_at, recorded_at:new Date().toISOString(),
    };
    this.jobIds.add(job.id); this.events.push(event);
    this.writeChain = this.writeChain.then(() => appendFile(this.ledgerFile, `${JSON.stringify(event)}\n`, 'utf8'));
    await this.writeChain;
    return event;
  }

  query({ provider=null, model=null, conversationId=null, jobId=null, from=null, to=null, limit=1000 } = {}) {
    const fromTs = from ? new Date(from).getTime() : null; const toTs = to ? new Date(to).getTime() : null;
    return this.events.filter((event) => {
      if (provider && event.provider !== provider) return false;
      if (model && event.model !== model) return false;
      if (conversationId && event.conversation_id !== conversationId) return false;
      if (jobId && event.job_id !== jobId) return false;
      const ts = new Date(event.finished_at || event.recorded_at).getTime();
      if (fromTs != null && ts < fromTs) return false; if (toTs != null && ts > toTs) return false; return true;
    }).slice(-Math.max(1, Number(limit) || 1000));
  }

  summary(filters = {}) {
    const events = this.query({ ...filters, limit:Number.MAX_SAFE_INTEGER });
    const totals = emptyTotals(); const byProvider = {}; const byModel = {}; const byConversation = {};
    for (const event of events) {
      sum(totals,event);
      const providerKey=event.provider || 'unknown'; const modelKey=`${providerKey}:${event.model || 'unknown'}`; const conversationKey=event.conversation_id || 'none';
      byProvider[providerKey] ??= emptyTotals(); byModel[modelKey] ??= emptyTotals(); byConversation[conversationKey] ??= emptyTotals();
      sum(byProvider[providerKey],event); sum(byModel[modelKey],event); sum(byConversation[conversationKey],event);
    }
    return { totals, by_provider:byProvider, by_model:byModel, by_conversation:byConversation, events:events.length };
  }
}
