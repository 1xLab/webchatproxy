import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyAccountState,
  detectAuthenticatedSession,
  inspectBrowser,
  isAuthenticationActionLabel,
} from "../lib/diagnostics.mjs";

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

test("authentication CTA labels are recognized across supported UI languages", () => {
  assert.equal(isAuthenticationActionLabel("Log in"), true);
  assert.equal(isAuthenticationActionLabel("Iniciar sesión"), true);
  assert.equal(isAuthenticationActionLabel("Regístrate gratis"), true);
  assert.equal(isAuthenticationActionLabel("Entrar"), true);
  assert.equal(isAuthenticationActionLabel("Iniciar sessão"), true);
  assert.equal(isAuthenticationActionLabel("Se connecter"), true);
  assert.equal(isAuthenticationActionLabel("Anmelden"), true);
  assert.equal(isAuthenticationActionLabel("Abrir el menú de perfil"), false);
});

test("visible auth CTA overrides generic profile control", () => {
  const state = {
    profile_present: true,
    profile_aria_label: "Abrir el menú de perfil",
    login_present: true,
    auth_cta_present: true,
  };

  assert.equal(detectAuthenticatedSession(state), false);
  const account = classifyAccountState(state);
  assert.equal(account.authenticated, false);
  assert.equal(account.classification, "anonymous");
  assert.equal(account.plan, null);
});

test("Spanish anonymous ChatGPT page is auth_required even when profile control exists", async () => {
  const backend = backendWithState({
    url: "https://chatgpt.com/",
    title: "ChatGPT",
    body_preview: "Obtén respuestas personalizadas para ti Inicia sesión Regístrate gratis",
    composer_present: true,
    composer_visible: true,
    profile_present: true,
    profile_aria_label: "Abrir el menú de perfil",
    login_present: true,
    auth_cta_present: true,
    auth_cta_text: "Iniciar sesión",
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
  assert.equal(result.account.classification, "anonymous");
  assert.equal(result.account.plan, null);
});
