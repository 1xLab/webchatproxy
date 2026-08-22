import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const now = () => new Date().toISOString();

function safeName(value = "attachment.bin") {
  const name = basename(String(value || "attachment.bin"))
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_")
    .trim();
  return (name || "attachment.bin").slice(0, 180);
}

function safeId(value = "") {
  const id = String(value || "").trim();
  if (!/^upl_[A-Za-z0-9-]+$/.test(id)) throw new Error("invalid upload id");
  return id;
}

class HashingLimitTransform extends Transform {
  constructor(maxBytes) {
    super();
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.hash = crypto.createHash("sha256");
  }

  _transform(chunk, encoding, callback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      const error = new Error("upload_too_large");
      error.code = "UPLOAD_TOO_LARGE";
      return callback(error);
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }

  digest() {
    return this.hash.digest("hex");
  }
}

export class FileStore {
  constructor({ runtimeDir, maxBytes = 50 * 1024 * 1024, retentionDays = 2 } = {}) {
    if (!runtimeDir) throw new Error("runtimeDir is required");
    this.dir = join(runtimeDir, "uploads");
    this.maxBytes = Math.max(1024, Number(maxBytes) || 50 * 1024 * 1024);
    this.retentionMs = Math.max(1, Number(retentionDays) || 2) * 86400000;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    await this.cleanup();
    return this;
  }

  async saveStream(stream, { filename, mime = "application/octet-stream", contentLength = null } = {}) {
    const declared = contentLength == null ? null : Number(contentLength);
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      const error = new Error("upload_too_large");
      error.code = "UPLOAD_TOO_LARGE";
      throw error;
    }
    const id = `upl_${crypto.randomUUID()}`;
    const name = safeName(filename);
    const uploadDir = join(this.dir, id);
    const payloadPath = join(uploadDir, name);
    const metadataPath = join(uploadDir, "metadata.json");
    await mkdir(uploadDir, { recursive: true });
    const meter = new HashingLimitTransform(this.maxBytes);
    try {
      await pipeline(stream, meter, createWriteStream(payloadPath, { flags: "wx", mode: 0o600 }));
      const metadata = {
        id,
        name,
        mime: String(mime || "application/octet-stream"),
        size: meter.bytes,
        sha256: meter.digest(),
        created_at: now(),
      };
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      return metadata;
    } catch (error) {
      await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async get(id) {
    const uploadId = safeId(id);
    const uploadDir = join(this.dir, uploadId);
    const metadata = JSON.parse(await readFile(join(uploadDir, "metadata.json"), "utf8"));
    const path = join(uploadDir, safeName(metadata.name));
    await stat(path);
    return { ...metadata, path };
  }

  async resolveMany(refs = []) {
    if (!Array.isArray(refs)) throw new Error("attachments must be an array of upload ids");
    const files = [];
    for (const ref of refs) {
      const id = typeof ref === "object" ? ref?.id || ref?.file_id : ref;
      files.push(await this.get(id));
    }
    return files;
  }

  async remove(id) {
    const uploadId = safeId(id);
    await rm(join(this.dir, uploadId), { recursive: true, force: true });
    return { id: uploadId, deleted: true };
  }

  async cleanup() {
    const cutoff = Date.now() - this.retentionMs;
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("upl_")) continue;
      const path = join(this.dir, entry.name);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) {
          await rm(path, { recursive: true, force: true });
          removed++;
        }
      } catch {}
    }
    return { removed };
  }
}
