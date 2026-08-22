import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { FileStore } from "../lib/file-store.mjs";

test("streams an attachment to runtime with hash and metadata", async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "webchat-files-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const store = await new FileStore({ runtimeDir, maxBytes: 1024 }).init();
  const bytes = Buffer.from("hello attachment\n");

  const metadata = await store.saveStream(Readable.from(bytes), {
    filename: "../evidence.txt",
    mime: "text/plain",
    contentLength: bytes.length,
  });

  assert.match(metadata.id, /^upl_/);
  assert.equal(metadata.name, "evidence.txt");
  assert.equal(metadata.size, bytes.length);
  assert.equal(metadata.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  const resolved = await store.get(metadata.id);
  assert.deepEqual(await readFile(resolved.path), bytes);
  assert.equal(resolved.mime, "text/plain");

  await store.remove(metadata.id);
  await assert.rejects(store.get(metadata.id), /ENOENT/);
});

test("rejects oversized attachments and removes partial data", async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "webchat-files-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const store = await new FileStore({ runtimeDir, maxBytes: 5 }).init();

  await assert.rejects(
    store.saveStream(Readable.from(Buffer.from("123456")), { filename: "too-big.bin" }),
    (error) => error.code === "UPLOAD_TOO_LARGE",
  );
});
