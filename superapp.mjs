/**
 * SuperApp (superapp.chat) automation client — zero dependencies (Node 18+,
 * tested on Node 24: native fetch + native WebSocket).
 *
 * Auth model (reverse-engineered from the web app, verified 2026-10-06):
 *   1. A session cookie on superapp.chat (httpOnly) is minted at browser login.
 *   2. GET  /api/v1/auth/accounts          (cookie + X-Requested-With: superapp)
 *        -> { accounts: [{ session_id, ... }] }
 *   3. POST /api/v1/auth/refresh           (cookie + X-Requested-With: superapp
 *        + X-Active-Session: <session_id>, body {})  -> { access_token }  (24h JWT)
 *   4. Every /api/v1/* call: Authorization: Bearer <access_token>
 *   5. Realtime (message sending) goes over a WebSocket:
 *        GET /api/v1/workspaces/<wsId>/realtime/ticket  -> { ticket } (30s TTL)
 *        wss://superapp.chat/ws/v1/gateway/?ticket=<ticket>
 *        envelope: { v:1, type:"command", payload:{ name, stream_key, args } }
 *
 * Get cookies.json via `python3 capture_session.py`, or export SUPERAPP_COOKIE
 * with the raw Cookie header copied from DevTools (Application -> Cookies).
 */

const BASE = "https://superapp.chat";
const API = `${BASE}/api/v1`;
const WS_GATEWAY = "wss://superapp.chat/ws/v1/gateway/";

// the server validates Origin on auth endpoints (403 invalid_request_origin_or_shape)
const ORIGIN_HEADERS = { Origin: BASE, Referer: `${BASE}/h` };

const DEFAULT_WORKSPACE_ID = "db3ba81d-20d9-4818-985c-8c6e1b9e6dde"; // "My Workspace"
const DEFAULT_TIMEZONE = "Asia/Calcutta";

function b64urlDecode(seg) {
  const b = Buffer.from(seg, "base64");
  return JSON.parse(b.toString("utf8"));
}

export class SuperAppClient {
  /**
   * @param {object} opts
   * @param {string|Map<string,string>} opts.cookies  raw Cookie header string, or name->value map
   * @param {string} [opts.workspaceId]
   * @param {string} [opts.timezone]
   */
  constructor({ cookies, workspaceId, timezone = DEFAULT_TIMEZONE, cookieFile } = {}) {
    this.cookieJar =
      cookies instanceof Map ? cookies : SuperAppClient.parseCookieHeader(cookies ?? "");
    if (this.cookieJar.size === 0) {
      throw new Error(
        "No cookies provided. Run capture_session.mjs and load cookies.json, or set SUPERAPP_COOKIE.",
      );
    }
    this._workspaceId = workspaceId ?? null; // lazily resolved from /users/me/workspaces
    this.timezone = timezone;
    this.cookieFile = cookieFile; // when set, rotated session cookies persist back to disk
    this._jarDirty = false;
    this._token = null; // { value, expiresAtMs }
    this._sessionId = null;
    this._ws = null;
    this._pingTimer = null;
  }

  /** The account's active workspace id (auto-discovered once). */
  async currentWorkspaceId() {
    if (this._workspaceId) return this._workspaceId;
    const ws = await this.workspaces();
    this._workspaceId = ws.active_workspace_id ?? ws.workspaces?.[0]?.id;
    if (!this._workspaceId) throw new Error("no active workspace found for this account");
    return this._workspaceId;
  }

