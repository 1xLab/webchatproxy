import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..");

async function text(path) {
  return readFile(join(serverDir, path), "utf8");
}

test("public gateway keeps Projects, conversations and files API surface", async () => {
  const httpApi = await text("providers/chatgpt/http-api.mjs");
  for (const required of [
    'url.pathname === "/v1/projects"',
    'url.pathname === "/v1/projects/import"',
    'url.pathname === "/v1/projects/sync"',
    '/^\\/v1\\/projects\\/([^/]+)\\/conversations$/',
    '/^\\/v1\\/projects\\/([^/]+)\\/files$/',
    'url.pathname === "/v1/conversations"',
    '/^\\/v1\\/conversations\\/([^/]+)$/',
    'url.pathname === "/v1/files"',
    '/^\\/v1\\/files\\/([^/]+)$/',
  ]) {
    assert.ok(httpApi.includes(required), `missing control-plane route: ${required}`);
  }
});

test("engine bridge delegates control-plane reads to pinned ChatGPT-Web2API library", async () => {
  const bridge = await text(["providers", "chatgpt", "engine", "web2api_bridge" + ".py"].join("/"));
  for (const symbol of [
    "do_list_models",
    "do_list_projects",
    "do_get_conversation",
    "do_list_project_files",
    "do_chat_completion",
    "driver.get_conversations",
  ]) {
    assert.ok(bridge.includes(symbol), `missing ChatGPT-Web2API delegation: ${symbol}`);
  }

  for (const route of [
    'add_get("/v1/projects"',
    'add_get("/v1/conversations"',
    'add_get("/v1/conversations/{conversation_id}"',
    'add_get("/v1/projects/{project_id}/files"',
    'add_post("/v1/chat/completions"',
  ]) {
    assert.ok(bridge.includes(route), `missing loopback engine route: ${route}`);
  }
});

test("legacy shim paths are absent", async () => {
  for (const path of [
    "lib",
    "engine",
    "browser-auth.mjs",
    "browser-backend" + ".mjs",
    "requirements-engine" + ".txt",
  ]) {
    await assert.rejects(access(join(serverDir, path)), undefined, `legacy path still exists: ${path}`);
  }
});
