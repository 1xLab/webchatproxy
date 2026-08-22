// ChatGPT Gateway Server
// HTTP API + WebSocket relay to Chrome extension
import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { WebSocketServer } from "ws";
import { BrowserBackend } from "./browser-backend.mjs";

const PORT = parseInt(process.env.PORT || "3000", 10);
const BACKEND = process.env.REMOTE_IA_BACKEND || "extension";
const browserBackend = BACKEND === "browser"
  ? new BrowserBackend({ headless: process.env.REMOTE_IA_HEADLESS === "1" })
  : null;

// Pending HTTP requests waiting for extension response
const pending = new Map(); // requestId -> { resolve, reject, timer }

let extensionWs = null;
let extensionConnectionId = null;
let extensionLastSeen = 0;

// status/cmd em tempo real: requestId -> { resolve, timer }
const cmdPending = new Map();

function extensionReady() {
  return extensionWs?.readyState === 1 && extensionConnectionId !== null;
}

function sendToExtension(message) {
  if (!extensionReady()) return false;
  extensionWs.send(JSON.stringify(message));
  return true;
}

function dispatchPending() {
  if (!extensionReady()) return;
  for (const entry of pending.values()) {
    if (entry.completed || entry.dispatchedTo === extensionConnectionId) continue;
    if (sendToExtension(entry.message)) {
      entry.dispatchedTo = extensionConnectionId;
      entry.acknowledged = false;
    }
  }
}

const interactionLog = process.env.MSWEA_INTERACTION_LOG || join(homedir(), "Library/Logs/mini-swe-agent-interaction.jsonl");

function trace(event, data = {}) {
  if (!interactionLog) return;
  try {
    mkdirSync(dirname(interactionLog), { recursive: true });
    appendFileSync(
      interactionLog,
      `${JSON.stringify({ timestamp: Date.now() / 1000, component: "gateway", event, ...data })}\n`,
      "utf8"
    );
  } catch (error) {
    console.error("[gateway] Failed to write interaction log:", error.message);
  }
}

// ── WebSocket server (extension connects here) ────────────

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("[gateway] WebSocket connected; waiting for READY");

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      trace("websocket_invalid_json", { raw: raw.toString() });
      return;
    }

    extensionLastSeen = Date.now();

    if (msg.type === "READY" && msg.connectionId) {
      if (extensionWs && extensionWs !== ws) extensionWs.close(4000, "replaced");
      extensionWs = ws;
      extensionConnectionId = String(msg.connectionId);
      console.log(`[gateway] Extension ready (${extensionConnectionId})`);
      trace("extension_ready", { connectionId: extensionConnectionId });
      sendToExtension({ type: "READY_ACK", connectionId: extensionConnectionId });
      dispatchPending();
      return;
    }

    if (msg.type === "HB") {
      if (ws === extensionWs) {
        sendToExtension({ type: "HB_ACK", ts: Date.now() });
      }
      return;
    }

    if (msg.type === "ACK" && pending.has(msg.requestId)) {
      pending.get(msg.requestId).acknowledged = true;
      return;
    }

    trace("extension_message_received", { requestId: msg.requestId || null, message: msg });

    if (msg.type === "response" && pending.has(msg.requestId)) {
      const entry = pending.get(msg.requestId);
      const { resolve, timer } = entry;
      entry.completed = true;
      clearTimeout(timer);
      pending.delete(msg.requestId);
      resolve(msg);
    } else if (msg.type === "response") {
      trace("orphan_response", {
        requestId: msg.requestId || null,
        response: msg,
        reason: "request already timed out or was cleared",
      });
    }

    if (msg.type === "cmd_response" && cmdPending.has(msg.requestId)) {
      const { resolve, timer } = cmdPending.get(msg.requestId);
      clearTimeout(timer);
      cmdPending.delete(msg.requestId);
      resolve(msg);
    }
  });

  ws.on("close", () => {
    if (extensionWs === ws) {
      console.log(`[gateway] Extension disconnected (${extensionConnectionId})`);
      trace("extension_disconnected", { connectionId: extensionConnectionId });
      extensionWs = null;
      extensionConnectionId = null;
      extensionLastSeen = 0;
      for (const entry of pending.values()) entry.dispatchedTo = null;
    }
  });
});

setInterval(() => {
  if (!extensionWs) return;
  if (Date.now() - extensionLastSeen > 45_000) {
    console.log(`[gateway] Extension heartbeat expired (${extensionConnectionId})`);
    extensionWs.terminate();
  }
}, 15_000).unref();

// ── Helpers ────────────────────────────────────────────────

function cleanupRequest(requestId) {
  const entry = pending.get(requestId);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(requestId);
    entry.reject(new Error("Client disconnected"));
  }
}

function cleanupAllRequests() {
  const requestIds = [...pending.keys()];
  for (const requestId of requestIds) cleanupRequest(requestId);
  return requestIds.length;
}

