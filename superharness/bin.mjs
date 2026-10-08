#!/usr/bin/env node
/**
 * SuperHarness CLI — turn SuperApp into a full local coding agent.
 *
 *   node bin.mjs exec "task" [--model astra|sol|opus|<id>] [--root DIR] [--channel ID]
 *                            [--max-rounds N] [--timeout-mins M]
 *   node bin.mjs watch --channel ID [--root DIR] [--model ...]   # bridge a SuperApp thread
 *   node bin.mjs sessions [show ID]
 *   node bin.mjs doctor
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import SuperAppClient from "../superapp.mjs";
import { AgentLoop, listSessions, parseReply } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTO_DIR = path.join(HERE, "..");
const COOKIE_FILE = path.join(AUTO_DIR, "cookies.json");
const HOME_CHANNEL = "9071aa0e-dad9-4079-bd77-2a2d2c58521a";

const MODEL_PRESETS = {
  astra: "openai/gpt-6-astra",
  sol: "openai/gpt-6.1-sol",
  opus: "anthropic/claude-opus-5-5",
};
// calibration 2026-10-06: sol + opus follow the tool protocol flawlessly;
// astra refuses to invoke local tools ("I cannot access ..."). Default: sol.
const DEFAULT_MODEL = "sol";
const EFFORT_LEVELS = ["adaptive", "low", "medium", "high", "xhigh", "max"];

// ------------------------------------------------------------- tiny arg parse

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const C = { dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`, bad: (s) => `\x1b[31m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, hi: (s) => `\x1b[1;36m${s}\x1b[0m` };

function usage() {
  console.log(`SuperHarness — SuperApp coding-agent harness

  node bin.mjs exec "task" [options]     run one task to completion
  node bin.mjs watch --channel ID        bridge a SuperApp thread (UI tasks -> local tools)
  node bin.mjs sessions [show ID]        list / inspect session transcripts
  node bin.mjs doctor                    check auth, models, workspace

Options:
  --model astra|sol|opus|<catalog-id>   default: sol (calibrated; astra refuses tool calls)
  --effort adaptive|low|medium|high|xhigh|max   reasoning effort (default: adaptive)
  --root DIR                            workspace root (default: cwd)
  --channel ID                          continue an older harness thread (task only, no preamble
                                        re-send; add --preamble to force it, e.g. for non-harness threads)
  --new                                 watch: create the bridge thread instead of --channel
  --backlog                             watch: also process tasks typed before startup
  --max-rounds N                        default 40
  --timeout-mins M                      default 45
`);
}

async function loadClient() {
  if (!fs.existsSync(COOKIE_FILE)) {
    console.error(C.bad("cookies.json not found — run: node capture_session.mjs"));
    process.exit(1);
  }
  const client = await SuperAppClient.fromCookieFile(COOKIE_FILE);
  try {
    await client.token();
  } catch (e) {
    if (/session_rejected|invalid_session|Authentication required/i.test(e.message)) {
      if (process.env.SUPERAPP_EMAIL && process.env.SUPERAPP_PASSWORD) {
        console.log(C.warn("Session expired. Auto-logging in via capture_session.mjs..."));
        const { spawnSync } = await import("node:child_process");
        const res = spawnSync("node", ["capture_session.mjs"], { cwd: AUTO_DIR, stdio: "inherit" });
        if (res.status === 0) {
          console.log(C.ok("Auto-relogin succeeded! Loading fresh session..."));
          return SuperAppClient.fromCookieFile(COOKIE_FILE);
        }
      }
      console.error(C.bad(`\nAuth session expired (${e.message.split("\n")[0]}).`));
      console.error(C.bad("→ If your browser is open: copy __Host-sa-account-0 cookie value, or run: node ../capture_session.mjs"));
      process.exit(1);
    }
    throw e;
  }
  return client;
}

function resolveChannelId(input) {
  if (!input) return null;
  input = String(input).trim();
  const sessionsDir = path.join(AUTO_DIR, ".superharness", "sessions");

  // "last" keyword -> pick the latest session
  if (input === "last") {
    let files = [];
    try { files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")); } catch {}
    if (!files.length) throw new Error("No previous sessions found to resume from.");
    files.sort((a, b) => {
      try {
        return fs.statSync(path.join(sessionsDir, b)).mtimeMs - fs.statSync(path.join(sessionsDir, a)).mtimeMs;
      } catch { return 0; }
    });
    for (const f of files) {
      try {
        const firstLine = fs.readFileSync(path.join(sessionsDir, f), "utf8").split("\n")[0];
        const meta = JSON.parse(firstLine);
        if (meta.channelId) {
          const res = resolveChannelId(meta.channelId);
          if (res) {
            console.log(C.dim(`  resolved "last" -> session ${meta.sessionId} [thread ${res}]`));
            return res;
          }
        }
      } catch {}
    }
    throw new Error("Could not find a valid channel in previous sessions.");
  }

  // 1. Thread URL: https://superapp.chat/h/<uuid>
  const urlM = input.match(/\/h\/([0-9a-f-]{36})/i);
  if (urlM) return urlM[1];

  // 2. Direct UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
    return input;
  }

  // 3. Session ID (e.g. sh-1791434269409-t1tua)
  const sessId = input.replace(/\.jsonl$/, "");
  const sessFile = path.join(sessionsDir, `${sessId}.jsonl`);
  if (fs.existsSync(sessFile)) {
    try {
      const firstLine = fs.readFileSync(sessFile, "utf8").split("\n")[0];
      const meta = JSON.parse(firstLine);
      if (meta.channelId) {
        const resolved = resolveChannelId(meta.channelId);
        if (resolved) {
          console.log(C.dim(`  resolved session ${sessId} -> thread ${resolved}`));
          return resolved;
        }
      }
    } catch {}
  }

  if (input.startsWith("sh-")) {
    throw new Error(`Session ID "${input}" not found in ${sessionsDir}. Run 'node bin.mjs sessions' to see valid sessions.`);
  }

  throw new Error(`Invalid channel or session ID: "${input}". Provide a thread UUID, a thread URL, or a session ID (sh-...).`);
}

// ------------------------------------------------------------- renderer

function makeEvents(root) {
  const rel = (p) => path.isAbsolute(p) ? p : path.join(root, p);
  return (ev) => {
    switch (ev.type) {
      case "task-start": console.log(C.hi(`\n▶ task ${ev.sessionId} [${ev.model} @ ${ev.effort}]`)); break;
      case "round-start": console.log(C.dim(`— round ${ev.round} —`)); break;
      case "tool-call":
        console.log(C.warn(`⚙ ${ev.call.name}`) + C.dim(` ${JSON.stringify(summarizeArgs(ev.call))}`));
        break;
      case "tool-result":
        console.log(ev.result.ok
          ? C.ok(`  ✓ ${ev.call.id} done`)
          : C.bad(`  ✗ ${ev.call.id} ${ev.result.error ?? "failed"}`));
        break;
      case "protocol-warn": console.log(C.warn(`  ! protocol drift: ${ev.errors.join("; ")}`)); break;
      case "waiting": console.log(C.dim(`  … waiting for agent (${Math.round(ev.elapsedMs / 1000)}s) — send "continue" in the thread to nudge it`)); break;
      case "adopted": console.log(C.warn(`  ⤷ adopted the agent's reply to your manual message`)); break;
      case "done": console.log(C.ok(`\n✔ DONE in ${ev.rounds} rounds: `) + ev.summary); break;
      case "error": console.log(C.bad(`\n✗ failed after ${ev.rounds} rounds: ${ev.error}`)); break;
      default: break;
    }
  };
}

function summarizeArgs(call) {
  const a = { ...call.args };
  for (const k of ["content", "new", "old", "command"]) {
    if (typeof a[k] === "string" && a[k].length > 80) a[k] = a[k].slice(0, 80) + "…";
  }
  return a;
}

// ------------------------------------------------------------- commands

async function cmdExec({ positional, flags }) {
  const task = positional.filter((p) => !p.startsWith("-")).join(" ");
  if (!task) { usage(); process.exit(1); }
  const root = path.resolve(flags.root ?? process.cwd());
  const client = await loadClient();

  const rawTarget = flags.channel ?? flags.session ?? (flags.resume ? "last" : null);
  let channelId = resolveChannelId(rawTarget);
  const continuing = Boolean(channelId); // old thread already has the protocol in memory
  if (!channelId) {
    // fresh isolated thread per run (clean AI context, watchable in the UI)
    const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
    channelId = await client.createChannel(`SuperHarness: ${slug}`);
    console.log(C.dim(`thread: https://superapp.chat/h/${channelId} (isolated for this run)`));
  } else {
    console.log(C.dim(`continuing thread: https://superapp.chat/h/${channelId}`));
  }
  const loop = new AgentLoop(client, {
    root,
    channelId,
    model: MODEL_PRESETS[flags.model] ?? flags.model ?? MODEL_PRESETS[DEFAULT_MODEL],
    reasoningEffort: flags.effort ?? "adaptive",
    maxRounds: Number(flags["max-rounds"]) || 40,
    timeoutMs: (Number(flags["timeout-mins"]) || 45) * 60_000,
    onEvent: makeEvents(root),
  });
  try {
    const r = await loop.run(task, { preamble: continuing ? Boolean(flags.preamble) : true });
    process.exit(r.ok ? 0 : 2);
  } catch (e) {
    console.error(C.bad(e.message));
    process.exit(1);
  } finally {
    await client.save();
    client.closeGateway();
  }
}

async function cmdWatch({ flags }) {
  const root = path.resolve(flags.root ?? process.cwd());
  const model = MODEL_PRESETS[flags.model] ?? flags.model ?? MODEL_PRESETS[DEFAULT_MODEL];
  const client = await loadClient();

  const rawTarget = flags.channel ?? flags.session ?? (flags.resume ? "last" : null);
  let channelId = resolveChannelId(rawTarget);
  if (!channelId && flags.new) {
    channelId = await client.createChannel(`SuperHarness bridge ${new Date().toISOString().slice(0, 16)}`);
    console.log(C.ok(`created bridge thread: https://superapp.chat/h/${channelId}`));
  }
  if (!channelId) {
    console.error(C.bad("watch needs --channel <threadId|sessionId> (or --resume / --new); open the thread in SuperApp and type tasks there"));
    process.exit(1);
  }
  const effort = flags.effort ?? "adaptive";
  if (!EFFORT_LEVELS.includes(effort)) {
    console.error(C.bad(`invalid --effort "${effort}" (allowed: ${EFFORT_LEVELS.join(", ")})`));
    process.exit(1);
  }
  const queue = [];
  let processing = false;
  let sentPreamble = false; // bridge thread needs the protocol preamble only once

  console.log(C.hi(`👁 watch: https://superapp.chat/h/${channelId} | root ${root} | model ${model} | effort ${effort}`));
  console.log(C.dim("  type tasks in that SuperApp thread; Ctrl-C to stop\n"));

  // fail fast on stale credentials instead of timing out forever
  try {
    await client.accounts();
  } catch (e) {
    console.error(C.bad(`auth check failed: ${e.message}`));
    console.error(C.bad("→ re-login the harness:  node ../capture_session.mjs   then start watch again"));
    process.exit(1);
  }

  // detection = processed-id set. No watermark scan: the history endpoint's order
  // is not strictly newest-first, so "scan until lastSeenId" can silently skip tasks.
  const processed = new Set();
  const backlog = Boolean(flags.backlog);
  try {
    const seedMsgs = await client.history(channelId, { limit: 50 });
    if (!backlog) for (const m of seedMsgs) processed.add(m.id);
  } catch (e) {
    console.error(C.bad(`cannot read thread history: ${e.message}`));
    process.exit(1);
  }
  console.log(C.dim(backlog
    ? "  backlog mode: pre-existing unsigned user messages will be processed"
    : `  ${processed.size} pre-existing messages ignored (--backlog to process them); watching for new tasks`));

  const shouldInterrupt = () => queue.length > 0;

  async function tick() {
    const msgs = await client.history(channelId, { limit: 50 });
    const fresh = [];
    for (const m of msgs) {
      if (processed.has(m.id)) continue;
      processed.add(m.id); // mark seen immediately — never re-detect
      if (m.role !== "user") continue;
      let text = (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text.includes("⟦HARNESS")) continue; // our own messages
      // surface chat attachments so the agent can save_attachment them
      const notes = [];
      for (const b of m.content ?? []) {
        if (b.type === "text") continue;
        const s = JSON.stringify(b);
        const id = (s.match(/"attachment_?[Ii]d"\s*:\s*"([0-9a-f-]{36})"/) || [])[1];
        const name = (s.match(/"name"\s*:\s*"([^"]{1,150})"/) || [])[1];
        if (id) notes.push(`[attachment: ${name ?? "file"} attachment_id=${id}]`);
      }
      if (notes.length) text += "\n" + notes.join("\n");
      fresh.push({ id: m.id, text, created: m.created_at });
    }
    fresh.sort((a, b) => (a.created < b.created ? -1 : 1));
    for (const f of fresh) {
      console.log(C.hi(`\n📥 task from UI: ${f.text.slice(0, 120)}`));
      queue.push(f);
    }
    if (!processing && queue.length) {
      processing = true;
      const task = queue.shift();
      try {
        const loop = new AgentLoop(client, {
          root, channelId, model,
          reasoningEffort: effort,
          maxRounds: Number(flags["max-rounds"]) || 40,
          timeoutMs: (Number(flags["timeout-mins"]) || 45) * 60_000,
          onEvent: makeEvents(root),
          shouldInterrupt,
        });
        await loop.run(task.text, { preamble: !sentPreamble });
        sentPreamble = true;
      } catch (e) {
        console.error(C.bad(`task failed: ${e.message}`));
      } finally {
        await client.save();
        processing = false;
      }
    }
  }

  const AUTH_FAILURE = /session_rejected|invalid_session|refresh failed|Authentication required|Invalid or expired token/i;
  for (;;) {
    try {
      await tick();
    } catch (e) {
      if (AUTH_FAILURE.test(e.message)) {
        console.error(C.bad(`\nauth died: ${e.message}`));
        console.error(C.bad("→ stop this watch, run:  node ../capture_session.mjs   then start watch again"));
        process.exit(1);
      }
      console.error(C.bad(`poll error: ${e.message}`));
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
}

async function cmdSessions({ positional }) {
  const sessionsDir = path.join(AUTO_DIR, ".superharness", "sessions");
  if (positional[0] === "show" && positional[1]) {
    const file = path.join(sessionsDir, `${positional[1]}.jsonl`);
    if (!fs.existsSync(file)) { console.error(C.bad("no such session")); process.exit(1); }
    for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(line);
      if (e.type === "tool") console.log(C.warn(`⚙ r${e.round} ${e.name}`) + C.dim(` ${JSON.stringify(summarizeArgs({ args: e.args }))}`));
      else if (e.type === "result") console.log(e.ok ? C.ok(`  ✓ ${e.id}`) : C.bad(`  ✗ ${e.id} ${e.error ?? ""}`));
      else if (e.type === "reply") console.log(C.dim(`  r${e.round} reply: ${e.text.slice(0, 100).replace(/\n/g, " ")}`));
      else if (e.type === "done") console.log(C.ok(`✔ ${e.summary}`));
      else if (e.type === "error") console.log(C.bad(`✗ ${e.error}`));
      else if (e.type === "meta") console.log(C.hi(`session ${e.sessionId} — ${e.task?.slice(0, 100)}`));
    }
    return;
  }
  const sessions = await listSessions(sessionsDir);
  if (!sessions.length) { console.log(C.dim("no sessions yet")); return; }
  console.log(C.dim("Sessions (pass session ID or thread ID to --channel or use --resume):\n"));
  for (const s of sessions) {
    const threadPart = s.channelId ? C.dim(`[thread ${s.channelId.slice(0, 8)}…]`) : "";
    console.log(`${C.hi(s.sessionId)}  ${threadPart.padEnd(20)}  ${C.dim(s.ts ? s.ts.slice(0, 16) : "")}  ${s.model?.split("/").pop()}  ${C.dim((s.task ?? "").slice(0, 60))}`);
  }
}

async function cmdDoctor() {
  const client = await loadClient();
  const accounts = await client.accounts();
  console.log(C.ok("✓ auth:"), accounts.map((a) => a.email).join(", "));
  const ws = await client.workspaces();
  console.log(C.ok("✓ workspace:"), ws.workspaces.map((w) => `${w.name} [${w.role}]`).join(", "));
  const cat = await client.models();
  const opts = cat.model_catalog.options.map((o) => o.value);
  console.log(C.ok("✓ models:"), opts.length, "available");
  for (const [k, v] of Object.entries(MODEL_PRESETS)) {
    const note = k === "astra" ? C.warn("(refuses tool calls — not usable as the loop driver)") : C.ok("✓");
    console.log(`   ${k.padEnd(6)} → ${v} ${note}`);
  }
  await client.unread();
  console.log(C.ok("✓ unread api: ok"));
  const t = await client.token();
  const payload = JSON.parse(Buffer.from(t.split(".")[1], "base64").toString());
  console.log(C.ok("✓ token expires:"), new Date(payload.exp * 1000).toISOString());
  const dirs = [path.join(AUTO_DIR, ".superharness", "sessions")];
  for (const d of dirs) { fs.mkdirSync(d, { recursive: true }); console.log(C.ok("✓ sessions dir:"), d); }
  client.closeGateway();
}

// ------------------------------------------------------------- main

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
try {
  if (cmd === "exec") await cmdExec(args);
  else if (cmd === "watch") await cmdWatch(args);
  else if (cmd === "sessions") await cmdSessions(args);
  else if (cmd === "doctor") await cmdDoctor();
  else { usage(); process.exit(cmd ? 1 : 0); }
} catch (e) {
  console.error(C.bad(e.message));
  process.exit(1);
}
