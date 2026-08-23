import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createGatewayHttpServer } from "../providers/chatgpt/http-api.mjs";

function fakeRuntime({ token = "" } = {}) {
  const events = [];
  const account = {
    authenticated: true,
    plan: "free",
    subscription_active: false,
    classification: "free",
    confidence: "inferred",
    evidence: "authenticated_without_paid_plan_marker",
    observed_at: "2026-08-21T18:00:00.000Z",
    source: "persistent_detector",
  };
  const jobs = {
    stats: () => ({ running: null, queued: 0, total: 0, counts: {} }),
    list: () => [],
    get: () => null,
    create: async (payload) => ({
      job: { id: "job_test", status: "queued", model: payload.model || "chatgpt-web" },
      reused: false,
    }),
  };
  return {
    apiToken: token,
    config: {
      host: "127.0.0.1",
      port: 0,
      cors_origin: null,
      backend: "chatgpt-web2api",
      browser_start_disabled: true,
    },
    jobs,
    journal: { record: (...args) => events.push(args) },
    assertReady() {},
    health: () => ({ status: "ok", service: "webchat-gateway", browser: { running: false, page_ready: false }, account, jobs: jobs.stats(), port: 0 }),
    account: () => ({ ...account }),
    prepareJobPayload: async (payload) => ({ ...payload }),
    ready: async () => ({ ready: false, status: "degraded" }),
    debugSnapshot: async () => ({ service: "webchat-gateway", account, browser: { network_complete: false }, jobs: jobs.stats() }),
    doctor: async () => ({ ok: false, status: "degraded", account }),
    dom: async () => ({ url: null }),
    events: () => [],
  };
}

async function withServer(runtime, fn) {
  const server = createGatewayHttpServer(runtime);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("health remains operational without auth or browser", async () => {
  await withServer(fakeRuntime({ token: "secret" }), async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.service, "webchat-gateway");
    assert.equal(body.browser.running, false);
    assert.equal(body.account.plan, "free");
  });
});

test("persisted account endpoint is protected and exposes plan truth", async () => {
  await withServer(fakeRuntime({ token: "secret" }), async (base) => {
    assert.equal((await fetch(`${base}/v1/account`)).status, 401);

    const response = await fetch(`${base}/v1/account`, {
      headers: { Authorization: "Bearer secret" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.account.authenticated, true);
    assert.equal(body.account.plan, "free");
    assert.equal(body.account.subscription_active, false);
  });
});

test("job submission carries account source-of-truth context", async () => {
  await withServer(fakeRuntime(), async (base) => {
    const response = await fetch(`${base}/v1/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web", messages: [{ role: "user", content: "qual meu plano?" }] }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.account.plan, "free");
    assert.equal(body.account.subscription_active, false);
  });
});

test("debug runtime is API-only and protected by bearer token", async () => {
  await withServer(fakeRuntime({ token: "secret" }), async (base) => {
    const denied = await fetch(`${base}/v1/debug/runtime`);
    assert.equal(denied.status, 401);

    const response = await fetch(`${base}/v1/debug/runtime`, {
      headers: { Authorization: "Bearer secret" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.service, "webchat-gateway");
    assert.equal(body.browser.network_complete, false);
  });
});

test("unknown routes do not require any web UI adapter", async () => {
  await withServer(fakeRuntime(), async (base) => {
    const response = await fetch(`${base}/does-not-exist`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error, "not_found");
  });
});
