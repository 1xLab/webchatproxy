import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEBCHAT_PORT || process.env.PORT || 3210);
const BASE_URL = process.env.WEBCHAT_GATEWAY_URL || `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.WEBCHAT_API_TOKEN || "";
const LIVE = process.env.WEBCHAT_DOCTOR_LIVE === "1" || process.argv.includes("--live");
const CONTROL = LIVE || process.env.WEBCHAT_DOCTOR_CONTROL === "1" || process.argv.includes("--control");
const CONTRACT_ONLY = process.argv.includes("--contract");
const RUNTIME_DIR = process.env.WEBCHAT_RUNTIME_DIR || join(__dirname, "runtime");

if (CONTRACT_ONLY) {
  console.log(JSON.stringify({
    ok: true,
    mode: "contract",
    gateway_url: BASE_URL,
    default_port: PORT,
    live_smoke: LIVE,
    control_smoke: CONTROL,
  }, null, 2));
  process.exit(0);
}

async function request(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("json")
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => "");
  return { ok: response.ok, status: response.status, body };
}

async function pollJob(id, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(`/v1/jobs/${encodeURIComponent(id)}`);
    if (!response.ok) return response;
    const job = response.body?.job;
    if (["completed", "failed", "cancelled", "interrupted"].includes(job?.status)) return response;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, status: 408, body: { error: "doctor_smoke_timeout", id } };
}

async function createBundle() {
  try {
    return await request("/v1/debug/bundle", { method: "POST" });
  } catch (error) {
    return { ok: false, status: 0, body: { error: error.message } };
  }
}

const report = {
  ok: false,
  timestamp: new Date().toISOString(),
  gateway_url: BASE_URL,
  live_smoke: LIVE,
  control_smoke: CONTROL,
  health: null,
  doctor: null,
  control: null,
  smoke: null,
  artifacts: null,
  error: null,
};

try {
  report.health = await request("/health");
  if (!report.health.ok) throw new Error(`health_failed_${report.health.status}`);

  report.doctor = await request("/v1/debug/doctor");
  if (!report.doctor.ok) {
    report.artifacts = await createBundle();
    throw new Error(report.doctor.body?.status || `doctor_failed_${report.doctor.status}`);
  }

  if ((LIVE || CONTROL) && report.doctor.body?.browser?.authenticated !== true) {
    report.artifacts = await createBundle();
    throw new Error("authentication_required");
  }

  if (CONTROL) {
    const projects = await request("/v1/projects?live=1&sync=0&all=0");
    const conversations = await request("/v1/conversations?limit=1");
    report.control = {
      projects,
      conversations,
      projects_contract: projects.ok && Array.isArray(projects.body?.projects),
      conversations_contract: conversations.ok && Array.isArray(conversations.body?.items),
    };
    if (!report.control.projects_contract || !report.control.conversations_contract) {
      report.artifacts = await createBundle();
      throw new Error("control_plane_validation_failed");
    }
  }

  if (LIVE) {
    const queued = await request("/v1/debug/smoke", { method: "POST" });
    if (!queued.ok) throw new Error(`smoke_queue_failed_${queued.status}`);
    const id = queued.body?.job?.id;
    const finished = await pollJob(id, Number(process.env.WEBCHAT_SMOKE_TIMEOUT || 120000) + 30000);
    const content = finished.body?.job?.result?.content || "";
    report.smoke = {
      queued,
      finished,
      expected: "WEBCHAT_OK",
      matched: /WEBCHAT_OK/.test(content),
    };
    if (!finished.ok || finished.body?.job?.status !== "completed" || !report.smoke.matched) {
      report.artifacts = await createBundle();
      const events = await request(`/v1/jobs/${encodeURIComponent(id)}/events?limit=200`).catch(() => null);
      report.smoke.events = events;
      throw new Error("smoke_validation_failed");
    }
  }

  report.ok = true;
} catch (error) {
  report.error = error.message;
  if (!report.artifacts && report.health?.ok) report.artifacts = await createBundle();
}

await mkdir(join(RUNTIME_DIR, "debug"), { recursive: true }).catch(() => {});
await writeFile(join(RUNTIME_DIR, "debug", "doctor-last.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => {});
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
