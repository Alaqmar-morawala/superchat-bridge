# SuperHarness

A frontier-level coding-agent harness for **SuperApp** (superapp.chat): the AI in a
SuperApp thread gets real hands on this machine — bash, file editing, search, git —
and works autonomously on production-style software tasks until done and verified.

Built on the verified `../superapp.mjs` automation client (auth → REST → realtime
WebSocket). Zero new dependencies; Node builtins only.

```
superharness/
├── bin.mjs        # CLI: exec | watch | sessions | doctor
├── harness.mjs    # protocol parser/formatter + agent loop + JSONL transcripts
├── tools.mjs      # tool implementations (bash, fs, glob, grep, git)
├── safety.mjs     # path jail, command blocklist, output caps (hard, not optional)
├── protocol.md    # the system preamble served to the model
├── selftest.mjs   # local unit tests (no network)
├── calibrate.mjs  # protocol-compliance calibration across models
└── README.md
```

## Quick start

```bash
cd superapp-automation            # parent dir holds cookies.json (node capture_session.mjs)
cd superharness

node bin.mjs doctor               # auth, workspace, model presets
node bin.mjs exec "Build a Python CLI todo app with unittest tests, make them pass." \
     --root /tmp/myproject
node bin.mjs sessions             # every run is transcribed to .superharness/sessions/*.jsonl
node bin.mjs watch --new --root ~/myrepo   # bridge: type tasks in SuperApp's UI
```

## The two frontends

**`exec`** — one-shot agent run. Creates a *fresh, isolated SuperApp thread* per run
(clean model context, watchable live in the web UI at the printed URL), posts the
protocol preamble + your task, then loops: AI replies with tool calls → harness
executes them locally (jailed to `--root`) → results posted back → repeat until
the AI finishes with a verified summary.

**`watch`** — the UI bridge. Point it at any SuperApp thread
(`--channel <id>` from the thread URL, or `--new` to create one) and just type
tasks in SuperApp like normal chat. The daemon detects unsigned user messages,
runs the full agent loop against your filesystem, and streams progress back into
the same thread. A new human message mid-loop interrupts cleanly after the current
tool finishes. This turns the SuperApp web/mobile UI into a full coding-agent
frontend — conversations, files, and results live in the thread; execution
happens locally.

## Models (calibrated 2026-10-06)

| Preset | Catalog id | Protocol compliance |
|---|---|---|
| `sol` (default) | `openai/gpt-6.1-sol` | Excellent — strict protocol, batched tool calls, verified before DONE |
| `opus` | `anthropic/claude-opus-5-5` | Excellent — same flow, slightly faster |
| `astra` | `openai/gpt-6-astra` | **Refuses** — claims it "cannot access local tools"; unusable as loop driver |

Any raw catalog id is also accepted via `--model` (see `node bin.mjs doctor`).

## Tool set

**Real machine** — `bash` (jailed cwd, timeout, output tail cap), `read_file`,
`write_file`, `edit_file` (unique-match search/replace), `list_dir`, `glob`,
`grep` (ripgrep when present), `git` (status/diff/log/add/commit/branch/checkout/push/pull).

**Thread sandbox bridge** — the SuperApp thread has a server-side sandbox FS (the
"Files" panel) the agent can see natively. The harness moves data across:

- `sandbox_upload {path, sandbox_path?}` — push a local file **or folder** into the sandbox
- `sandbox_list` / `sandbox_read` — inspect sandbox contents from the real machine
- `sandbox_download {path}` / `sandbox_zip {paths[]}` — pull sandbox files into the workspace
- `save_attachment {attachment_id}` — save a file the human uploaded in chat
  (watch mode annotates incoming tasks with `[attachment: name attachment_id=…]`)

The agent's **built-in sandbox is allowed** (hybrid mode): it may create
artifacts/notes/previews there freely — but real-machine work (code, tests, git)
must go through ⟦TOOL⟧ lines, and DONE requires local verification. Sandbox-only
files never count as local work.

## Protocol (how the AI gets hands)

The model replies with machine-parseable blocks (rare unicode markers, no
collisions with code):

```
⟦TOOL⟧ {"id":"t1","name":"bash","args":{"command":"python3 -m unittest -v"}}
⟦END⟧
```

the harness executes and answers:

```
⟦RESULT⟧ {"id":"t1","ok":true,"exit":0}
… output tail …
⟦CONTINUE⟧ round=2/40
```

and the model finishes with `⟦DONE⟧ {"summary":…}` only after verification passes.
Non-protocol replies get one hard nudge (which also forbids using SuperApp's
built-in sandbox — that failure mode was observed and is explicitly countered).

**Stall handling is silent by design.** If the agent takes long (max-effort
thinking), the harness never sends pings — every automatic message re-wakes the
agent and floods the thread. It just keeps waiting (up to ~12 min per round) and
scans for an adopted reply: if a human sends "continue" in the thread meanwhile,
the agent answers that message and the harness adopts it and executes its tools.
If truly nothing arrives, the task fails with guidance; the thread is intact and
a manual "continue" (watch) or re-run (`exec --channel <id>`) resumes it.
Thread memory IS the conversation context — nothing is re-sent per round.

## Safety

Full-auto by design (no interactive prompts), but these are hard limits:

- **Path jail**: every file tool resolves inside `--root`; `..` and symlink
  escapes are rejected.
- **Command blocklist**: `sudo`, `rm -rf /`, `curl|sh`, fork bombs, `mkfs`,
  `dd of=/dev/…`, `shutdown`, etc. are refused before execution.
- **Timeouts**: per-command default 120s (max 600s); global task timeout 45min.
- **Output caps**: tool output truncated to tails so the thread stays lean.
- **Env scrubbing**: `SUPERAPP_*`, `*TOKEN`, `*SECRET`, `*PASSWORD`, `AWS_*`,
  `GH_*`, `NPM_TOKEN` are stripped from subprocess environments.
- **Auditability**: every round, tool call, and result lands in
  `.superharness/sessions/<id>.jsonl` (`node bin.mjs sessions show <id>`).

## Session transcripts

```
$ node bin.mjs sessions
sh-1791309279755-yonkg  2026-10-06T17:24:…  openai/gpt-6.1-sol  build a python cli todo app…
$ node bin.mjs sessions show sh-1791309279755-yonkg
```

## Known limits

- The AI thread grows over very long sessions; for marathons, start a new
  session (`exec` always starts fresh; `watch` reuses its bridge thread).
- Model-side nondeterminism exists; the nudge + verification-before-DONE rules
  catch drift, and transcripts make everything auditable.
- One automation client at a time per account: refreshes rotate the session
  cookie (see parent README). If the daemon dies with `session_rejected`,
  rerun `node ../capture_session.mjs` and restart it.