// A server restart must never inherit work from an earlier runtime. The map
// starts empty in a new process, and this also protects in-process restarts.
const cancelledAtStartup = cleanupAllRequests();
trace("gateway_startup", { cancelledStaleRequests: cancelledAtStartup });

// ── HTTP server ────────────────────────────────────────────

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        extensionConnected: extensionReady(),
        extensionConnectionId,
        extensionLastSeen,
        pendingRequests: pending.size,
        backend: BACKEND,
        browser: browserBackend?.health() || null,
      })
    );
    return;
  }

  // Cancel a pending request
  // Debug: despejar estado do DOM (tipos de mensagens presentes)
  if (req.method === "GET" && req.url === "/v1/debug/dom") {
    if (!browserBackend) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "backend nao e browser" }));
      return;
    }
    const dbg = await browserBackend.debugDom();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(dbg));
    return;
  }

  // Meta de uma conversa (total de mensagens/turnos + última) — modo browser
  if (req.method === "GET" && /^\/v1\/conversations\/[^/]+\/meta$/.test(req.url || "")) {
    if (!browserBackend) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "backend nao e browser" }));
      return;
    }
    const id = req.url.split("/")[3];
    const data = await browserBackend.readConversationMeta(id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }

  // Pedir status em tempo real de um pedido ("thinking") para a extensao ler o DOM
  if (req.method === "GET" && /^\/v1\/requests\/[^/]+\/status$/.test(req.url || "")) {
    const requestId = req.url.split("/")[3];
    const entry = pending.get(requestId);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request not found", id: requestId }));
      return;
    }
    // Modo browser: le o pensamento ao vivo direto do browser-backend
    if (browserBackend) {
      const progress = browserBackend.progressOf(requestId);
      // Leitura ao vivo do raciocinio real do DOM (expande bloco "Worked for" e le layout)
      const dom = await Promise.race([
        browserBackend.readDomThinking(),
        new Promise((r) => setTimeout(() => r(null), 15000)),
      ]);
      const thinking = dom?.latestThought || progress?.thinking || "";
      const content = dom?.latestAnswer || progress?.content || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: requestId,
        backend: "browser",
        acknowledged: entry.acknowledged === true,
        completed: entry.completed === true,
        thinking,
        content,
        thinking_len: thinking.length,
        content_len: content.length,
        streaming: dom?.streaming ?? null,
        status: progress?.status || (thinking ? "pensando" : "pendente"),
        updatedAt: progress?.updatedAt ? new Date(progress.updatedAt).toISOString() : null,
      }));
      return;
    }
    if (!extensionReady()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Extension not connected" }));
      return;
    }
    const cmdType = "thinking";
    const timeoutMs = parseInt(req.headers["x-status-timeout"] || "20000", 10);
    try {
      // Envia o comando para a extensao ler o DOM
      const sent = sendToExtension({ type: "cmd", cmd: cmdType, requestId });
      if (!sent) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Extension not ready", id: requestId }));
        return;
      }
      // Aguarda a extensao devolver via cmd_response e responde
      const payload = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cmdPending.delete(requestId);
          reject(new Error("Status timeout"));
        }, timeoutMs);
        cmdPending.set(requestId, { resolve, reject, timer });
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: requestId,
        cmd: cmdType,
        acknowledged: entry.acknowledged === true,
        completed: entry.completed === true,
        payload: payload?.payload || {},
      }));
    } catch (error) {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message, id: requestId }));
    }
    return;
  }

  // List every pending request (status/racional do pedido do consultor)
  if (req.method === "GET" && req.url === "/v1/requests") {
    const list = [...pending.entries()].map(([requestId, entry]) => ({
      id: requestId,
      acknowledged: entry.acknowledged === true,
      completed: entry.completed === true,
      dispatchedTo: entry.dispatchedTo || null,
      message: entry.message ? {
        model: entry.message.model,
        newConversation: entry.message.newConversation !== false,
        prompt: (entry.message.messages?.at(-1)?.content || "").toString().slice(0, 400),
      } : null,
      createdAt: entry.createdAt || null,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ requests: list, count: list.length }));
    return;
  }

  // Status of a single pending request
  if (req.method === "GET" && req.url?.startsWith("/v1/requests/")) {
    const requestId = req.url.split("/").pop();
    const entry = pending.get(requestId);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request not found", id: requestId }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: requestId,
      acknowledged: entry.acknowledged === true,
      completed: entry.completed === true,
      dispatchedTo: entry.dispatchedTo || null,
      message: entry.message ? {
        model: entry.message.model,
        newConversation: entry.message.newConversation !== false,
        prompt: (entry.message.messages?.at(-1)?.content || "").toString().slice(0, 400),
      } : null,
      createdAt: entry.createdAt || null,
    }));
    return;
  }

  if (req.method === "DELETE" && req.url?.startsWith("/v1/requests/")) {
    const requestId = req.url.split("/").pop();
    const had = pending.has(requestId);
    cleanupRequest(requestId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cancelled: had }));
    return;
  }

  // Cancel every request left over from a previous mini run.
  if (req.method === "DELETE" && req.url === "/v1/requests") {
    const cancelled = cleanupAllRequests();
    trace("pending_requests_cleared", { cancelled });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cancelled }));
    return;
  }

  // OpenAI models endpoint
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [{ id: "chatgpt-web", object: "model", created: 1760000000, owned_by: "openai-via-bridge" }],
    }));
    return;
  }

  // OpenAI-compatible chat completions
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    for await (const chunk of req) body += chunk;

    let payload;
    try {
      payload = JSON.parse(body);
      console.log("[gateway] Request messages:", JSON.stringify(payload.messages?.slice(-2)).substring(0, 500));
    } catch {
      trace("http_invalid_json", { method: req.method, path: req.url, body });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    trace("http_request_received", { method: req.method, path: req.url, payload });

    if (browserBackend) {
      const requestId = crypto.randomUUID();
      const created = Math.floor(Date.now() / 1000);
      const model = payload.model || "chatgpt-web";
      const timerRef = { t: null };
      const entry = { acknowledged: false, completed: false, createdAt: Date.now(), message: { model, messages: payload.messages || [], newConversation: payload.new_conversation !== false, conversationId: payload.conversation_id || null } };
      pending.set(requestId, entry);
      try {
        const content = await browserBackend.ask(payload.messages || [], {
          newConversation: payload.new_conversation !== false,
          timeout: parseInt(payload.timeout || "210000", 10),
          requestId,
          conversationId: payload.conversation_id || null,
        });
        entry.completed = true;
        pending.delete(requestId);
        const response = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion",
          created,
          model,
          choices: [{
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        trace("browser_response_sent", { requestId, status: 200 });
      } catch (error) {
        pending.delete(requestId);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
        trace("browser_response_sent", { status: 500, error: error.message });
      }
      return;
    }

    if (!extensionReady()) {
      trace("http_response_sent", {
        status: 503,
        error: "Extension not connected",
      });
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "Extension not connected. Load the extension and open chatgpt.com",
        })
      );
      return;
    }

    const requestId = crypto.randomUUID();
    // content.js can wait up to 180 seconds for ChatGPT to finish. Keep the
    // gateway timeout above that limit so a valid browser response is not
    // discarded just before it arrives.
    const timeoutMs = parseInt(payload.timeout || "210000", 10);

    let extensionRequest;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Timeout waiting for ChatGPT response"));
      }, timeoutMs);
      pending.set(requestId, {
        resolve,
        reject,
        timer,
        message: null,
        dispatchedTo: null,
        acknowledged: false,
        completed: false,
        createdAt: Date.now(),
      });
    });

    // Clean up if the HTTP client disconnects (e.g. MCP cancellation aborts fetch)
    req.on("close", () => {
      if (pending.has(requestId)) {
        console.log(`[gateway] Client disconnected, cleaning up ${requestId}`);
        cleanupRequest(requestId);
      }
    });

    // Send to extension
    extensionRequest = {
        type: "chat",
        requestId,
        model: payload.model || "auto",
        messages: payload.messages || [],
        newConversation: payload.new_conversation !== false,
    };
    const entry = pending.get(requestId);
    entry.message = extensionRequest;
    entry.dispatchedTo = extensionConnectionId;
    sendToExtension(extensionRequest);
    trace("extension_request_sent", { requestId, message: extensionRequest });

    try {
      const result = await promise;

      if (res.writableEnded) return; // Client already gone

      if (!result.ok) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: result.error }));
        return;
      }

      // OpenAI-compatible response format
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${requestId}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: payload.model || "chatgpt-web",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: result.content,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
      );
      trace("http_response_sent", { requestId, status: 200, response: result });
    } catch (err) {
      if (res.writableEnded) return; // Client already gone
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
      trace("http_response_sent", { requestId, status: 504, error: err.message });
    }
    return;
  }

  // Fallback
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// WebSocket upgrade handler
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`
  ChatGPT Gateway Server
  ──────────────────────
  HTTP API:    http://localhost:${PORT}/v1/chat/completions
  Health:      http://localhost:${PORT}/health
  WebSocket:   ws://localhost:${PORT}/ws

  Usage:
    curl -X POST http://localhost:${PORT}/v1/chat/completions \\
      -H "Content-Type: application/json" \\
      -d '{"model":"auto","messages":[{"role":"user","content":"Say hi"}]}'
  `);
  // Make the startup invariant observable through the health/log path.
  trace("gateway_ready", { cancelledStaleRequests: cancelledAtStartup });
  if (browserBackend) {
    browserBackend.start().catch((error) => {
      console.error(`[browser] startup failed: ${error.message}`);
    });
  }
});
