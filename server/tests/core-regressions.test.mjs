import assert from "node:assert/strict";
import test from "node:test";
import { conversationIdFromUrl, extractAssistantUpdates, extractConversationIdFromPayload } from "../browser-backend.mjs";
import { looksLikeBrowserCrash } from "../lib/job-manager.mjs";

test("network parser keeps assistant text separate from finished_successfully", () => {
  const payload = JSON.stringify([
    { p: "/message/content/parts/0", o: "append", v: "WEBCHAT_OK" },
    { v: "finished_successfully" },
  ]);
  assert.deepEqual(extractAssistantUpdates(payload), [
    { type: "append", text: "WEBCHAT_OK" },
    { type: "complete" },
  ]);
});

test("network parser ignores unrelated generic v strings", () => {
  const payload = JSON.stringify({ p: "/metadata/state", v: "internal_marker" });
  assert.deepEqual(extractAssistantUpdates(payload), []);
});

test("network parser recognizes explicit stream completion", () => {
  assert.deepEqual(extractAssistantUpdates(JSON.stringify({ type: "message_stream_complete" })), [
    { type: "complete" },
  ]);
});

test("conversation id is extracted from ChatGPT route", () => {
  assert.equal(
    conversationIdFromUrl("https://chatgpt.com/c/6a860fb6-786c-83e9-b5b5-0ab07cb2fea9"),
    "6a860fb6-786c-83e9-b5b5-0ab07cb2fea9",
  );
});

test("conversation id is extracted from nested network payload", () => {
  const payload = JSON.stringify({
    type: "message_stream_complete",
    metadata: { conversation_id: "6a860fb6-786c-83e9-b5b5-0ab07cb2fea9" },
  });
  assert.equal(
    extractConversationIdFromPayload(payload),
    "6a860fb6-786c-83e9-b5b5-0ab07cb2fea9",
  );
});

test("conversation id is extracted from URL embedded in network payload", () => {
  const payload = JSON.stringify({ redirect: "https://chatgpt.com/c/abc-123_def" });
  assert.equal(extractConversationIdFromPayload(payload), "abc-123_def");
});

test("page timeout is not classified as browser crash", () => {
  assert.equal(looksLikeBrowserCrash(new Error("page.goto: Timeout 30000ms exceeded.")), false);
  assert.equal(looksLikeBrowserCrash(new Error("page.waitForFunction: Timeout 120000ms exceeded.")), false);
});

test("closed target is classified as browser crash", () => {
  assert.equal(looksLikeBrowserCrash(new Error("page.goto: Target page, context or browser has been closed")), true);
  assert.equal(looksLikeBrowserCrash(new Error("Target page, context or browser has been closed")), true);
});
