import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Web2ApiEngine } from "../providers/chatgpt/web2api-engine.mjs";

async function fakeEngine(handler) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : null;
    const result = await handler(req, parsed);
    const hasBodyEnvelope = result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "body");
    const responseBody = hasBodyEnvelope ? result.body : result;
    const statusCode = hasBodyEnvelope && Number.isInteger(result.statusCode) ? result.statusCode : 200;
    const payload = JSON.stringify(responseBody);
    res.writeHead(statusCode, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("Web2ApiEngine delegates the full ChatGPT-Web2API capability surface", async (t) => {
  const seen = [];
  const fake = await fakeEngine(async (req, body) => {
    seen.push({ method: req.method, url: req.url, body });
    if (req.url === "/health") return { status: "healthy", engine: "chatgpt-web2api", chrome_running: true, driver_connected: true };
    if (req.method === "GET" && req.url === "/v1/models") return { models: [{ id: "gpt-5-6", title: "GPT-5.6 Sol" }] };
    if (req.method === "GET" && req.url === "/v1/projects") return { projects: [{ id: "g-p-one", name: "One" }] };
    if (req.method === "POST" && req.url === "/v1/projects") return { id: "g-p-created", name: body.name };
    if (req.method === "PATCH" && req.url === "/v1/projects/g-p-one/instructions") return { success: true, project_id: "g-p-one" };
    if (req.method === "DELETE" && req.url === "/v1/projects/g-p-one") return { success: true, project_id: "g-p-one" };
    if (req.url.startsWith("/v1/conversations?")) return { conversations: [{ id: "conv-1", title: "Test", gizmo_id: "g-p-one" }], offset: 0, limit: 50 };
    if (req.method === "GET" && req.url.startsWith("/v1/conversations/conv-1?")) return { id: "conv-1", title: "Test", messages: [{ role: "user", content: "hi" }], total: 1, has_more: false };
    if (req.method === "POST" && req.url === "/v1/conversations/conv-1/archive") return { success: true, conversation_id: "conv-1", archived: body.archive };
    if (req.method === "DELETE" && req.url === "/v1/conversations/conv-1") return { success: true, conversation_id: "conv-1" };
    if (req.method === "GET" && req.url === "/v1/memories") return { memories: [{ id: "m1", content: "remember" }] };
    if (req.method === "POST" && req.url === "/v1/memories") return { success: true, content: body.content };
    if (req.method === "DELETE" && req.url === "/v1/memories/m1") return { success: true, memory_id: "m1" };
    if (req.method === "GET" && req.url === "/v1/gpts") return { gpts: [{ id: "g-one", name: "GPT One" }] };
    if (req.method === "POST" && req.url === "/v1/gpts/g-one/chat") return { content: `echo:${body.message}`, conversation_id: "conv-gpt" };
    if (req.method === "GET" && req.url === "/v1/projects/g-p-one/files") return { project_id: "g-p-one", files: [{ id: "file-1", name: "a.pdf" }] };
    if (req.method === "POST" && req.url === "/v1/chat/completions") return { content: "ENGINE_OK", model: "auto", conversation_id: "conv-2" };
    return { statusCode: 404, body: { error: "not found" } };
  });
  t.after(() => fake.close());

  const engine = new Web2ApiEngine({
    baseDir: process.cwd(),
    env: { WEBCHAT_ENGINE_URL: fake.url, WEBCHAT_ENGINE_AUTOSTART: "0" },
  });

  assert.equal((await engine.health()).driver_connected, true);
  assert.equal((await engine.listModels())[0].id, "gpt-5-6");
  assert.equal((await engine.listProjects())[0].id, "g-p-one");
  assert.equal((await engine.createProject({ name: "Created" })).id, "g-p-created");
  assert.equal((await engine.updateProjectInstructions("g-p-one", "new instructions")).success, true);
  assert.equal((await engine.listConversations({ projectId: "g-p-one" })).items[0].id, "conv-1");
  assert.equal((await engine.getConversation("conv-1")).messages[0].content, "hi");
  assert.equal((await engine.archiveConversation("conv-1", true)).archived, true);
  assert.equal((await engine.listMemories()).memories[0].id, "m1");
  assert.equal((await engine.createMemory("remember this")).success, true);
  assert.equal((await engine.listGpts()).gpts[0].id, "g-one");
  assert.equal((await engine.chatWithGpt("g-one", "hello")).content, "echo:hello");
  assert.equal((await engine.listProjectFiles("g-p-one")).files[0].name, "a.pdf");
  assert.equal(await engine.ask([{ role: "user", content: "ping" }], { projectId: "g-p-one", requestId: "job-test" }), "ENGINE_OK");
  assert.equal(engine.conversationId(), "conv-2");
  assert.equal((await engine.deleteMemory("m1")).success, true);
  assert.equal((await engine.deleteConversation("conv-1")).success, true);
  assert.equal((await engine.deleteProject("g-p-one")).success, true);

  const chat = seen.find((item) => item.url === "/v1/chat/completions");
  assert.equal(chat.body.project_id, "g-p-one");
  assert.equal(chat.body.model, "auto");
  assert.ok(seen.some((item) => item.method === "POST" && item.url === "/v1/projects"));
  assert.ok(seen.some((item) => item.method === "GET" && item.url === "/v1/memories"));
  assert.ok(seen.some((item) => item.method === "GET" && item.url === "/v1/gpts"));
});

test("Web2ApiEngine preserves upstream write/destructive gate errors", async (t) => {
  const fake = await fakeEngine(async (req) => {
    if (req.url === "/health") return { status: "healthy", chrome_running: true, driver_connected: true };
    if (req.method === "POST" && req.url === "/v1/projects") {
      return { statusCode: 403, body: { error: "operation disabled; set W2A_ENABLE_WRITE=1", code: "ENGINE_OPERATION_GATED" } };
    }
    return { statusCode: 404, body: { error: "not found" } };
  });
  t.after(() => fake.close());
  const engine = new Web2ApiEngine({ baseDir: process.cwd(), env: { WEBCHAT_ENGINE_URL: fake.url, WEBCHAT_ENGINE_AUTOSTART: "0" } });
  await assert.rejects(engine.createProject({ name: "x" }), (error) => error.code === "ENGINE_OPERATION_GATED" && error.status === 403);
});

test("Web2ApiEngine fails closed for unsupported attachments", async () => {
  const engine = new Web2ApiEngine({ baseDir: process.cwd(), env: { WEBCHAT_ENGINE_AUTOSTART: "0" } });
  await assert.rejects(
    engine.ask([{ role: "user", content: "x" }], { attachments: ["/tmp/a.pdf"] }),
    (error) => error.code === "ENGINE_ATTACHMENTS_UNSUPPORTED" && error.status === 501,
  );
});
