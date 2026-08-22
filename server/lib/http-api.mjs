import crypto from "node:crypto";
import { createServer } from "node:http";

function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

async function readJson(req, maxBytes = 2 * 1024 * 1024) {
  let body = "";
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_body_too_large");
    body += chunk;
  }
  if (!body.trim()) return {};
  try { return JSON.parse(body); }
  catch { throw new Error("invalid_json"); }
}

function authorized(req, token) {
  if (!token) return true;
  const header = String(req.headers.authorization || "");
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function applyCors(req, res, originRule) {
  if (!originRule) return;
  const origin = req.headers.origin;
  if (originRule === "*" || origin === originRule) {
    res.setHeader("Access-Control-Allow-Origin", originRule === "*" ? "*" : origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, Prefer, X-Filename");
  }
}

function boolParam(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function headerFilename(req) {
  const value = String(req.headers["x-filename"] || "").trim();
  if (!value) return null;
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function openAiResponse(job) {
  return {
    id: `chatcmpl-${job.id}`,
    object: "chat.completion",
    created: Math.floor(new Date(job.created_at).getTime() / 1000),
    model: job.model || "chatgpt-web",
    choices: [{
      index: 0,
      message: { role: "assistant", content: job.result?.content || "" },
      finish_reason: job.status === "completed" ? "stop" : null,
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    gateway: {
      job_id: job.id,
      conversation_id: job.conversation_id || null,
      project_id: job.project_id || null,
      attachments: job.attachments || [],
      status: job.status,
    },
  };
}

function errorStatus(error) {
  if (error.code === "REQUEST_ID_CONFLICT") return 409;
  if (error.code === "JOB_RUNNING") return 409;
  if (error.code === "PROJECT_NOT_FOUND" || error.code === "ENOENT") return 404;
  if (["INVALID_PROJECT_ID", "INVALID_CONVERSATION_ID"].includes(error.code)) return 400;
  if (error.code === "UPLOAD_TOO_LARGE") return 413;
  if (error.code === "CHATGPT_AUTH_REQUIRED") return 503;
  if (["CHATGPT_BACKEND_FORBIDDEN", "CHATGPT_BACKEND_ERROR", "CHATGPT_INVALID_JSON"].includes(error.code)) return 502;
  if (error.message === "invalid upload id") return 400;
  if (error.message === "missing_x_filename") return 400;
  if (error.message === "invalid_json") return 400;
  if (error.message === "request_body_too_large") return 413;
  return 500;
}

export function createGatewayHttpServer(runtime) {
  runtime.assertReady();
  const { config, jobs, journal } = runtime;

  return createServer(async (req, res) => {
    applyCors(req, res, config.cors_origin);
    const url = new URL(req.url || "/", `http://${req.headers.host || `${config.host}:${config.port}`}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, runtime.health());
      }

      if (!authorized(req, runtime.apiToken)) {
        journal.record("auth_failed", { method: req.method, path: url.pathname }, "warn");
        return json(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      }

      if (req.method === "GET" && url.pathname === "/ready") {
        const state = await runtime.ready();
        return json(res, state.ready ? 200 : 503, state);
      }

      if (req.method === "GET" && url.pathname === "/v1/account") {
        return json(res, 200, { account: runtime.account() });
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return json(res, 200, {
          object: "list",
          data: [{ id: "chatgpt-web", object: "model", created: 1760000000, owned_by: "webchatproxy" }],
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/projects") {
        return json(res, 200, await runtime.listProjects({
          live: boolParam(url.searchParams.get("live"), false),
          sync: boolParam(url.searchParams.get("sync"), true),
          all: boolParam(url.searchParams.get("all"), true),
          cursor: url.searchParams.get("cursor") || null,
        }));
      }

      if (req.method === "POST" && url.pathname === "/v1/projects/import") {
        return json(res, 200, await runtime.importProjects(await readJson(req)));
      }

      if (req.method === "POST" && url.pathname === "/v1/projects/sync") {
        return json(res, 200, await runtime.listProjects({ live: true, sync: true, all: true }));
      }

      const projectConversationsMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/conversations$/);
      if (req.method === "GET" && projectConversationsMatch) {
        const project = decodeURIComponent(projectConversationsMatch[1]);
        return json(res, 200, await runtime.listConversations({
          project,
          all: boolParam(url.searchParams.get("all"), false),
          cursor: url.searchParams.get("cursor") || null,
          limit: url.searchParams.get("limit") || 50,
        }));
      }

      const projectFilesMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/files$/);
      if (req.method === "GET" && projectFilesMatch) {
        return json(res, 200, await runtime.listProjectFiles(decodeURIComponent(projectFilesMatch[1])));
      }

      if (req.method === "GET" && url.pathname === "/v1/conversations") {
        return json(res, 200, await runtime.listConversations({
          project: url.searchParams.get("project") || null,
          project_id: url.searchParams.get("project_id") || null,
          all: boolParam(url.searchParams.get("all"), false),
          cursor: url.searchParams.get("cursor") || null,
          offset: url.searchParams.get("offset") || 0,
          limit: url.searchParams.get("limit") || 50,
        }));
      }

      const conversationMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
      if (req.method === "GET" && conversationMatch) {
        return json(res, 200, { conversation: await runtime.getConversation(decodeURIComponent(conversationMatch[1])) });
      }

      if (req.method === "POST" && url.pathname === "/v1/files") {
        const filename = headerFilename(req);
        if (!filename) throw new Error("missing_x_filename");
        const file = await runtime.saveUpload(req, {
          filename,
          mime: req.headers["content-type"] || "application/octet-stream",
          contentLength: req.headers["content-length"] || null,
        });
        return json(res, 201, { file }, { Location: `/v1/files/${encodeURIComponent(file.id)}` });
      }

      const fileMatch = url.pathname.match(/^\/v1\/files\/([^/]+)$/);
      if (fileMatch) {
        const id = decodeURIComponent(fileMatch[1]);
        if (req.method === "GET") return json(res, 200, { file: await runtime.getUpload(id) });
        if (req.method === "DELETE") return json(res, 200, await runtime.deleteUpload(id));
      }

      if (req.method === "POST" && url.pathname === "/v1/jobs") {
        const payload = await runtime.prepareJobPayload(await readJson(req));
        const requestedId = req.headers["idempotency-key"] || payload.request_id || null;
        const created = await jobs.create(payload, { requestId: requestedId });
        return json(res, 202, {
          job: created.job,
          reused: created.reused,
          account: runtime.account(),
          status_url: `/v1/jobs/${encodeURIComponent(created.job.id)}`,
          events_url: `/v1/jobs/${encodeURIComponent(created.job.id)}/events`,
        }, { Location: `/v1/jobs/${encodeURIComponent(created.job.id)}` });
      }

      if (req.method === "GET" && url.pathname === "/v1/jobs") {
        return json(res, 200, {
          jobs: jobs.list({ limit: url.searchParams.get("limit") || 100 }),
          stats: jobs.stats(),
        });
      }

      const eventsMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/events$/);
      if (req.method === "GET" && eventsMatch) {
        const id = decodeURIComponent(eventsMatch[1]);
        if (!jobs.get(id, { live: false })) return json(res, 404, { error: "job_not_found", id });
        return json(res, 200, {
          id,
          events: runtime.events({ jobId: id, limit: url.searchParams.get("limit") || 200 }),
        });
      }

      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (jobMatch) {
        const id = decodeURIComponent(jobMatch[1]);
        if (req.method === "GET") {
          const job = jobs.get(id, { live: true });
          return job ? json(res, 200, { job }) : json(res, 404, { error: "job_not_found", id });
        }
        if (req.method === "DELETE") {
          const job = await jobs.cancel(id);
          return job ? json(res, 200, { job }) : json(res, 404, { error: "job_not_found", id });
        }
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const payload = await runtime.prepareJobPayload(await readJson(req));
        const requestedId = req.headers["idempotency-key"] || payload.request_id || null;
        const created = await jobs.create(payload, { requestId: requestedId });
        const asyncRequested = payload.async === true || /respond-async/i.test(String(req.headers.prefer || ""));
        if (asyncRequested) {
          return json(res, 202, {
            id: created.job.id,
            object: "gateway.job",
            status: created.job.status,
            account: runtime.account(),
            status_url: `/v1/jobs/${encodeURIComponent(created.job.id)}`,
          }, { Location: `/v1/jobs/${encodeURIComponent(created.job.id)}` });
        }

        const timeout = Math.max(1000, Number(payload.timeout) || 210000) + 30000;
        const finished = await jobs.waitFor(created.job.id, timeout);
        if (finished.status !== "completed") {
          return json(res, finished.status === "cancelled" ? 409 : 502, {
            error: finished.error || finished.status,
            job: finished,
          });
        }
        return json(res, 200, { ...openAiResponse(finished), account: runtime.account() });
      }

      if (req.method === "GET" && url.pathname === "/v1/debug/config") {
        return json(res, 200, config);
      }
      if (req.method === "GET" && url.pathname === "/v1/debug/runtime") {
        return json(res, 200, await runtime.debugSnapshot());
      }
      if (req.method === "GET" && url.pathname === "/v1/debug/doctor") {
        const report = await runtime.doctor();
        return json(res, report.ok ? 200 : 503, report);
      }
      if (req.method === "GET" && url.pathname === "/v1/debug/dom") {
        return json(res, 200, await runtime.dom());
      }
      if (req.method === "GET" && url.pathname === "/v1/debug/events") {
        return json(res, 200, {
          events: runtime.events({
            limit: url.searchParams.get("limit") || 200,
            jobId: url.searchParams.get("job_id") || null,
            level: url.searchParams.get("level") || null,
          }),
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/debug/screenshot") {
        const image = await runtime.screenshot();
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": image.length,
          "Cache-Control": "no-store",
        });
        return res.end(image);
      }
      if (req.method === "POST" && url.pathname === "/v1/debug/bundle") {
        return json(res, 201, await runtime.diagnosticBundle());
      }
      if (req.method === "POST" && url.pathname === "/v1/debug/browser/restart") {
        return json(res, 200, await runtime.restartBrowser());
      }
      if (req.method === "POST" && url.pathname === "/v1/debug/smoke") {
        const smoke = await runtime.createSmokeJob();
        return json(res, 202, {
          job: smoke.job,
          expected: smoke.expected,
          account: runtime.account(),
          status_url: `/v1/jobs/${smoke.job.id}`,
        }, { Location: `/v1/jobs/${smoke.job.id}` });
      }

      return json(res, 404, { error: "not_found", method: req.method, path: url.pathname });
    } catch (error) {
      journal.record("request_error", {
        method: req.method,
        path: url.pathname,
        error: error.message,
        code: error.code || null,
      }, "error");
      const payload = { error: error.message, code: error.code || null };
      if (error.code === "JOB_RUNNING") payload.id = error.jobId;
      if (error.status != null) payload.upstream_status = error.status;
      return json(res, errorStatus(error), payload);
    }
  });
}
