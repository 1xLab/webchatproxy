import test from "node:test";
import assert from "node:assert/strict";

import { classifyAccountState, detectAuthenticatedSession, inspectBrowser, doctorReport } from "../lib/diagnostics.mjs";

function backendWithState(state) {
  const page = {
    evaluate: async () => ({ ...state }),
    waitForLoadState: async () => {},
    url: () => state.url || "https://chatgpt.com/",
  };
  return {
    context: {},
    page,
    profileDir: "/tmp/browser-profile",
    health: () => ({ enabled: true, running: true, page: page.url() }),
  };
}

test("profile control is required for authenticated session", () => {
  assert.equal(detectAuthenticatedSession({ profile_present: true, login_present: false }), true);
  assert.equal(detectAuthenticatedSession({ profile_present: false, login_present: false }), false);
  assert.equal(detectAuthenticatedSession({ profile_present: true, login_present: true }), false);
});

test("authenticated account without paid marker is classified as free", () => {
  const account = classifyAccountState({
    profile_present: true,
    profile_aria_label: "Benjamin Rivera, open profile menu",
    login_present: false,
  });

  assert.equal(account.authenticated, true);
  assert.equal(account.plan, "free");
  assert.equal(account.subscription_active, false);
  assert.equal(account.classification, "free");
});

test("paid plan is classified from profile control", () => {
  const account = classifyAccountState({
    profile_present: true,
    profile_aria_label: "Benjamin Rivera Plus, open profile menu",
    login_present: false,
  });

  assert.equal(account.authenticated, true);
  assert.equal(account.plan, "plus");
  assert.equal(account.subscription_active, true);
  assert.equal(account.classification, "paid");
  assert.equal(account.evidence, "profile_label");
});

test("inspectBrowser classifies Cloudflare challenge explicitly", async () => {
  const backend = backendWithState({
    url: "https://chatgpt.com/",
    title: "Just a moment...",
    body_preview: "Checking your browser before accessing chatgpt.com Cloudflare",
    composer_present: false,
    composer_visible: false,
    profile_present: false,
    login_present: false,
    assistant_count: 0,
    user_count: 0,
    streaming: false,
    latest_assistant_preview: "",
  });

  const result = await inspectBrowser(backend);

  assert.equal(result.status, "external_challenge");
  assert.equal(result.ready, false);
  assert.equal(result.authenticated, false);
  assert.equal(result.auth_required, false);
  assert.equal(result.external_challenge, true);
  assert.equal(result.provider, "cloudflare");
  assert.equal(result.challenge_reason, "browser_challenge");
});

test("doctorReport exposes external challenge instead of generic degraded/auth", async () => {
  const backend = backendWithState({
    url: "https://chatgpt.com/",
    title: "Just a moment...",
    body_preview: "Verify you are human",
    composer_present: false,
    composer_visible: false,
    profile_present: false,
    login_present: false,
    assistant_count: 0,
    user_count: 0,
    streaming: false,
    latest_assistant_preview: "",
  });
  const jobs = { stats: () => ({ running: null, queued: 0, total: 0, counts: {} }) };
  const journal = { list: () => [] };

  const report = await doctorReport({ backend, jobs, journal, config: {} });

  assert.equal(report.ok, false);
  assert.equal(report.status, "external_challenge");
  assert.equal(report.browser.provider, "cloudflare");
  assert.equal(report.browser.auth_required, false);
  const challengeCheck = report.checks.find((check) => check.name === "external_challenge");
  assert.deepEqual(challengeCheck, {
    name: "external_challenge",
    ok: false,
    detail: "cloudflare:browser_challenge",
  });
});

test("authenticated ChatGPT page is ready only with profile control", async () => {
  const backend = backendWithState({
    url: "https://chatgpt.com/",
    title: "ChatGPT",
    body_preview: "",
    composer_present: true,
    composer_visible: true,
    profile_present: true,
    profile_aria_label: "Benjamin Rivera Plus, open profile menu",
    login_present: false,
    assistant_count: 0,
    user_count: 0,
    streaming: false,
    latest_assistant_preview: "",
  });

  const result = await inspectBrowser(backend);

  assert.equal(result.status, "ready");
  assert.equal(result.ready, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.auth_required, false);
  assert.equal(result.external_challenge, false);
  assert.equal(result.plan, "plus");
  assert.equal(result.subscription_active, true);
});

test("anonymous ChatGPT page with login pane requires authentication even with composer", async () => {
  const backend = backendWithState({
    url: "https://chatgpt.com/",
    title: "ChatGPT",
    body_preview: "Get responses tailored to you Log in to get answers based on saved chats",
    composer_present: true,
    composer_visible: true,
    profile_present: false,
    profile_aria_label: null,
    login_present: true,
    assistant_count: 0,
    user_count: 0,
    streaming: false,
    latest_assistant_preview: "",
  });

  const result = await inspectBrowser(backend);

  assert.equal(result.status, "auth_required");
  assert.equal(result.ready, false);
  assert.equal(result.authenticated, false);
  assert.equal(result.auth_required, true);
  assert.equal(result.account.plan, null);
});

test("inspectBrowser retries transient navigation destruction and uses settled page", async () => {
  let calls = 0;
  const page = {
    waitForLoadState: async () => {},
    url: () => "https://chatgpt.com/",
    evaluate: async () => {
      calls += 1;
      if (calls === 1) throw new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation");
      return {
        url: "https://chatgpt.com/",
        title: "ChatGPT",
        body_preview: "",
        composer_present: true,
        composer_visible: true,
        profile_present: true,
        profile_aria_label: "User Plus, open profile menu",
        login_present: false,
        assistant_count: 0,
        user_count: 0,
        streaming: false,
        latest_assistant_preview: "",
      };
    },
  };
  const backend = {
    context: {},
    page,
    profileDir: "/tmp/browser-profile",
    health: () => ({ enabled: true, running: true, page: page.url() }),
  };

  const result = await inspectBrowser(backend);

  assert.equal(calls, 2);
  assert.equal(result.status, "ready");
  assert.equal(result.inspection_attempts, 2);
});

test("inspectBrowser classifies Cloudflare from URL even when navigation keeps destroying context", async () => {
  const page = {
    waitForLoadState: async () => {},
    url: () => "https://chatgpt.com/?__cf_chl_rt_tk=test-token",
    evaluate: async () => {
      throw new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation");
    },
  };
  const backend = {
    context: {},
    page,
    profileDir: "/tmp/browser-profile",
    health: () => ({ enabled: true, running: true, page: page.url() }),
  };

  const result = await inspectBrowser(backend);

  assert.equal(result.status, "external_challenge");
  assert.equal(result.external_challenge, true);
  assert.equal(result.provider, "cloudflare");
  assert.equal(result.inspection_race, true);
  assert.match(result.inspection_error, /Execution context was destroyed/);
});