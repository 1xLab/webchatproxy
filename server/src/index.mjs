import { join } from 'node:path';
import { ProviderRegistry } from './core/provider-registry.mjs';
import { JobManager } from './core/job-manager.mjs';
import { UsageStore } from './core/usage-store.mjs';
import { HttpProviderAdapter } from './core/http-provider-adapter.mjs';
import { createHttpServer } from './http/server.mjs';

const runtimeDir = process.env.WEBCHAT_RUNTIME_DIR || join(process.cwd(), 'runtime');
const registry = new ProviderRegistry();
const host = process.env.WEBCHAT_HOST || '127.0.0.1';

const specs = [
  {
    id: 'chatgpt',
    upstream: process.env.CHATGPT_UPSTREAM_URL || 'http://127.0.0.1:3310',
    concurrency: Number(process.env.CHATGPT_CONCURRENCY || 1),
    token: process.env.CHATGPT_UPSTREAM_TOKEN || null,
    tokenFile: process.env.CHATGPT_UPSTREAM_TOKEN_FILE || null,
    facadePort: Number(process.env.CHATGPT_PORT || 3210),
  },
  {
    id: 'deepseek',
    upstream: process.env.DEEPSEEK_UPSTREAM_URL || 'http://127.0.0.1:3320',
    concurrency: Number(process.env.DEEPSEEK_CONCURRENCY || 2),
    token: process.env.DEEPSEEK_UPSTREAM_TOKEN || null,
    tokenFile: process.env.DEEPSEEK_UPSTREAM_TOKEN_FILE || null,
    facadePort: Number(process.env.DEEPSEEK_PORT || 3220),
  },
  {
    id: 'kimi',
    upstream: process.env.KIMI_UPSTREAM_URL || 'http://127.0.0.1:3330',
    concurrency: Number(process.env.KIMI_CONCURRENCY || 2),
    token: process.env.KIMI_UPSTREAM_TOKEN || null,
    tokenFile: process.env.KIMI_UPSTREAM_TOKEN_FILE || 'kimi/.api-key',
    facadePort: Number(process.env.KIMI_PORT || 3230),
  },
  {
    id: 'antigravity',
    upstream: process.env.ANTIGRAVITY_UPSTREAM_URL || 'http://127.0.0.1:3340',
    concurrency: Number(process.env.ANTIGRAVITY_CONCURRENCY || 2),
    token: process.env.ANTIGRAVITY_UPSTREAM_TOKEN || null,
    tokenFile: process.env.ANTIGRAVITY_UPSTREAM_TOKEN_FILE || 'antigravity-pool/.api-key',
    facadePort: Number(process.env.ANTIGRAVITY_PORT || 3240),
  },
];

for (const spec of specs) {
  registry.register(new HttpProviderAdapter({
    id: spec.id,
    baseUrl: spec.upstream,
    concurrency: spec.concurrency,
    runtimeDir,
    staticToken: spec.token,
    tokenFile: spec.tokenFile,
  }));
}

const usage = await new UsageStore({ runtimeDir }).init();
const jobs = await new JobManager({ registry, runtimeDir, usageStore: usage }).init();
const publicToken = process.env.WEBCHAT_UNIVERSAL_API_TOKEN || '';
const universalPort = Number(process.env.WEBCHAT_PORT || 3200);
const servers = [];

function listen(port, fixedProvider = null) {
  const server = createHttpServer({ registry, jobs, usage, token: publicToken, fixedProvider });
  server.listen(port, host, () => {
    const label = fixedProvider ? `${fixedProvider} facade` : 'universal gateway';
    console.log(`webchatproxy ${label} listening on http://${host}:${port}`);
  });
  servers.push(server);
}

listen(universalPort);
for (const spec of specs) listen(spec.facadePort, spec.id);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`webchatproxy shutting down (${signal})`);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
}
process.on('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
process.on('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
