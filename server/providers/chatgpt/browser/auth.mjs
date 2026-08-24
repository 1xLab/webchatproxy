import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const profileDir = process.env.WEBCHAT_PROFILE_DIR || join(process.cwd(), "browser-profile");
const targetUrl = process.env.WEBCHAT_AUTH_URL || "https://chatgpt.com/";

function resolveChromeBinary() {
  const explicit = String(process.env.WEBCHAT_AUTH_BROWSER_BIN || "").trim();
  if (explicit) return explicit;

  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/google-chrome",
    "/opt/google/chrome/chrome",
  ];
  return candidates.find((path) => existsSync(path)) || null;
}

const browserBin = resolveChromeBinary();

if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.error("BROWSER_AUTH_DISPLAY_REQUIRED");
  console.error("Interactive authentication requires a human-visible DISPLAY/Wayland session.");
  console.error(`profile=${profileDir}`);
  process.exit(3);
}

if (!browserBin) {
  console.error("BROWSER_AUTH_CHROME_NOT_FOUND");
  console.error("Google Chrome is required for the canonical ChatGPT browser profile.");
  console.error("Set WEBCHAT_AUTH_BROWSER_BIN to the absolute Google Chrome executable if it is installed in a non-standard path.");
  process.exit(5);
}

await mkdir(profileDir, { recursive: true });

// Authentication runs in a normal unmanaged Google Chrome process using the
// same persistent user-data directory consumed later by the ChatGPT-Web2API
// Chrome/CDP runtime. This script never owns the normal gateway browser.
const args = [
  `--user-data-dir=${profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-dev-shm-usage",
  "--no-sandbox",
  "--password-store=basic",
  targetUrl,
];

console.log("Starting unmanaged Google Chrome authentication session...");
console.log(`profile=${profileDir}`);
console.log(`browser=${browserBin}`);
console.log(`url=${targetUrl}`);
console.log(`display=${process.env.DISPLAY || process.env.WAYLAND_DISPLAY || "none"}`);
console.log("Use Log in -> Continue with Google and complete Google OAuth manually.");
console.log("Close Chrome manually only after ChatGPT shows the authenticated account/profile.");

const child = spawn(browserBin, args, {
  stdio: "inherit",
  env: process.env,
});

child.once("error", (error) => {
  console.error(`BROWSER_AUTH_LAUNCH_FAILED ${error.message}`);
  process.exitCode = 1;
});

const exit = await new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

if (exit.signal) {
  console.error(`BROWSER_AUTH_BROWSER_EXIT signal=${exit.signal}`);
  process.exit(4);
}
if (exit.code !== 0) {
  console.error(`BROWSER_AUTH_BROWSER_EXIT code=${exit.code}`);
  process.exit(exit.code || 4);
}

console.log("BROWSER_AUTH_BROWSER_CLOSED");
console.log("The Google Chrome profile remains on disk. Start the gateway and run doctor to verify authenticated=true.");