  static parseCookieHeader(header) {
    const jar = new Map();
    for (const part of String(header).split(/;\s*/)) {
      const i = part.indexOf("=");
      if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    return jar;
  }

  /** Load from a Playwright storage-state file (see capture_session.mjs). */
  static async fromCookieFile(path = "cookies.json", opts = {}) {
    const fs = await import("node:fs/promises");
    const state = JSON.parse(await fs.readFile(path, "utf8"));
    const jar = new Map();
    for (const c of state.cookies ?? []) {
      // only cookies a browser would send to superapp.chat itself
      if (c.domain === "superapp.chat" || c.domain === ".superapp.chat") {
        jar.set(c.name, c.value);
      }
    }
    return new SuperAppClient({ cookies: jar, cookieFile: path, ...opts });
  }

  /**
   * IMPORTANT: /api/v1/auth/refresh ROTATES the __Host-sa-account-0 session
   * cookie (old value becomes invalid). Call save() after API activity so the
   * newest cookie lands back in cookies.json; otherwise the next run starts
   * with a dead cookie (401 session_rejected).
   */
  async save() {
    if (!this.cookieFile || !this._jarDirty) return;
    const fs = await import("node:fs/promises");
    const state = JSON.parse(await fs.readFile(this.cookieFile, "utf8"));
    for (const c of state.cookies ?? []) {
      if (this.cookieJar.has(c.name)) c.value = this.cookieJar.get(c.name);
    }
    await fs.writeFile(this.cookieFile, JSON.stringify(state, null, 2));
    this._jarDirty = false;
  }

  cookieHeader() {
    return [...this.cookieJar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  // ---------------------------------------------------------------- auth

  /** GET /api/v1/auth/accounts -> [{ session_id, account_id, email, ... }] */
  async accounts() {
    const r = await fetch(`${API}/auth/accounts`, {
      headers: {
        "X-Requested-With": "superapp",
        Accept: "application/json",
        Cookie: this.cookieHeader(),
        ...ORIGIN_HEADERS,
      },
    });
    if (!r.ok) throw new Error(`accounts failed: HTTP ${r.status}`);
    const data = await r.json();
    this._applySetCookies(r);
    return data.accounts;
  }

  async sessionId() {
    if (this._sessionId) return this._sessionId;
    const accounts = await this.accounts();
    if (!accounts?.length) throw new Error("No sessions in /auth/accounts — cookie expired; re-run capture_session.py");
    this._sessionId = accounts[0].session_id;
    return this._sessionId;
  }

  _applySetCookies(res) {
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      if (i > 0) {
        this.cookieJar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        this._jarDirty = true;
      }
    }
  }

  /** Fresh (or cached) JWT access token. Cached on disk to minimize refreshes:
   *  each refresh may rotate the session cookie, so we refresh only on expiry. */
  async token({ force = false } = {}) {
    if (!force && this._token && Date.now() < this._token.expiresAtMs) return this._token.value;
    if (!force) {
      const cached = await this._loadTokenFromDisk();
      if (cached && Date.now() < cached.expiresAtMs) {
        this._token = cached;
        return cached.value;
      }
    }
    const sid = await this.sessionId();
    const res = await fetch(`${API}/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "superapp",
        "X-Active-Session": sid,
        Cookie: this.cookieHeader(),
        ...ORIGIN_HEADERS,
      },
      body: "{}",
    });
    this._applySetCookies(res);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `refresh failed: HTTP ${res.status} ${body.slice(0, 200)}` +
          (body.includes("session_rejected") || body.includes("invalid_session")
            ? " — your cookie is stale/rotated. Run `node capture_session.mjs` again."
            : ""),
      );
    }
    const { access_token } = await res.json();
    const { exp } = b64urlDecode(access_token.split(".")[1]);
    this._token = { value: access_token, expiresAtMs: (exp - 60) * 1000 };
    await this._saveTokenToDisk();
    await this.save();
    return access_token;
  }

  get _tokenFile() {
    return this.cookieFile ? this.cookieFile.replace(/\.json$/, "") + ".token.json" : null;
  }

  async _loadTokenFromDisk() {
    if (!this._tokenFile) return null;
    try {
      const fs = await import("node:fs/promises");
      const { access_token, expiresAtMs } = JSON.parse(await fs.readFile(this._tokenFile, "utf8"));
      if (!access_token || typeof expiresAtMs !== "number") return null;
      return { value: access_token, expiresAtMs };
    } catch {
      return null;
    }
  }

  async _saveTokenToDisk() {
    if (!this._tokenFile || !this._token) return;
    try {
      const fs = await import("node:fs/promises");
      await fs.writeFile(
        this._tokenFile,
        JSON.stringify({ access_token: this._token.value, expiresAtMs: this._token.expiresAtMs }, null, 2),
      );
    } catch { /* best-effort cache */ }
  }

  // ---------------------------------------------------------------- REST

  async request(method, path, { query = {}, body, retry401 = true, headers: extraHeaders } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      else if (v !== undefined) qs.append(k, String(v));
    }
    const url = `${API}${path}${qs.size ? `?${qs}` : ""}`;
    const token = await this.token();
    const isMultipart = body instanceof FormData || Buffer.isBuffer(body);
    const res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined && !isMultipart ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${token}`,
        "X-Agent-Progress-Version": "1",
        Cookie: this.cookieHeader(),
        ...ORIGIN_HEADERS,
        ...extraHeaders,
      },
      body: body === undefined ? undefined : isMultipart ? body : JSON.stringify(body),
    });
    this._applySetCookies(res);
    if (res.status === 401 && retry401) {
      this._token = null;
      this._sessionId = null;
      if (this._tokenFile) {
        try { (await import("node:fs/promises")).rm(this._tokenFile, { force: true }); } catch {}
      }
      return this.request(method, path, { query, body, retry401: false, headers: extraHeaders });
    }
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Binary request (uploads/downloads) — returns the raw Response. */
  async requestBinary(method, path, { query = {}, body } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      else if (v !== undefined) qs.append(k, String(v));
    }
    const url = `${API}${path}${qs.size ? `?${qs}` : ""}`;
    const token = await this.token();
    return fetch(url, {
      method,
      headers: {
        ...(Buffer.isBuffer(body) ? { "Content-Type": "application/octet-stream" } : {}),
        Authorization: `Bearer ${token}`,
        Cookie: this.cookieHeader(),
        ...ORIGIN_HEADERS,
      },
      body,
    });
  }

