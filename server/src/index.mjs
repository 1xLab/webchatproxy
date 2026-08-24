import { join } from 'node:path';
import { ProviderRegistry } from './core/provider-registry.mjs';
import { JobManager } from './core/job-manager.mjs';
import { HttpProviderAdapter } from './core/http-provider-adapter.mjs';
import { createHttpServer } from './http/server.mjs';

const runtimeDir = process.env.WEBCHAT_RUNTIME_DIR || join(process.cwd(), 'runtime');
const registry = new ProviderRegistry();
const host = process.env.WEBCHAT_HOST || '127.0.0.1';

const specs = [
  ['chatgpt', process.env.CHATGPT_UPSTREAM_URL || 'http://127.0.0.1:3310', Number(process.env.CHATGPT_CONCURRENCY || 1), process.env.CHATGPT_UPSTREAM_TOKEN || process.env.WEBCHAT_API_TOKEN || '', Number(process.env.CHATGPT_PORT || 3210)],
  ['deepseek', process.env.DEEPSEEK_UPSTREAM_URL || 'http://127.0.0.1:3320', Number(process.env.DEEPSEEK_CONCURRENCY || 2), process.env.DEEPSEEK_UPSTREAM_TOKEN || null, Number(process.env.DEEPSEEK_PORT || 3220)],
  ['kimi', process.env.KIMI_UPSTREAM_URL || 'http://127.0.0.1:3330', Number(process.env.KIMI_CONCURRENCY || 2), process.env.KIMI_UPSTREAM_TOKEN || null, Number(process.env.KIMI_PORT || 3230)],
  ['antigravity', process.env.ANTIGRAVITY_UPSTREAM_URL || 'http://127.0.0.1:3340', Number(process.env.ANTIGRAVITY_CONCURRENCY || 2), process.env.ANTIGRAVITY_UPSTREAM_TOKEN || null, Number(process.env.ANTIGRAVITY_PORT || 3240)],
];

for (const [id, baseUrl, concurrency, staticToken] of specs) {
  registry.register(new HttpProviderAdapter({ id, baseUrl, concurrency, runtimeDir, staticToken }));
}

const jobs = await new JobManager({ registry, runtimeDir }).init();
const publicToken = process.env.WEBCHAT_UNIVERSAL_API_TOKEN || '';
const universalPort = Number(process.env.WEBCHAT_PORT || 3200);

createHttpServer({ registry, jobs, token: publicToken }).listen(universalPort, host, () => {
  console.log(`webchatproxy universal gateway listening on http://${host}:${universalPort}`);
});

for (const [provider,,,, facadePort] of specs) {
  createHttpServer({ registry, jobs, token: publicToken, fixedProvider: provider }).listen(facadePort, host, () => {
    console.log(`webchatproxy ${provider} shortcut listening on http://${host}:${facadePort}`);
  });
}
