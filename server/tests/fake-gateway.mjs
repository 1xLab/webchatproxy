import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_GATEWAY_PORT || 3219);
const HOST = "127.0.0.1";
const jobs = new Map();

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      status: "ok",
      service: "fake-webchat-gateway",
      browser: { running: true, page_ready: true },
      jobs: { running: null, queued: 0, total: jobs.size },
      port: PORT,
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/debug/doctor") {
    return json(res, 200, { ok: true, status: "ready", checks: [] });
  }

  if (req.method === "POST" && url.pathname === "/v1/jobs") {
    const payload = await readJson(req);
    const id = payload.request_id || `fake-${Date.now()}`;
    const last = [...(payload.messages || [])].reverse().find((message) => message?.role === "user");
    const content = typeof last?.content === "string" ? last.content : "";
    const job = {
      id,
      status: "completed",
      model: payload.model || "chatgpt-web",
      conversation_id: payload.conversation_id || "fake-conversation-123",
      result: { content: `FAKE_OK:${content}` },
      error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
    jobs.set(id, job);
    return json(res, 202, {
      job,
      reused: false,
      status_url: `/v1/jobs/${encodeURIComponent(id)}`,
      events_url: `/v1/jobs/${encodeURIComponent(id)}/events`,
    });
  }

  const match = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const id = decodeURIComponent(match[1]);
    const job = jobs.get(id);
    return job ? json(res, 200, { job }) : json(res, 404, { error: "job_not_found", id });
  }

  return json(res, 404, { error: "not_found" });
});

server.listen(PORT, HOST, () => {
  console.log(`FAKE_GATEWAY_READY http://${HOST}:${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