  get(path, query) { return this.request("GET", path, { query }); }
  post(path, body) { return this.request("POST", path, { body: body ?? {} }); }
  patch(path, body) { return this.request("PATCH", path, { body: body ?? {} }); }
  put(path, body) { return this.request("PUT", path, { body: body ?? {} }); }
  del(path) { return this.request("DELETE", path); }

  // ---------------------------------------------------------------- domain helpers

  /** GET /api/v1/users/me/workspaces */
  workspaces() { return this.get("/users/me/workspaces"); }

  /** GET /api/v1/channels/list?scope=all — rooms incl. threads/channels/DMs */
  async channels(scope = "all") {
    const data = await this.get("/channels/list", { scope });
    return data.rooms;
  }

  /** GET /api/v1/channels/<id>/meta */
  channelMeta(channelId) { return this.get(`/channels/${channelId}/meta`); }

  /** POST /api/v1/channels — create a fresh channel for an isolated session. */
  async createChannel(name = "SuperHarness session") {
    const data = await this.post("/channels", { name });
    return data.channel_id;
  }

  // ------------------------------------------------- thread sandbox FS (/api/v1/fs/<roomId>/…)

  /** Upload file(s) into the thread's sandbox. entries: [{ name (may contain '/'), data: Buffer }]. */
  async sandboxUpload(channelId, entries, uploadPath = "") {
    const fd = new FormData();
    for (const e of entries) {
      fd.append("files", new Blob([e.data]), e.name);
    }
    fd.append("upload_path", uploadPath);
    return this.request("POST", `/fs/${channelId}/upload_folder`, { body: fd });
  }

  /** List the thread sandbox. */
  sandboxList(channelId, path = "") {
    return this.request("GET", `/fs/${channelId}/list_dir/${path}`);
  }

  /** Read a text file from the thread sandbox. */
  sandboxRead(channelId, path) {
    return this.request("GET", `/fs/${channelId}/read/${path}`);
  }

