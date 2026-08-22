const MAX_PROJECT_PAGES = 100;
const MAX_CONVERSATION_PAGES = 100;

function controlError(message, code, status = null, details = null) {
  const error = new Error(message);
  error.code = code;
  if (status != null) error.status = status;
  if (details != null) error.details = details;
  return error;
}

function normalizeProjectPage(payload = {}) {
  return {
    items: Array.isArray(payload.items) ? payload.items : [],
    cursor: payload.cursor ?? null,
  };
}

function normalizeConversationPage(payload = {}) {
  return {
    items: Array.isArray(payload.items) ? payload.items : [],
    cursor: payload.cursor ?? null,
    total: payload.total ?? null,
    offset: payload.offset ?? null,
    limit: payload.limit ?? null,
  };
}

export class ChatGptControl {
  constructor({ backend, journal = null, accountId = null } = {}) {
    if (!backend) throw new Error("backend is required");
    this.backend = backend;
    this.journal = journal;
    this.accountId = accountId || null;
  }

  async #fetch(path, { method = "GET", body = null } = {}) {
    await this.backend.start();
    const page = this.backend.page;
    if (!page || page.isClosed()) throw controlError("browser page unavailable", "CHATGPT_BROWSER_UNAVAILABLE");
    const accountId = this.accountId || this.backend.chatgptAccountId || null;
    const result = await page.evaluate(async ({ path, method, body, accountId }) => {
      const sessionResponse = await fetch("/api/auth/session", { credentials: "include", cache: "no-store" });
      if (!sessionResponse.ok) {
        return { ok: false, stage: "session", status: sessionResponse.status, text: await sessionResponse.text() };
      }
      const session = await sessionResponse.json().catch(() => ({}));
      const token = session?.accessToken || "";
      if (!token) return { ok: false, stage: "session", status: 401, text: "missing access token" };
      const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
      if (accountId) headers["chatgpt-account-id"] = accountId;
      if (body != null) headers["Content-Type"] = "application/json";
      const response = await fetch(path, {
        method,
        credentials: "include",
        cache: "no-store",
        headers,
        body: body == null ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { ok: response.ok, stage: "backend", status: response.status, text };
    }, { path, method, body, accountId });

    if (!result?.ok) {
      const status = Number(result?.status || 0) || null;
      const code = status === 401
        ? "CHATGPT_AUTH_REQUIRED"
        : status === 403
          ? "CHATGPT_BACKEND_FORBIDDEN"
          : "CHATGPT_BACKEND_ERROR";
      this.journal?.record("chatgpt_control_error", { path, method, stage: result?.stage || null, status, code }, "warn");
      throw controlError(`ChatGPT ${result?.stage || "backend"} request failed${status ? ` (${status})` : ""}`, code, status, String(result?.text || "").slice(0, 1000));
    }

    if (!result.text) return null;
    try { return JSON.parse(result.text); }
    catch { throw controlError("ChatGPT backend returned invalid JSON", "CHATGPT_INVALID_JSON", result.status, String(result.text).slice(0, 1000)); }
  }

  async listProjects({ all = true, cursor = null, ownedOnly = true } = {}) {
    const items = [];
    let next = cursor;
    let pages = 0;
    do {
      const params = new URLSearchParams({
        owned_only: ownedOnly ? "true" : "false",
        conversations_per_gizmo: "0",
      });
      if (next) params.set("cursor", next);
      const payload = normalizeProjectPage(await this.#fetch(`/backend-api/gizmos/snorlax/sidebar?${params}`));
      items.push(...payload.items);
      next = payload.cursor;
      pages++;
      if (!all) break;
      if (pages >= MAX_PROJECT_PAGES && next) throw controlError("project pagination limit reached", "CHATGPT_PAGINATION_LIMIT");
    } while (next);
    this.journal?.record("chatgpt_projects_listed", { count: items.length, pages });
    return { items, cursor: next, pages };
  }

  async getProject(projectId) {
    const id = String(projectId || "").trim();
    if (!/^g-p-[A-Za-z0-9_-]+$/.test(id)) throw controlError("invalid project id", "INVALID_PROJECT_ID");
    return this.#fetch(`/backend-api/gizmos/${encodeURIComponent(id)}`);
  }

  async listProjectFiles(projectId) {
    const payload = await this.getProject(projectId);
    const wrapper = payload?.gizmo?.gizmo ? payload.gizmo : payload;
    const files = wrapper?.files || payload?.files || payload?.gizmo?.files || [];
    return { project_id: projectId, files: Array.isArray(files) ? files : [] };
  }

  async listConversations({ projectId = null, all = false, cursor = null, offset = 0, limit = 50 } = {}) {
    if (projectId) return this.#listProjectConversations(projectId, { all, cursor });
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    let currentOffset = Math.max(0, Number(offset) || 0);
    const items = [];
    let pages = 0;
    let total = null;
    do {
      const params = new URLSearchParams({ offset: String(currentOffset), limit: String(safeLimit), order: "updated" });
      const payload = normalizeConversationPage(await this.#fetch(`/backend-api/conversations?${params}`));
      items.push(...payload.items);
      total = payload.total ?? total;
      pages++;
      if (!all || payload.items.length < safeLimit || (total != null && items.length + currentOffset >= Number(total))) break;
      currentOffset += safeLimit;
      if (pages >= MAX_CONVERSATION_PAGES) throw controlError("conversation pagination limit reached", "CHATGPT_PAGINATION_LIMIT");
    } while (true);
    this.journal?.record("chatgpt_conversations_listed", { projectId: null, count: items.length, pages });
    return { items, offset: Math.max(0, Number(offset) || 0), limit: safeLimit, total, pages };
  }

  async #listProjectConversations(projectId, { all = false, cursor = null } = {}) {
    const id = String(projectId || "").trim();
    if (!/^g-p-[A-Za-z0-9_-]+$/.test(id)) throw controlError("invalid project id", "INVALID_PROJECT_ID");
    const items = [];
    let next = cursor ?? "0";
    let pages = 0;
    do {
      const params = new URLSearchParams({ cursor: String(next) });
      const payload = normalizeConversationPage(await this.#fetch(`/backend-api/gizmos/${encodeURIComponent(id)}/conversations?${params}`));
      items.push(...payload.items);
      next = payload.cursor;
      pages++;
      if (!all || !next) break;
      if (pages >= MAX_CONVERSATION_PAGES) throw controlError("project conversation pagination limit reached", "CHATGPT_PAGINATION_LIMIT");
    } while (next);
    this.journal?.record("chatgpt_conversations_listed", { projectId: id, count: items.length, pages });
    return { project_id: id, items, cursor: next, pages };
  }

  async getConversation(conversationId) {
    const id = String(conversationId || "").replace(/[^A-Za-z0-9_-]/g, "");
    if (!id) throw controlError("invalid conversation id", "INVALID_CONVERSATION_ID");
    const payload = await this.#fetch(`/backend-api/conversation/${encodeURIComponent(id)}`);
    this.journal?.record("chatgpt_conversation_read", { conversationId: id });
    return payload;
  }
}
