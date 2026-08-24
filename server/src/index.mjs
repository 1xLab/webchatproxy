import { join } from 'node:path';
import { ProviderRegistry } from './core/provider-registry.mjs';
import { JobManager } from './core/job-manager.mjs';
import { HttpProviderAdapter } from './core/http-provider-adapter.mjs';
import { createHttpServer } from './http/server.mjs';

const runtimeDir = process.env.WEBCHAT_RUNTIME_DIR || join(process.cwd(), 'runtime');
const registry = new ProviderRegistry();

const specs = [
  ['chatgpt', process.env.CHATGPT_API_URL || 'http://127.0.0.1:3210', Number(process.env.CHATGPT_CONCURRENCY || 1), process.env.WEBCHAT_API_TOKEN || ''],
  ['deepseek', process.env.DEEPSEEK_API_URL || 'http://127.0.0.1:3220', Number(process.env.DEEPSEEK_CONCURRENCY || 2), null],
  ['kimi', process.env.KIMI_API_URL || 'http://127.0.0.1:3230', Number(process.env.KIMI_CONCURRENCY || 2), null],
  ['antigravity', process.env.ANTIGRAVITY_API_URL || 'http://127.0.0.1:3240', Number(process.env.ANTIGRAVITY_CONCURRENCY || 2), null],
];

for (const [id, baseUrl, concurrency, staticToken] of specs) {
  registry.register(new HttpProviderAdapter({ id, baseUrl, concurrency, runtimeDir, staticToken }));
}

const jobs = await new JobManager({ registry, runtimeDir }).init();
const server = createHttpServer({ registry, jobs, token: process.env.WEBCHAT_UNIVERSAL_API_TOKEN || '' });
const host = process.env.WEBCHAT_HOST || '127.0.0.1';
const port = Number(process.env.WEBCHAT_PORT || 3200);
server.listen(port, host, () => console.log(`webchatproxy universal gateway listening on http://${host}:${port}`));