  /** Download a sandbox file's bytes. */
  async sandboxDownload(channelId, path) {
    const res = await this.requestBinary("GET", `/fs/${channelId}/download/data/${path}`);
    if (!res.ok) throw new Error(`download ${path} -> HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Download several sandbox files as one zip (returns bytes). */
  async sandboxDownloadZip(channelId, filePaths, zipName = "download.zip") {
    const res = await this.requestBinary("POST", `/fs/${channelId}/download_zip`, {
      body: Buffer.from(JSON.stringify({ filePaths, zipName })),
    });
    if (!res.ok) throw new Error(`download_zip -> HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Download a chat attachment (file the human uploaded to a message). */
  async attachmentDownload(channelId, attachmentId) {
    const res = await this.requestBinary("GET", `/messages/${channelId}/attachments/${attachmentId}`);
    if (!res.ok) throw new Error(`attachment ${attachmentId} -> HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** GET /api/v1/models/catalog — model ids + reasoning levels */
  async models() {
    const levels = ["adaptive", "low", "medium", "high", "xhigh", "max"];
    const data = await this.get("/models/catalog", {
      reasoning_level: levels,
      workspace_id: await this.currentWorkspaceId(),
    });
    return data;
  }

  /** GET /api/v1/notifications/unread_count */
  unread() { return this.get("/notifications/unread_count"); }

  /**
   * GET /api/v1/messages/<channelId>/history (newest first).
   * opts: { limit=50, before, includeDeleted=false, repliesView=false }
   */
  async history(channelId, { limit = 50, before, includeDeleted = false, repliesView = false } = {}) {
    const data = await this.get(`/messages/${channelId}/history`, {
      limit,
      direction: "before",
      include_deleted: includeDeleted,
      replies_view: repliesView,
      ...(before ? { before } : {}),
    });
    return data.conversation?.messages ?? [];
  }

  // ---------------------------------------------------------------- realtime / sending

  /** Mint a 30s realtime ticket. */
  async realtimeTicket() {
    return this.get(`/workspaces/${await this.currentWorkspaceId()}/realtime/ticket`);
  }

  /**
   * Open the realtime gateway. Returns the WebSocket (already OPEN).
   * Sends pings every 25s; call closeGateway() when done.
   */
  async openGateway() {
    if (this._ws && this._ws.readyState === 1) return this._ws;
    const { ticket } = await this.realtimeTicket();
    const ws = new WebSocket(`${WS_GATEWAY}?ticket=${ticket}`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("gateway connect failed (ticket TTL is 30s — mint fresh)"));
    });
    ws.onmessage = (ev) => this._onGatewayMessage?.(ev);
    this._ws = ws;
    this._pingTimer = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ v: 1, type: "ping", payload: {} }));
    }, 25000);
    return ws;
  }

  closeGateway() {
    clearInterval(this._pingTimer);
    this._ws?.close();
    this._ws = null;
  }

  /**
   * Low-level command send. Use send() for messages.
   */
  async gatewayCommand(name, streamKey, args) {
    const ws = await this.openGateway();
    ws.send(JSON.stringify({
      v: 1,
      type: "command",
      payload: { name, stream_key: streamKey, args },
    }));
  }

  /**
   * Send a chat message to a channel/thread. Resolves once the server accepts it.
   * @returns {Promise<{messageId, threadRootId}>}
   */
  async send(channelId, text, {
    reasoningEffort = "adaptive",
    mode = "superagent-pro",
    enableConnectors = true,
    isBroadcast = false,
    extraArgs = {},
  } = {}) {
    const originalMessageId = `${Date.now()}-0000`;
    const ws = await this.openGateway();

    const accepted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("message_accepted not received in 15s")), 15000);
      const prev = this._onGatewayMessage;
      this._onGatewayMessage = (ev) => {
        prev?.(ev);
        try {
          const msg = JSON.parse(ev.data);
          const d = msg?.payload?.data;
          if (msg.type === "event" && d?.event === "message_accepted" && d.original_message_id === originalMessageId) {
            clearTimeout(timer);
            this._onGatewayMessage = prev;
            resolve({
              messageId: d.message_id,
              threadRootId: d.thread_root_id,
              agentSetting: d.agent_setting ?? null, // what the server actually assigned
              channelId: d.channel_id ?? null,
            });
          }
        } catch { /* non-JSON frame */ }
      };
    });

    ws.send(JSON.stringify({
      v: 1,
      type: "command",
      payload: {
        name: "send_message",
        stream_key: `channel:${channelId}::chat`,
        args: {
          message: text,
          file_paths: [],
          original_message_id: originalMessageId,
          enable_connectors: enableConnectors,
          is_broadcast: isBroadcast,
          mode,
          reasoning_effort: reasoningEffort,
          content_mode: "edit",
          timezone: this.timezone,
          draft_sync_enabled: true,
          draft_revision: 0,
          ...extraArgs,
        },
      },
    }));
    return accepted;
  }

  // ---------------------------------------------------------------- reply waiting

  /** Extract the final answer text from a history message object. */
  static answerText(msg) {
    const blocks = (msg.content ?? []).filter((b) => b.type === "text");
    const answer = blocks.filter((b) => b.msg_type === "answer");
    const pick = answer.length ? answer : blocks;
    return pick.map((b) => b.text).join("\n").trim();
  }

  /**
   * Poll history until the assistant finishes its reply for a thread.
   * @returns {Promise<{text, message}>}
   */
  async waitForReply(channelId, threadRootId, { timeoutMs = 120000, pollMs = 2000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msgs = await this.history(channelId, { limit: 50 });
      const reply = msgs.find(
        (m) => m.role === "assistant" && m.thread_root_id === threadRootId,
      );
      const done = reply && (!reply.agent_session || reply.agent_session.state === "completed" || reply.agent_session.state === "failed");
      if (done) {
        if (reply.agent_session?.state === "failed") throw new Error("agent session failed for thread " + threadRootId);
        return { text: SuperAppClient.answerText(reply), message: reply };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`waitForReply timed out after ${timeoutMs}ms`);
  }

  /** One-shot: send + wait for the assistant's answer. */
  async ask(channelId, text, opts = {}) {
    const { threadRootId } = await this.send(channelId, text, opts.sendOpts ?? {});
    const reply = await this.waitForReply(channelId, threadRootId, opts);
    return { ...reply, threadRootId };
  }
}

export default SuperAppClient;
