// ChatGPT Gateway — Background service worker
// Connects to local gateway server via WebSocket
"use strict";

const GATEWAY_URL = "ws://localhost:3000/ws";
const connectionId = crypto.randomUUID();
let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let workQueue = Promise.resolve();
const inflight = new Set();
const completed = new Map();

function log(...args) {
  console.log("[Gateway BG]", ...args);
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(GATEWAY_URL);
  } catch (err) {
    log("WebSocket constructor failed:", err.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    log("Connected to gateway server");
    sendToServer({ type: "READY", connectionId });
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      sendToServer({ type: "HB", connectionId, ts: Date.now() });
    }, 15000);
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      log("Invalid JSON from server");
      return;
    }

    if (msg.type === "chat" && msg.requestId) {
      sendToServer({ type: "ACK", requestId: msg.requestId, connectionId });

      if (completed.has(msg.requestId)) {
        sendToServer(completed.get(msg.requestId));
        return;
      }
      if (inflight.has(msg.requestId)) return;

      inflight.add(msg.requestId);
      workQueue = workQueue
        .then(() => handleChatMessage(msg))
        .catch((err) => sendResponse(msg.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }))
        .finally(() => inflight.delete(msg.requestId));
    } else if (msg.type === "cmd") {
      // Pedido de status em tempo real: encaminha para a aba chatgpt e devolve
      handleCmdMessage(msg);
    }
  };

  ws.onclose = () => {
    log("Disconnected from gateway server");
    ws = null;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after this
    ws?.close();
  };
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setInterval(connect, 5000);
  }
}

function sendToServer(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendResponse(requestId, result) {
  const response = {
    type: "response",
    requestId,
    ok: !!result.ok,
    content: typeof result.content === "string" ? result.content : String(result.content || ""),
    error: result.error || "",
  };
  completed.set(requestId, response);
  if (completed.size > 100) completed.delete(completed.keys().next().value);
  sendToServer(response);
}

async function handleChatMessage(msg) {
  // Find a ChatGPT tab
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });

  if (tabs.length === 0) {
    sendResponse(msg.requestId, {
      ok: false,
      error: "No ChatGPT tab open. Please navigate to chatgpt.com",
    });
    return;
  }

  // Extract the last user message
  const messages = msg.messages || [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const rawContent = lastUser?.content || "";
  let userMessage = "";
  if (Array.isArray(rawContent)) {
    userMessage = rawContent.map(p => (typeof p === 'string' ? p : (p.text || ''))).join('\n');
  } else if (typeof rawContent === 'string') {
    userMessage = rawContent;
  } else {
    userMessage = String(rawContent);
  }

  // Remove environment_details injected by Kilo
  userMessage = userMessage.replace(/<environment_details>[\s\S]*?<\/environment_details>/g, '').trim();


  if (!userMessage) {
    sendResponse(msg.requestId, {
      ok: false,
      error: "No user message in request",
    });
    return;
  }

  // Try each tab until one responds (handles multiple ChatGPT tabs)
  const errors = [];
  for (const tab of tabs) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
          type: "chat",
          model: msg.model,
          userMessage,
          newConversation: msg.newConversation !== false,
      });

      sendResponse(msg.requestId, {
        ok: response.ok,
        content: response.content,
        error: response.error || "",
      });
      return; // Success — stop trying other tabs
    } catch (err) {
      errors.push(`Tab ${tab.id}: ${err.message}`);
    }
  }

  // All tabs failed
  sendResponse(msg.requestId, {
    ok: false,
    error: `No ChatGPT tab responded (${tabs.length} tab(s) tried). Refresh chatgpt.com.\n${errors.join("\n")}`,
  });
}

async function handleCmdMessage(msg) {
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  let lastError = "";
  for (const tab of tabs) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "cmd", cmd: msg.cmd ?? "status", requestId: msg.requestId });
      sendToServer({ type: "cmd_response", requestId: msg.requestId || null, cmd: msg.cmd, ok: !!res.ok, payload: res });
      return;
    } catch (err) {
      lastError = err.message;
    }
  }
  sendToServer({ type: "cmd_response", requestId: msg.requestId || null, cmd: msg.cmd, ok: false, payload: { error: "No ChatGPT tab: " + lastError } });
}

// Connect on startup
connect();

// Reconnect on service worker events
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Keep service worker alive with periodic alarm
chrome.alarms.create("keepAlive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect();
    }
  }
});

log("Service worker started");
