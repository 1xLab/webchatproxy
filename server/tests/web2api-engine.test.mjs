import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Web2ApiEngine } from "../lib/web2api-engine.mjs";

async function fakeEngine(handler) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : null;
    const result = await handler(req, parsed);
    const payload = JSON.stringify(result.body ?? result);
    res.writeHead(result.status || 200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("Web2ApiEngine delegates projects, conversations and chat to loopback engine", async (t) => {
  const seen = [];
  const fake = await fakeEngine(async (req, body) => {
    seen.push({ method: req.method, url: req.url, body });
    if (req.url === "/health") return { status: "healthy", engine: "chatgpt-web2api", chrome_running: true, driver_connected: true };
    if (req.url === "/v1/projects") return { projects: [{ id: "g-p-one", name: "One" }] };
    if (req.url.startsWith("/v1/conversations?")) return { conversations: [{ id: "conv-1", title: "Test", gizmo_id: "g-p-one" }], offset: 0, limit: 50 };
    if (req.url.startsWith("/v1/conversations/conv-1?")) return { id: "conv-1", title: "Test", messages: [{ role: "user", content: "hi" }], total: 1, has_more: false };
    if (req.url === "/v1/projects/g-p-one/files") return { project_id: "g-p-one", files: [{ id: "file-1", name: "a.pdf" }] };
    if (req.url === "/v1/chat/completions") return { content: "ENGINE_OK", model: "auto", conversation_id: "conv-2" };
    return { status: 404, body: { error: "not found" } };
  });
  t.after(() => fake.close());

  const engine = new Web2ApiEngine({
    baseDir: process.cwd(),
    env: { WEBCHAT_ENGINE_URL: fake.url, WEBCHAT_ENGINE_AUTOSTART: "0" },
  });

  assert.equal((await engine.health()).driver_connected, true);
  assert.equal((await engine.listProjects())[0].id, "g-p-one");
  assert.equal((await engine.listConversations({ projectId: "g-p-one" })).items[0].id, "conv-1");
  assert.equal((await engine.getConversation("conv-1")).messages[0].content, "hi");
  assert.equal((await engine.listProjectFiles("g-p-one")).files[0].name, "a.pdf");
  assert.equal(await engine.ask([{ role: "user", content: "ping" }], { projectId: "g-p-one", requestId: "job-test" }), "ENGINE_OK");
  assert.equal(engine.conversationId(), "conv-2");

  const chat = seen.find((item) => item.url === "/v1/chat/completions");
  assert.equal(chat.body.project_id, "g-p-one");
  assert.equal(chat.body.model, "auto");
});

test("Web2ApiEngine fails closed for unsupported attachments", async () => {
  const engine = new Web2ApiEngine({ baseDir: process.cwd(), env: { WEBCHAT_ENGINE_AUTOSTART: "0" } });
  await assert.rejects(
    engine.ask([{ role: "user", content: "x" }], { attachments: ["/tmp/a.pdf"] }),
    (error) => error.code === "ENGINE_ATTACHMENTS_UNSUPPORTED" && error.status === 501,
  );
});
