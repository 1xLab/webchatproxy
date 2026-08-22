// Canonical standalone entrypoint for server deployments.
// The ChatGPT-Web2API Python/CDP engine owns Chrome in normal runtime.
// Playwright remains only as an operational authentication utility.

if (process.env.WEBCHAT_HEADLESS === undefined && process.env.REMOTE_IA_HEADLESS === undefined) {
  process.env.WEBCHAT_HEADLESS = "0";
}

await import("./standalone.mjs");
