import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PROJECT_ID = /\bg-p-[A-Za-z0-9_-]+\b/;
const PROJECT_ID_EXACT = /^g-p-[A-Za-z0-9_-]+$/;
const now = () => new Date().toISOString();

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function projectIdFromUrl(value = "") {
  try {
    const url = new URL(String(value));
    if (url.hostname !== "chatgpt.com" && url.hostname !== "www.chatgpt.com") return null;
    return url.pathname.match(PROJECT_ID)?.[0] || null;
  } catch {
    return String(value).match(PROJECT_ID)?.[0] || null;
  }
}

function normalizedUrl(value = "") {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || !["chatgpt.com", "www.chatgpt.com"].includes(url.hostname)) return null;
    url.hostname = "chatgpt.com";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function projectUrlFrom({ id, short_url: shortUrl, url } = {}) {
  if (url) {
    const normalized = normalizedUrl(url);
    if (normalized) return normalized;
  }
  if (shortUrl) return `https://chatgpt.com/g/${String(shortUrl).replace(/^\/+|\/+$/g, "")}/project`;
  if (id) return `https://chatgpt.com/g/${id}/project`;
  return null;
}

export function normalizeProject(entry = {}, { key = null, source = "unknown", observedAt = null } = {}) {
  if (typeof entry === "string") entry = { id: entry, name: key || entry };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("project entry must be an object or project id string");

  const nested = entry.gizmo?.gizmo || entry.gizmo || entry.project || entry;
  const wrapper = entry.gizmo?.gizmo ? entry.gizmo : entry;
  const url = entry.url || entry.project_url || nested.url || null;
  const id = String(
    entry.id || entry.project_id || entry.gizmo_id || nested.id || nested.project_id || projectIdFromUrl(url) || "",
  ).trim();
  if (!PROJECT_ID_EXACT.test(id)) throw new Error(`invalid ChatGPT project id: ${id || "missing"}`);

  const name = String(
    entry.name || entry.display_name || nested.display?.name || nested.name || key || id,
  ).trim();
  const shortUrl = entry.short_url || nested.short_url || null;
  const aliases = uniqueStrings([
    ...(Array.isArray(entry.aliases) ? entry.aliases : []),
    key,
    name,
    id,
    shortUrl,
  ]);
  const files = Array.isArray(entry.files)
    ? entry.files
    : Array.isArray(wrapper.files)
      ? wrapper.files
      : Array.isArray(nested.files)
        ? nested.files
        : [];

  return {
    id,
    name,
    url: projectUrlFrom({ id, short_url: shortUrl, url }),
    short_url: shortUrl ? String(shortUrl) : null,
    workspace_id: entry.workspace_id || nested.workspace_id || null,
    instructions: entry.instructions ?? nested.instructions ?? null,
    memory_scope: entry.memory_scope || nested.memory_scope || null,
    memory_enabled: entry.memory_enabled ?? nested.memory_enabled ?? null,
    files,
    aliases,
    source,
    last_seen_at: observedAt || entry.last_seen_at || null,
    imported_at: entry.imported_at || null,
  };
}

function entriesFromImport(input) {
  const body = input?.projects ?? input;
  if (Array.isArray(body)) return body.map((entry) => ({ key: null, entry }));
  if (!body || typeof body !== "object") throw new Error("projects import must be an array, object map, or {projects: ...}");
  return Object.entries(body).map(([key, entry]) => ({ key, entry }));
}

function mergeProject(previous, incoming) {
  if (!previous) return incoming;
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined && value !== "") merged[key] = value;
  }
  merged.aliases = uniqueStrings([...(previous.aliases || []), ...(incoming.aliases || [])]);
  if (!incoming.files?.length && previous.files?.length) merged.files = previous.files;
  return merged;
}

export class ResourceCatalog {
  constructor({ runtimeDir, file } = {}) {
    if (!runtimeDir && !file) throw new Error("runtimeDir or file is required");
    this.file = file || join(runtimeDir, "catalog", "projects.json");
    this.state = { schema_version: 1, updated_at: null, projects: [] };
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    await mkdir(dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (parsed && Array.isArray(parsed.projects)) {
        this.state = { schema_version: 1, updated_at: parsed.updated_at || null, ...parsed };
      }
    } catch {}
    this.initialized = true;
    return this;
  }

  listProjects() {
    return [...this.state.projects]
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)))
      .map((project) => ({ ...project, aliases: [...(project.aliases || [])], files: [...(project.files || [])] }));
  }

  resolveProject(ref) {
    if (!ref) return null;
    const candidate = typeof ref === "object"
      ? ref.id || ref.project_id || ref.url || ref.project_url || ref.name
      : ref;
    const value = String(candidate || "").trim();
    if (!value) return null;

    const needle = value.toLocaleLowerCase();
    const refUrl = normalizedUrl(value);
    const known = this.state.projects.find((project) =>
      (refUrl && normalizedUrl(project.url) === refUrl)
      || String(project.name || "").toLocaleLowerCase() === needle
      || (project.aliases || []).some((alias) => String(alias).toLocaleLowerCase() === needle)
      || String(project.short_url || "").toLocaleLowerCase() === needle,
    );
    if (known) return { ...known };

    const idFromUrl = projectIdFromUrl(value);
    const directMatch = value.match(PROJECT_ID)?.[0] || null;
    const id = PROJECT_ID_EXACT.test(value) ? value : idFromUrl || directMatch;
    if (!id || !PROJECT_ID_EXACT.test(id)) return null;
    const found = this.state.projects.find((project) => project.id === id);
    return found ? { ...found } : normalizeProject({ id, url: refUrl }, { source: "direct" });
  }

  async importProjects(input, { source = "import" } = {}) {
    await this.init();
    const importedAt = now();
    const normalized = entriesFromImport(input).map(({ key, entry }) => {
      const project = normalizeProject(entry, { key, source });
      project.imported_at = project.imported_at || importedAt;
      return project;
    });
    const byId = new Map(this.state.projects.map((project) => [project.id, project]));
    for (const project of normalized) byId.set(project.id, mergeProject(byId.get(project.id), project));
    this.state.projects = [...byId.values()];
    await this.#persist();
    return { imported: normalized.length, total: this.state.projects.length, projects: normalized };
  }

  async syncProjects(projects = [], { source = "live" } = {}) {
    await this.init();
    const observedAt = now();
    const normalized = projects.map((entry) => normalizeProject(entry, { source, observedAt }));
    const byId = new Map(this.state.projects.map((project) => [project.id, project]));
    for (const project of normalized) byId.set(project.id, mergeProject(byId.get(project.id), project));
    this.state.projects = [...byId.values()];
    await this.#persist();
    return this.listProjects();
  }

  async #persist() {
    this.state.updated_at = now();
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(temp, this.file);
  }
}
