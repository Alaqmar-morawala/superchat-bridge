# SuperHarness — agent context (exec mode)

You have access to **SuperHarness**: a tool that lets you delegate software tasks to a
frontier AI agent (GPT-6.1 Sol / Claude Opus 5.5) running on superapp.chat, which works
autonomously on THIS machine with real tools — bash, file read/write/edit, glob, grep,
git — inside a path-jailed workspace, until it verifies the result and reports a summary.

## Prerequisites (already set up on this machine)

- Package location: `<repo-root>/superharness/`
- Auth: `../cookies.json` (session cookie). If auth ever fails with `session_rejected`,
  STOP and tell the user to run: `node capture_session.mjs` (from the package root).
- Runtime: Node 18+. No npm deps needed for exec.

## Running a task (exec = one-shot, runs to completion)

```bash
cd <repo-root>/superharness

node bin.mjs exec "<task description>" \
  --root /absolute/path/to/the/project \
  --model sol --effort max
```

- The task string is plain natural language. Be specific and complete — the remote
  agent starts with ZERO context about your project. State the goal, constraints,
  and how to verify success (it runs tests/builds itself before finishing).
- `--root` is the workspace jail: the agent can touch ONLY paths under it.
- `--model`: `sol` (default, GPT-6.1 Sol), `opus` (Claude Opus 5.5). Never `astra`
  (refuses tool calls). `--effort`: `adaptive` (default) … `max` (deepest, slower).
- `--max-rounds N` (default 40) and `--timeout-mins M` (default 45) bound the run.
- The run prints a thread URL (`https://superapp.chat/h/<id>`) — a live view of the
  agent working. Exit code 0 = task completed (agent reported ⟦DONE⟧ with a summary).

## Continuing an existing thread (context carries over)

The agent's memory lives server-side in the thread. To follow up without re-explaining:

```bash
node bin.mjs exec "now add tests for the CLI" \
  --root /absolute/path/to/project \
  --channel <thread-id-from-the-previous-run> \
  --model sol --effort max
```

- `--channel <id>` continues that thread and skips the protocol preamble (already known).
- If a run dies or times out, NOTHING is lost: re-run with the same `--channel` and a
  task like "continue where you left off / re-emit your last ⟦TOOL⟧ lines".

## Auditing

Every round, tool call, and result is transcribed:

```bash
node bin.mjs sessions                 # list sessions
node bin.mjs sessions show <id>       # replay one
node bin.mjs doctor                   # auth + model health check
```

## Hard rules (do not violate)

1. **One harness process at a time.** Never run exec/watch in parallel against the same
   account — session rotation causes auth failures. Check with `pgrep -af "bin.mjs"`.
2. **Never type into the SuperApp thread while an exec is mid-run** — it derails the
   agent mid-task (the harness will adopt the reply, but rounds get messy).
3. Full-auto execution: there are NO confirmation prompts. The agent runs real bash and
   edits real files under `--root`. Hard safety: path jail (symlink escapes blocked),
   catastrophic-command blocklist (sudo, rm -rf /, curl|sh …), 120s per-command timeout,
   secrets scrubbed from subprocess env. Protect unsaved work before launching.
4. If auth fails: stop, tell the user to re-login (`node capture_session.mjs` from the
   package root). Never retry auth in a loop — that extends the lockout.
5. Messages sent to the thread are visible to the user in the SuperApp UI; keep task
   text clean of secrets.

## What the remote agent can and cannot do

- CAN: run bash (jailed to --root), read/write/edit files, glob/grep, git
  (status/diff/log/add/commit/branch/checkout/push), upload/download files between the
  workspace and its SuperApp sandbox, and SEE images (`sandbox_upload {view:true}`).
- CANNOT: touch anything outside `--root`, run interactive prompts, access GUIs.
- It finishes only after verifying its work (tests/builds pass). The final summary
  states what was done and how it was verified.

## Typical workflow

1. `node bin.mjs exec "Build X with tests; make them pass" --root <dir> --model sol --effort max`
2. Read the final summary + exit code; inspect changed files in `--root`.
3. Follow-ups: same command with `--channel <id>` and the next task.
4. For continuous back-and-forth from the SuperApp web UI instead, the user runs
   `node bin.mjs watch --channel <id> --root <dir>` (bridge daemon) — then tasks typed
   in the SuperApp UI execute locally.
