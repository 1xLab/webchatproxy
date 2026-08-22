import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export class EventJournal {
  constructor({ file, maxMemory = 1000 } = {}) {
    this.file = file;
    this.maxMemory = maxMemory;
    this.events = [];
    this.writeChain = Promise.resolve();
  }

  async init() {
    if (this.file) await mkdir(dirname(this.file), { recursive: true });
  }

  record(event, data = {}, level = "info") {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...data,
    };
    this.events.push(entry);
    if (this.events.length > this.maxMemory) {
      this.events.splice(0, this.events.length - this.maxMemory);
    }
    if (this.file) {
      this.writeChain = this.writeChain
        .then(() => appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8"))
        .catch((error) => {
          console.error("[journal] write failed:", error.message);
        });
    }
    return entry;
  }

  list({ limit = 100, jobId = null, level = null } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
    return this.events
      .filter((entry) => !jobId || entry.jobId === jobId)
      .filter((entry) => !level || entry.level === level)
      .slice(-safeLimit);
  }

  async flush() {
    await this.writeChain;
  }
}
