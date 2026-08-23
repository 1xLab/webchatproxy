// Canonical standalone entrypoint for server deployments.
// Provider-specific runtime code lives under providers/chatgpt/.
// ChatGPT-Web2API owns Chrome/CDP; browser/auth.mjs is human login maintenance only.

if (process.env.WEBCHAT_HEADLESS === undefined && process.env.REMOTE_IA_HEADLESS === undefined) {
  process.env.WEBCHAT_HEADLESS = "0";
}

await import("./standalone.mjs");
