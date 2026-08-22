import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const COMPOSER = "#prompt-textarea";
const STOP = '[data-testid="stop-button"], button[aria-label*="Stop" i]';
const PROFILE = '[data-testid="accounts-profile-button"], [aria-label*="open profile menu" i]';
const NAVIGATION_RACE = /execution context was destroyed|most likely because of a navigation|cannot find context with specified id/i;
const AUTH_ACTION_LABELS = [
  "log in",
  "sign in",
  "sign up",
  "register",
  "register for free",
  "iniciar sesion",
  "registrate gratis",
  "registrarse",
  "crear cuenta",
  "entrar",
  "iniciar sessao",
  "cadastre-se",
  "cadastrar-se",
  "criar conta",
  "se connecter",
  "s'inscrire",
  "anmelden",
  "registrieren",
  "accedi",
  "registrati",
  "inloggen",
  "aanmelden",
];
const AUTH_TITLE = /log in|sign in|sign up|iniciar sesi[oó]n|iniciar sess[aã]o|entrar|se connecter|anmelden|accedi|inloggen/i;
const PAID_PLANS = [
  ["enterprise", /\benterprise\b/i],
  ["business", /\bbusiness\b/i],
  ["team", /\bteam\b/i],
  ["pro", /\bpro\b/i],
  ["plus", /\bplus\b/i],
  ["go", /\bgo\b/i],
  ["edu", /\bedu\b/i],
];

function normalizeUiText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isAuthenticationActionLabel(value = "") {
  return AUTH_ACTION_LABELS.includes(normalizeUiText(value));
}

function detectExternalChallenge(state) {
  const url = String(state?.url || "");
  const title = String(state?.title || "");
  const bodyText = String(state?.body_preview || "");
  const combined = `${url}\n${title}\n${bodyText}`;
  const cloudflare = /__cf_chl_|cf_chl_|just a moment|attention required|verify you are human|checking your browser|cloudflare/i.test(combined);
  if (!cloudflare) return null;
  return { provider: "cloudflare", reason: "browser_challenge" };
}

export function detectAuthenticatedSession(state = {}) {
  return state.profile_present === true
    && state.login_present !== true
    && state.auth_cta_present !== true;
}

