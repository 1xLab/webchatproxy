// Canonical standalone entrypoint for server deployments.
// Keep Playwright's default Chromium launch path unless an administrator
// explicitly requests a branded/alternate browser channel.
import { chromium } from "playwright";

const explicitChannel = String(process.env.REMOTE_IA_BROWSER_CHANNEL || "").trim();

if (!explicitChannel) {
  const launchPersistentContext = chromium.launchPersistentContext.bind(chromium);
  chromium.launchPersistentContext = (userDataDir, options = {}) => {
    const launchOptions = { ...options };
    // browser-backend historically supplied a fallback channel. On Linux
    // servers that forced channel="chromium", which opts into a different
    // Chromium/headless path than Playwright's stable default. Strip only the
    // implicit channel; explicit REMOTE_IA_BROWSER_CHANNEL remains untouched.
    delete launchOptions.channel;
    return launchPersistentContext(userDataDir, launchOptions);
  };
}

if (process.env.WEBCHAT_HEADLESS === undefined && process.env.REMOTE_IA_HEADLESS === undefined) {
  process.env.WEBCHAT_HEADLESS = "1";
}

await import("./standalone.mjs");
