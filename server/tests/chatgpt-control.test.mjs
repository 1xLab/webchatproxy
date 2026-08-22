import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptControl } from "../lib/chatgpt-control.mjs";
import { safeChatGptProjectUrl } from "../browser-backend.mjs";

function fakeBackend(handler) {
  const calls = [];
  return {
    calls,
    chatgptAccountId: "acct-test",
    async start() {},
    page: {
      isClosed: () => false,
      async evaluate(_fn, args) {
        calls.push(args);
        const payload = await handler(args);
        return { ok: true, stage: "backend", status: 200, text: JSON.stringify(payload) };
      },
    },
  };
}

test("lists all projects through cursor pagination", async () => {
  const backend = fakeBackend(({ path }) => path.includes("cursor=next")
    ? { items: [{ gizmo: { id: "g-p-two" } }], cursor: null }
    : { items: [{ gizmo: { id: "g-p-one" } }], cursor: "next" });
  const control = new ChatGptControl({ backend });

  const result = await control.listProjects({ all: true });
  assert.equal(result.items.length, 2);
  assert.equal(result.pages, 2);
  assert.match(backend.calls[0].path, /gizmos\/snorlax\/sidebar/);
  assert.match(backend.calls[1].path, /cursor=next/);
  assert.equal(backend.calls[0].accountId, "acct-test");
});

test("uses efficient backend endpoints for project chats and full conversation", async () => {
  const backend = fakeBackend(({ path }) => {
    if (path.includes("/conversations")) return { items: [{ id: "conv-1" }], cursor: null };
    if (path.includes("/conversation/")) return { conversation_id: "conv-1", title: "Old chat", mapping: {} };
    return {};
  });
  const control = new ChatGptControl({ backend });

  const list = await control.listConversations({ projectId: "g-p-project123" });
  assert.equal(list.project_id, "g-p-project123");
  assert.equal(list.items[0].id, "conv-1");
  assert.match(backend.calls[0].path, /gizmos\/g-p-project123\/conversations/);

  const conversation = await control.getConversation("conv-1");
  assert.equal(conversation.title, "Old chat");
  assert.match(backend.calls[1].path, /backend-api\/conversation\/conv-1/);
});

test("project navigation accepts only ChatGPT HTTPS project URLs", () => {
  assert.equal(
    safeChatGptProjectUrl("https://chatgpt.com/g/g-p-project123-human-name/project", "g-p-project123"),
    "https://chatgpt.com/g/g-p-project123-human-name/project",
  );
  assert.equal(safeChatGptProjectUrl("https://evil.example/g/g-p-project123/project", "g-p-project123"), "https://chatgpt.com/g/g-p-project123/project");
  assert.equal(safeChatGptProjectUrl(null, "invalid"), null);
});
