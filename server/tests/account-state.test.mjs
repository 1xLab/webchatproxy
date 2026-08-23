import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayRuntime } from "../providers/chatgpt/gateway-runtime.mjs";

test("persisted account state is observable but never injected into ChatGPT prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "webchat-account-"));
  const runtimeDir = join(root, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "account-state.json"), `${JSON.stringify({
    authenticated: true,
    plan: "free",
    subscription_active: false,
    classification: "free",
    confidence: "legacy",
    evidence: "legacy_persisted_state",
    observed_at: "2026-08-21T18:00:00.000Z",
    source: "legacy",
  }, null, 2)}\n`, "utf8");

  const runtime = new GatewayRuntime({
    baseDir: root,
    env: {
      WEBCHAT_RUNTIME_DIR: runtimeDir,
      WEBCHAT_PROFILE_DIR: join(root, "browser-profile"),
      WEBCHAT_ENGINE_AUTOSTART: "0",
    },
  });

  try {
    await runtime.init();
    assert.equal(runtime.account().authenticated, true);
    assert.equal(runtime.account().plan, "free");

    const payload = await runtime.prepareJobPayload({
      model: "auto",
      messages: [{ role: "user", content: "qual meu plano?" }],
    });

    assert.deepEqual(payload.messages, [{ role: "user", content: "qual meu plano?" }]);
    assert.equal(payload.messages.some((message) => message.role === "system"), false);
  } finally {
    await runtime.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
