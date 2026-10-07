# SuperApp Automation (superapp.chat)

Programmatic automation for [superapp.chat](https://superapp.chat/h/) — multi-model AI
chat + messaging app by Instabase ("SuperApp"). Reverse-engineered from the web app
(Expo/React-Native-Web SPA, version 1.213.0) and **verified end-to-end on 2026-10-06**,
including sending a message and receiving the AI's reply with zero UI interaction.

> **SuperHarness** — `superharness/` builds on this client to turn SuperApp into a full
> local coding agent (bash/files/git tools for its AI, CLI + UI-bridge modes). See
> [superharness/README.md](superharness/README.md).

```
superapp-automation/
├── capture_session.mjs  # one-time Playwright login -> cookies.json (httpOnly session)
├── superapp.mjs         # Node client: auth + REST + realtime WebSocket send + reply polling
├── examples/
│   ├── whoami.mjs       # session, workspaces, channels, models, unread counts
│   ├── chat.mjs         # send a message, wait for the AI answer
│   └── history.mjs      # dump a channel's recent messages
├── superharness/        # the coding-agent harness (see its README)
└── README.md
```

## Quick start

```bash
npm install playwright@1.63.0        # uses the chromium already in ~/.cache/ms-playwright
node capture_session.mjs             # login once with the test account -> cookies.json
node examples/whoami.mjs             # sanity check: your session, channels, models
node examples/chat.mjs "What is 2+2?"
```

Requires: Node 18+ (native fetch/WebSocket, tested on Node 24) and the `playwright`
npm package for the one-time login. No other dependencies.

Re-login when cookies expire (rare: the 24h JWT access token is cached on disk in
`cookies.token.json` and the client only refreshes — which rotates the session
cookie — when that token actually expires).

---

## What SuperApp is

A Slack-like workspace where every thread is also an AI conversation:

- **Home (`/h`)** — "Ask anything" composer; every send creates a new thread
  (auto-titled from the first message).
- **Sidebar tabs** — Inbox / Threads / Channels / DMs; plus Library (`/l`):
  Recents / Artifacts / Drives, and Activities (`/n`).
- **Thread view (`/h/<channelId>`)** — messages, agent progress ("Typing"),
  composer ("Send a message"), model picker, effort picker.
- **Settings (`/settings/…`)** — Account, Preferences, People, Connected apps,
  Models, Custom emoji, Webhooks.
- **Models**: Auto (router) + GPT-6 Astra / GPT-6.1 Sol / GPT-6 Luna /
  Muse Spark 1.3 / Grok 4.7 / Claude Opus 5.5 / Claude Sonnet 5.5 /
  Gemini 3.8 Flash / Gemini 3.5 Flash Lite.
- **Reasoning efforts**: adaptive, low, medium, high, xhigh, max.

Key ids of the test account (session-scoped, re-read them via the API):

| Thing | Value |
|---|---|
| user id | `d314b926-f539-4437-ab85-444a9bce5d35` |
| workspace "My Workspace" | `db3ba81d-20d9-4818-985c-8c6e1b9e6dde` |
| Home thread channel | `9071aa0e-dad9-4079-bd77-2a2d2c58521a` |
| session cookie | `__Host-sa-account-0` (httpOnly, **rotated by every refresh**) |
| Auth0 sub | `auth0\|6ac520226e3b411d507fb288` |
| Auth0 domain / clientId | `auth.superapp.chat` / `1fNJhnWrrP3oKYkvOWcE3JSEmDWZ7gTA` |

Model ids (from `/models/catalog`, usable as `mode` in send_message):

```
superagent-pro (Auto router, default)     openai/gpt-6-astra      openai/gpt-6.1-sol
openai/gpt-6-luna        meta/muse-spark-1.3      xai/grok-4.7
anthropic/claude-opus-5-5    anthropic/claude-sonnet-5-5
gemini/gemini-3.8-flash      gemini/gemini-3.5-flash-lite    openai/gpt-5.4
```

---

## Auth flow (the important part)

All auth state lives in **httpOnly cookies on superapp.chat** (JS can't read them;
`document.cookie` is empty). The SPA then mints short-lived bearer tokens:

```
1. GET  https://superapp.chat/api/v1/auth/accounts
      headers: X-Requested-With: superapp        (+ Cookie header)
      -> {"accounts":[{"session_id":"<opaque session id>","email":"…",…}]}

2. POST https://superapp.chat/api/v1/auth/refresh
      headers: Content-Type: application/json
               X-Requested-With: superapp
               X-Active-Session: <session_id>    (+ Cookie header)
      body: {}
      -> {"access_token":"<24h Auth0 RS256 JWT>"}

3. Every /api/v1/* request:
      Authorization: Bearer <access_token>
      Accept: application/json
      Content-Type: application/json   (when body)
      X-Agent-Progress-Version: 1     (the SPA always sends it)
```

Without `X-Requested-With: superapp` the auth endpoints return
`403 invalid_request_origin_or_shape`; without a valid token the API returns
`401 {"error":"Authentication required"}`.

## REST API (base `https://superapp.chat/api/v1`)

Verified endpoints (snake_case request bodies; the SPA converts camelCase→snake_case
automatically, so raw HTTP callers should send snake_case):

| Method + path | Purpose |
|---|---|
| `GET /auth/accounts` | list sessions (session_id per account) |
| `POST /auth/refresh` | mint access_token (needs X-Active-Session) |
| `GET /users/me/workspaces` | workspaces + active_workspace_id |
| `GET /users/me/state`, `POST /users/me/state/heartbeat` | presence state / heartbeat |
| `GET /users/statuses` | `POST` with `{"user_ids":[…]}` — member info |
| `GET /notifications/unread_count` | global + per-channel unread counts |
| `PATCH /notifications/mark_all_read?channel_id=<id>` | mark read |
| `POST /channels/<id>/last_read_message` | body `{"message_id":"…"}` |
| `GET /channels/list?scope=all` | all rooms (threads, channels, DMs) |
| `GET /channels/<id>/meta` | channel settings |
| `POST /channels` | create a channel/thread (verified: `{name}` → `{channel_id}`) |
| `POST /channels/<id>/members/by-ids` | body `{"ids":[user ids]}` |
| `POST /fs/<roomId>/upload_folder` | multipart upload into the thread sandbox (`files` entries, names may contain `/` for folders; `upload_path` field) |
| `GET /fs/<roomId>/list_dir/<path>` | list thread sandbox |
| `GET /fs/<roomId>/read/<path>` | read sandbox text file |
| `POST /fs/<roomId>/write` | body `{"content","format","filename"}` — write sandbox text file |
| `GET /fs/<roomId>/download/data/<path>` | download a sandbox file |
| `POST /fs/<roomId>/download_zip` | body `{"filePaths":[…],"zipName"}` → zip bytes |
| `GET /messages/<roomId>/attachments/<attachmentId>` | download a chat attachment |
| `GET /messages/<channelId>/history?limit=50&direction=before&include_deleted=false&replies_view=false` | message history (newest first) |
| `GET /drafts/<channelId>` | composer draft (404 when none) |
| `PUT /channels/landing-live` / `PUT /channels/landing-thread` | "last opened" pointers |
| `GET /models/catalog?reasoning_level=…&workspace_id=…` | model picker data |
| `GET /workspaces/<wsId>/realtime/ticket` | 30s WebSocket ticket |
| `GET /notifications/sse/ticket` | SSE notifications ticket |
| `GET /skills/status`, `GET /memories/status` | feature availability |
| `GET /artifacts?type_version=2&activity_scope=my` | Library artifacts |
| `GET /drives/my` | drives |
| `GET /api/v1/public/workspaces/<wsId>/emojis` | custom emoji |

Message object shape (from history):

```jsonc
{
  "id": "01a1121a-3b9b-…", "role": "assistant" | "user",
  "content": [
    { "type": "router_rationale", "text": "On it", "routing_route": "fast_path", … },
    { "type": "text", "msg_type": "answer", "text": "AUTOMATION_TEST_OK" }
  ],
  "thread_root_id": "…", "triggering_message_id": "…",
  "agent_session": { "session_id": "…", "state": "completed" | "running" | "failed", … },
  "created_at": "…", "user_name": "SuperApp" | "<you>", "reactions": {}
}
```

## Sending messages — realtime WebSocket

There is **no HTTP send endpoint**; the SPA sends messages over its gateway socket.

```
1. GET /api/v1/workspaces/<wsId>/realtime/ticket   (Bearer auth)
      -> {"ticket":"<uuid>","expires_in":30}

2. wss://superapp.chat/ws/v1/gateway/?ticket=<ticket>
      (note: /ws/v1/… at the ROOT, not under /api/)

3. Envelope format (JSON, keys snake_case):
   {"v":1,"type":"command","payload":{"name":"<cmd>","stream_key":"<key>","args":{…}}}
```

Verified commands (stream_key = `channel:<channelId>::chat`):

| Command | args |
|---|---|
| `send_message` | `{message, file_paths: [], original_message_id: "<epochMs>-0000", enable_connectors: true, is_broadcast: false, mode: "superagent-pro", reasoning_effort: "adaptive", content_mode: "edit", timezone: "Asia/Calcutta", draft_sync_enabled: true, draft_revision: 0}` |
| `typing_started` / `typing_stopped` | `{channel_id}` |
| keepalive | `{"v":1,"type":"ping","payload":{}}` → replies `{"v":1,"type":"pong"}` |

Server events (inbound envelopes `{"v":1,"type":"event","payload":{…}}`):

- `payload.data.event === "message_accepted"` with
  `{message_id, original_message_id, thread_root_id, channel_id, agent_setting}` —
  correlates your send with the created thread (match on `original_message_id`).
- Streaming agent progress / message updates arrive as further events
  (also mirrored via `GET /messages/<id>/history` — the client polls this instead).

`mode` values observed: `superagent-pro`. `reasoning_effort` values:
`adaptive, low, medium, high, xhigh, max`.

## UI automation notes (browser driving)

- Login: `/h/` → "Continue with Email" → Auth0 universal login
  (email + password + Continue) → back to `/h`.
- Composer accessible name: **"Ask anything"** on Home, **"Send a message"** inside a
  thread view. Send button enables once text is present.
- Model/effort pickers: buttons named `Model: Auto`, `Effort: Adaptive`;
  menu offers models + "Manage models…" (opens `/settings/models`).
- The SPA exposes `window.__RUNTIME_ENV__` (env-config.js) with the Auth0 config.
- The React Query cache sits in `localStorage["superapp-rq-cache"]`.

## Gotchas

- **Session-cookie rotation**: `POST /auth/refresh` rotates `__Host-sa-account-0`
  (the previous value stops working, and concurrent refreshes can get
  `401 session_rejected`). The client therefore caches the 24h JWT in
  `cookies.token.json` and refreshes only on expiry, persisting rotated cookies
  back into `cookies.json` after every refresh. Don't run several clients
  against one `cookies.json` at the same moment; keep the browser tab closed
  while running long automations if you see `session_rejected`.
- **Origin header**: non-browser HTTP clients must send `Origin: https://superapp.chat`
  (and `X-Requested-With: superapp` on auth endpoints) or auth calls fail with
  `403 invalid_request_origin_or_shape`.
- Ticket TTL is 30s — mint right before connecting (the client does this).
- History is newest-first; replies correlate via `thread_root_id`.
- The AI reply is complete when `agent_session.state === "completed"`
  (or the message has no `agent_session`).
- `mode` in send_message accepts either `superagent-pro` (Auto) or a specific
  model id from the catalog.
- Rate limits / ToS: this is a third-party service — keep automation polite and
  within the terms you agreed to.
