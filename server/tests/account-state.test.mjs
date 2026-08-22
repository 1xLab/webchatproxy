import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayRuntime } from "../lib/gateway-runtime.mjs";

test("persisted account state survives gateway restart and informs jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "webchat-account-"));
  const runtimeDir = join(root, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "account-state.json"), `${JSON.stringify({
    authenticated: true,
    plan: "free",
    subscription_active: false,
    classification: "free",
    confidence: "inferred",
    evidence: "authenticated_without_paid_plan_marker",
    observed_at: "2026-08-21T18:00:00.000Z",
    source: "persistent_detector",
    browser_status: "ready",
  }, null, 2)}\n`, "utf8");

  const runtime = new GatewayRuntime({
    baseDir: root,
    env: {
      WEBCHAT_RUNTIME_DIR: runtimeDir,
      WEBCHAT_PROFILE_DIR: join(root, "browser-profile"),
      WEBCHAT_DISABLE_BROWSER_START: "1",
    },
  });

  try {
    await runtime.init();
    assert.equal(runtime.account().authenticated, true);
    assert.equal(runtime.account().plan, "free");
    assert.equal(runtime.account().subscription_active, false);

    const payload = await runtime.prepareJobPayload({
      model: "chatgpt-web",
      messages: [{ role: "user", content: "qual meu plano?" }],
    });
    assert.equal(payload.messages[0].role, "system");
    assert.match(payload.messages[0].content, /plan=free/);
    assert.match(payload.messages[0].content, /subscription_active=false/);
    assert.equal(payload.messages[1].content, "qual meu plano?");
  } finally {
    await runtime.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});