export function classifyAccountState(state = {}) {
  const authenticated = detectAuthenticatedSession(state);
  if (!authenticated) {
    let evidence = "profile_control_missing";
    if (state.login_present === true) evidence = "login_control_present";
    else if (state.auth_cta_present === true) evidence = "auth_cta_present";

    return {
      authenticated: false,
      plan: null,
      subscription_active: false,
      classification: "anonymous",
      confidence: "high",
      evidence,
    };
  }

  // The classifier intentionally trusts only the account/profile control.
  // Chat body text is user/model content and must never become plan evidence.
  const profileLabel = String(state.profile_aria_label || "").trim();
  const detected = PAID_PLANS.find(([, pattern]) => pattern.test(profileLabel));

  if (detected) {
    return {
      authenticated: true,
      plan: detected[0],
      subscription_active: true,
      classification: "paid",
      confidence: "high",
      evidence: "profile_label",
    };
  }

  return {
    authenticated: true,
    plan: "free",
    subscription_active: false,
    classification: "free",
    confidence: "inferred",
    evidence: "authenticated_without_paid_plan_marker",
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluatePageState(page, { attempts = 5, retryDelayMs = 250 } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.waitForLoadState?.("domcontentloaded", { timeout: 1000 }).catch(() => {});
      const state = await page.evaluate(({ composerSelector, stopSelector, profileSelector, authActionLabels }) => {
        const normalizeActionText = (value = "") => String(value)
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        const authLabels = new Set(authActionLabels);
        const isVisible = (element) => {
          const rect = element?.getBoundingClientRect?.();
          if (!rect || rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle?.(element);
          return !style || (style.display !== "none" && style.visibility !== "hidden");
        };
        const isAuthControl = (element) => {
          if (!isVisible(element)) return false;
          const text = normalizeActionText(element.textContent || element.getAttribute?.("aria-label") || "");
          const href = String(element.getAttribute?.("href") || "");
          return authLabels.has(text)
            || /\/auth\/(?:login|signup)(?:[/?#]|$)|\/(?:login|signup)(?:[/?#]|$)/i.test(href);
        };

        const composer = document.querySelector(composerSelector);
        const rect = composer?.getBoundingClientRect?.();
        const visible = !!composer && !!rect && rect.width > 0 && rect.height > 0;
        const profile = document.querySelector(profileSelector);
        const authControl = [...document.querySelectorAll("button, a")].find(isAuthControl) || null;
        const authCtaPresent = !!authControl;
        const assistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
        const userCount = document.querySelectorAll('[data-message-author-role="user"]').length;
        const latestAssistant = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
          .at(-1)?.textContent?.replace(/[\u200B-\u200D\uFEFF]/g, "").trim().slice(0, 1200) || "";
        return {
          url: location.href,
          title: document.title,
          body_preview: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1200),
          composer_present: !!composer,
          composer_visible: visible,
          profile_present: !!profile,
          profile_aria_label: profile?.getAttribute?.("aria-label") || null,
          login_present: authCtaPresent,
          auth_cta_present: authCtaPresent,
          auth_cta_text: authControl ? (authControl.textContent || authControl.getAttribute?.("aria-label") || "").trim() : null,
          assistant_count: assistantCount,
          user_count: userCount,
          streaming: !!document.querySelector(stopSelector),
          latest_assistant_preview: latestAssistant,
        };
      }, {
        composerSelector: COMPOSER,
        stopSelector: STOP,
        profileSelector: PROFILE,
        authActionLabels: AUTH_ACTION_LABELS,
      });

      const currentUrl = page.url?.() || state.url || "";
      return { ...state, url: currentUrl, inspection_attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!NAVIGATION_RACE.test(String(error?.message || error)) || attempt === attempts) break;
      await delay(retryDelayMs);
    }
  }

  const currentUrl = page.url?.() || "";
  const challenge = detectExternalChallenge({ url: currentUrl });
  if (challenge && NAVIGATION_RACE.test(String(lastError?.message || lastError))) {
    return {
      url: currentUrl,
      title: "",
      body_preview: "",
      composer_present: false,
      composer_visible: false,
      profile_present: false,
      profile_aria_label: null,
      login_present: false,
      auth_cta_present: false,
      auth_cta_text: null,
      assistant_count: 0,
      user_count: 0,
      streaming: false,
      latest_assistant_preview: "",
      inspection_race: true,
      inspection_error: lastError.message,
    };
  }

  throw lastError;
}

export async function inspectBrowser(backend) {
  const base = backend?.health?.() || { enabled: false, running: false, page: null };
  if (!backend?.page || !backend?.context) {
    return {
      status: "browser_not_running",
      ...base,
      ready: false,
      authenticated: false,
      auth_required: false,
      external_challenge: false,
      account: classifyAccountState({}),
    };
  }

  const page = backend.page;
  try {
    const state = await evaluatePageState(page);
    const challenge = detectExternalChallenge(state);
    const account = classifyAccountState(state);
    const authenticated = account.authenticated;
    const explicitLoginPage = /\/auth\/(login|logout)|\/login|\/signup/i.test(state.url)
      || state.login_present === true
      || state.auth_cta_present === true
      || (!state.composer_present && AUTH_TITLE.test(state.title));
    const authRequired = !challenge && (!authenticated || explicitLoginPage);
    const ready = state.composer_present && state.composer_visible && authenticated && !challenge;

    return {
      status: challenge ? "external_challenge" : authRequired ? "auth_required" : ready ? "ready" : "degraded",
      ready,
      authenticated,
      auth_required: authRequired,
      external_challenge: !!challenge,
      provider: challenge?.provider || null,
      challenge_reason: challenge?.reason || null,
      account,
      plan: account.plan,
      subscription_active: account.subscription_active,
      profile: backend.profileDir || null,
      ...state,
    };
  } catch (error) {
    return {
      status: "browser_error",
      ready: false,
      authenticated: false,
      auth_required: false,
      external_challenge: false,
      provider: null,
      profile: backend.profileDir || null,
      page: page.url?.() || null,
      account: classifyAccountState({}),
      plan: null,
      subscription_active: false,
      error: error.message,
    };
  }
}

export async function domSnapshot(backend) {
  if (!backend?.page || !backend?.context) return { ok: false, error: "browser_not_running" };
  try {
    return await backend.page.evaluate(({ authActionLabels }) => {
      const selectors = {
        composer: "#prompt-textarea",
        assistant: '[data-message-author-role="assistant"]',
        user: '[data-message-author-role="user"]',
        stop: '[data-testid="stop-button"], button[aria-label*="Stop" i]',
        copy: '[data-testid="copy-turn-action-button"]',
        profile: '[data-testid="accounts-profile-button"], [aria-label*="open profile menu" i]',
      };
      const normalizeActionText = (value = "") => String(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const authLabels = new Set(authActionLabels);
      const isVisible = (element) => {
        const rect = element?.getBoundingClientRect?.();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle?.(element);
        return !style || (style.display !== "none" && style.visibility !== "hidden");
      };
      const isAuthControl = (element) => {
        if (!isVisible(element)) return false;
        const text = normalizeActionText(element.textContent || element.getAttribute?.("aria-label") || "");
        const href = String(element.getAttribute?.("href") || "");
        return authLabels.has(text)
          || /\/auth\/(?:login|signup)(?:[/?#]|$)|\/(?:login|signup)(?:[/?#]|$)/i.test(href);
      };
      const count = (selector) => document.querySelectorAll(selector).length;
      const latest = (selector) => [...document.querySelectorAll(selector)]
        .at(-1)?.textContent?.replace(/[\u200B-\u200D\uFEFF]/g, "").trim().slice(0, 2000) || "";
      const profile = document.querySelector(selectors.profile);
      const authControl = [...document.querySelectorAll("button, a")].find(isAuthControl) || null;
      const authCtaPresent = !!authControl;
      return {
        ok: true,
        url: location.href,
        title: document.title,
        authenticated: !!profile && !authCtaPresent,
        profile_present: !!profile,
        profile_aria_label: profile?.getAttribute?.("aria-label") || null,
        login_present: authCtaPresent,
        auth_cta_present: authCtaPresent,
        auth_cta_text: authControl ? (authControl.textContent || authControl.getAttribute?.("aria-label") || "").trim() : null,
        counts: {
          composer: count(selectors.composer),
          assistant: count(selectors.assistant),
          user: count(selectors.user),
          stop: count(selectors.stop),
          copy: count(selectors.copy),
          profile: count(selectors.profile),
        },
        latest_user_preview: latest(selectors.user),
        latest_assistant_preview: latest(selectors.assistant),
        ready_state: document.readyState,
      };
    }, { authActionLabels: AUTH_ACTION_LABELS });
  } catch (error) {
    return { ok: false, error: error.message, url: backend.page?.url?.() || null };
  }
}

export async function screenshotBuffer(backend) {
  if (!backend?.page || !backend?.context) throw new Error("browser_not_running");
  return await backend.page.screenshot({ type: "png", fullPage: false });
}

export async function saveDiagnosticBundle(backend, runtimeDir, extra = {}) {
  const dir = join(runtimeDir, "debug");
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString();
  const stamp = timestamp.replace(/[:.]/g, "-");
  const screenshotPath = join(dir, `${stamp}.png`);
  const reportPath = join(dir, `${stamp}.json`);
  const state = await inspectBrowser(backend);
  const dom = await domSnapshot(backend);
  let screenshot = null;

  if (backend?.page && backend?.context) {
    const saved = await backend.page.screenshot({ path: screenshotPath, type: "png", fullPage: false }).then(() => true).catch(() => false);
    if (saved) screenshot = screenshotPath;
  }

  const report = { timestamp, state, dom, screenshot, ...extra };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { ...report, report: reportPath };
}

export async function restartBrowser(backend) {
  if (!backend) throw new Error("browser_backend_missing");
  try { await backend.context?.close?.(); } catch {}
  backend.context = null;
  backend.page = null;
  backend.currentRequestId = null;
  backend.lastNetworkText = "";
  backend.lastThinkingText = "";
  backend.networkComplete = false;
  backend.queue = Promise.resolve();
  await backend.start();
  return await inspectBrowser(backend);
}

export async function doctorReport({ backend, jobs, journal, config }) {
  const browser = await inspectBrowser(backend);
  const checks = [
    { name: "process", ok: true, detail: `pid=${process.pid}` },
    { name: "browser_process", ok: !!backend?.context, detail: browser.status },
    { name: "chatgpt_page", ok: !!browser.url && /chatgpt\.com|chat\.openai\.com/i.test(browser.url), detail: browser.url || "no_page" },
    { name: "external_challenge", ok: browser.external_challenge !== true, detail: browser.external_challenge ? `${browser.provider || "external"}:${browser.challenge_reason || "challenge"}` : "none" },
    { name: "composer", ok: browser.composer_present === true, detail: browser.composer_present ? "present" : "missing" },
    { name: "authenticated", ok: browser.authenticated === true, detail: browser.authenticated ? "profile_control_present" : browser.login_present ? "login_control_present" : browser.auth_cta_present ? "auth_cta_present" : "profile_control_missing" },
    { name: "account_plan", ok: browser.authenticated !== true || !!browser.account?.plan, detail: browser.account?.plan || "anonymous" },
  ];
  const ok = checks.every((check) => check.ok);
  return {
    ok,
    status: browser.external_challenge ? "external_challenge" : browser.auth_required ? "auth_required" : ok ? "ready" : "degraded",
    timestamp: new Date().toISOString(),
    config,
    browser,
    account: browser.account,
    jobs: jobs?.stats?.() || null,
    checks,
    recent_events: journal?.list?.({ limit: 30 }) || [],
  };
}
