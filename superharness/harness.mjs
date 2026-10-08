/**
 * SuperHarness core: protocol parsing/formatting and the agent loop.
 * The SuperApp thread IS the conversation memory; each round posts tool
 * results and waits for the next structured reply.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import SuperAppClient from "../superapp.mjs";
import { toolSchemas, executeTool } from "./tools.mjs";
import { MAX_TOOL_CALLS_PER_ROUND } from "./safety.mjs";

const HARNESS_SIG = "⟦HARNESS v1⟧";
const REPLY_TIMEOUT_MS = 4 * 60_000; // per-wait window; pings + adoption handle stalls
const DEFAULT_MAX_WAITS_PER_ROUND = 8; // 8 x 4-min waits ~= 32 min per round; sol@max can think long
// transcripts live centrally next to the package, not inside agent workspaces
const CENTRAL_SESSIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", ".superharness", "sessions",
);

export function protocolPreamble(root, { maxCalls = MAX_TOOL_CALLS_PER_ROUND } = {}) {
  const tpl = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "protocol.md"),
    "utf8",
  );
  return tpl
    .replaceAll("{ROOT}", root)
    .replaceAll("{OS}", `${os.platform()} ${os.release()} ${os.arch()}`)
    .replaceAll("{NODE}", process.version)
    .replaceAll("{DATE}", new Date().toISOString())
    .replaceAll("{TOOL_SCHEMAS}", toolSchemas().map((t) => `- ${t.name}: ${t.desc} args: ${JSON.stringify(t.args)}`).join("\n"))
    .replaceAll("{MAX_CALLS}", String(maxCalls));
}

/** Parse an assistant reply into { tools: [{id,name,args}], done: {summary}|null, raw }. */
export function parseReply(text, { maxCalls = MAX_TOOL_CALLS_PER_ROUND } = {}) {
  const tools = [];
  const errors = [];
  for (const m of text.matchAll(/^⟦TOOL⟧\s*(\{.*\})\s*$/gm)) {
    try {
      const call = JSON.parse(m[1]);
      if (!call.name) throw new Error("missing name");
      tools.push({ id: call.id ?? `t${tools.length + 1}`, name: call.name, args: call.args ?? {} });
    } catch (e) {
      errors.push(`unparseable TOOL line: ${e.message}`);
    }
    if (tools.length >= maxCalls) break;
  }
  let done = null;
  const dm = text.match(/⟦DONE⟧\s*(\{[\s\S]*?\})?\s*$/);
  if (dm) {
    try { done = { summary: dm[1] ? JSON.parse(dm[1]).summary ?? "" : "" }; }
    catch { done = { summary: text.split("⟦DONE⟧")[1]?.trim() ?? "" }; }
  }
  return { tools, done, errors, raw: text };
}

const RESULT_BODY_KEYS = ["stdout", "stderr", "output", "content", "listing", "matches"];

export function formatResults(results, { round, maxRounds }) {
  const blocks = results.map((r) => {
    // meta: every scalar/structural field the agent should see (uploaded lists, paths, counts…)
    const meta = {};
    for (const [k, v] of Object.entries(r)) {
      if (RESULT_BODY_KEYS.includes(k)) continue;
      if (v === undefined) continue;
      try { meta[k] = JSON.parse(JSON.stringify(v)); } catch { /* skip unserializable */ }
    }
    let body = "";
    for (const k of RESULT_BODY_KEYS) {
      if (r[k]) body += `\n${r[k]}`;
    }
    if (!body && !r.error) body = "\n(ok, no output)";
    return `⟦RESULT⟧ ${JSON.stringify(meta)}${body}`;
  });
  return `${blocks.join("\n")}\n⟦CONTINUE⟧ round=${round}/${maxRounds}`;
}

const NUDGE = `⟦NUDGE⟧ Your last reply did not follow the protocol. Real-machine work must go through ⟦TOOL⟧ {"id":"…","name":"…","args":{…}} lines + ⟦END⟧ — files you create only in your built-in sandbox do NOT exist on the real machine. Or reply ⟦DONE⟧ {"summary":…}. Nothing else.`;

// ------------------------------------------------------------------ AgentLoop

export class AgentLoop {
  /** assistant reply ids already consumed this task (never adopt/consume twice) */
  #seenReplyIds = new Set();

  /**
   * @param client   SuperAppClient (from ../superapp.mjs)
   * @param opts     { root, channelId, model, maxRounds, timeoutMs, maxWaitsPerRound,
   *                   sessionsDir, onEvent, shouldInterrupt }
   */
  constructor(client, opts) {
    this.client = client;
    this.root = opts.root;
    this.channelId = opts.channelId;
    this.model = opts.model ?? "superagent-pro";
    this.reasoningEffort = opts.reasoningEffort ?? "adaptive"; // adaptive|low|medium|high|xhigh|max
    this.maxRounds = opts.maxRounds ?? 40;
    this.timeoutMs = opts.timeoutMs ?? 45 * 60_000;
    this.maxWaitsPerRound = opts.maxWaitsPerRound ?? DEFAULT_MAX_WAITS_PER_ROUND;
    this.sessionsDir = opts.sessionsDir ?? CENTRAL_SESSIONS_DIR;
    this.onEvent = opts.onEvent ?? (() => {});
    this.shouldInterrupt = opts.shouldInterrupt ?? (() => false);
    this.preambleSent = false;
    this.#seenReplyIds = new Set(); // assistant replies already consumed (never adopt twice)
  }

  #sessionFile() {
    return path.join(this.sessionsDir, `${this.sessionId}.jsonl`);
  }

  async #log(entry) {
    await fsp.mkdir(this.sessionsDir, { recursive: true });
    await fsp.appendFile(this.#sessionFile(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }

  async #post(text, { viewFilePaths = [] } = {}) {
    return this.client.send(this.channelId, `${HARNESS_SIG}\n${text}`, {
      mode: this.model === "superagent-pro" ? "superagent-pro" : this.model,
      reasoningEffort: this.reasoningEffort,
      ...(viewFilePaths.length ? { extraArgs: { file_paths: viewFilePaths } } : {}),
    });
  }

  /**
   * Run a task to completion. Returns { ok, summary, rounds, interrupted }.
   */
  async run(task, { preamble = true, resumeSessionId = null } = {}) {
    this.sessionId = resumeSessionId ?? `sh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.#seenReplyIds = new Set(); // never adopt/consume the same assistant reply twice
    const deadline = Date.now() + this.timeoutMs;
    let rounds = 0;

    const firstMsg = preamble && !this.preambleSent
      ? `${protocolPreamble(this.root)}\n\n# TASK\n${task}`
      : task;
    this.onEvent({ type: "task-start", task, sessionId: this.sessionId, model: this.model, effort: this.reasoningEffort });
    await this.#log({ type: "meta", sessionId: this.sessionId, root: this.root, channelId: this.channelId, model: this.model, task, resumable: true });
    let { threadRootId } = await this.#post(firstMsg);
    let postedAt = Date.now();

    try {
      while (rounds < this.maxRounds) {
        if (Date.now() > deadline) throw new Error(`global timeout ${this.timeoutMs / 1000}s reached after ${rounds} rounds`);
        if (this.shouldInterrupt()) {
          await this.#post("⟦INTERRUPTED⟧ {\"reason\":\"new human message arrived\"}");
          await this.#log({ type: "interrupted", round: rounds });
          return { ok: false, interrupted: true, summary: "interrupted by human message", rounds };
        }
        rounds++;
        this.onEvent({ type: "round-start", round: rounds });
        const reply = await this.#waitRound(threadRootId, postedAt);
        if (reply.interrupted) {
          await this.#post("⟦INTERRUPTED⟧ {\"reason\":\"new human message arrived\"}");
          await this.#log({ type: "interrupted", round: rounds });
          return { ok: false, interrupted: true, summary: "interrupted by human message", rounds };
        }
        await this.#log({ type: "reply", round: rounds, text: reply.text });

        const parsed = parseReply(reply.text);
        if (parsed.done) {
          await this.#log({ type: "done", round: rounds, summary: parsed.done.summary });
          this.onEvent({ type: "done", summary: parsed.done.summary, rounds });
          return { ok: true, summary: parsed.done.summary, rounds, interrupted: false };
        }
        if (parsed.tools.length === 0) {
          if (parsed.errors.length) this.onEvent({ type: "protocol-warn", errors: parsed.errors });
          const ping = await this.#post(NUDGE);
          threadRootId = ping.threadRootId;
          postedAt = Date.now();
          continue;
        }

        const results = [];
        for (const call of parsed.tools) {
          this.onEvent({ type: "tool-call", call });
          await this.#log({ type: "tool", round: rounds, ...call });
          const result = await executeTool(
            { root: this.root, client: this.client, channelId: this.channelId },
            call.name,
            call.args,
          );
          results.push({ id: call.id, ...result });
          this.onEvent({ type: "tool-result", call, result });
          await this.#log({ type: "result", round: rounds, id: call.id, ok: result.ok, error: result.error ?? null });
        }
        const msg = formatResults(results, { round: rounds, maxRounds: this.maxRounds });
        // sandbox_upload view:true → attach those images so the model SEES them next round
        const viewFilePaths = results.flatMap((r) => (Array.isArray(r.view_file_paths) ? r.view_file_paths : []));
        ({ threadRootId } = await this.#post(msg, { viewFilePaths }));
        postedAt = Date.now();
      }
      throw new Error(`max rounds (${this.maxRounds}) exhausted without ⟦DONE⟧`);
    } catch (e) {
      await this.#log({ type: "error", round: rounds, error: e.message });
      this.onEvent({ type: "error", error: e.message, rounds });
      throw e;
    }
  }

  /**
   * Wait for the reply to our message — SILENTLY (no pings: they re-wake the
   * agent and flood the thread). On EVERY poll (~3s) we check both:
   *   1. the expected reply (thread_root_id === ours), completed or failed;
   *   2. an ORPHAN reply — the agent answered a human message typed meanwhile
   *      (e.g. a manual "continue") — and adopt it immediately.
   * Adoption is time-based (created_at > our post time), not window-based, so
   * long threads can't break it. Heartbeat events keep the console alive.
   */
  async #waitRound(threadRootId, postedAtMs) {
    const maxMs = REPLY_TIMEOUT_MS * this.maxWaitsPerRound;
    const start = Date.now();
    let lastBeat = start;
    let pollErrors = 0;

    for (;;) {
      if (this.shouldInterrupt()) return { interrupted: true };

      let msgs = [];
      try {
        msgs = await this.client.history(this.channelId, { limit: 60 });
        pollErrors = 0;
      } catch (e) {
        if (++pollErrors > 10) throw new Error(`history polling failed repeatedly: ${e.message}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      // 1) the reply we're waiting for
      const reply = msgs.find(
        (m) => m.role === "assistant" && m.thread_root_id === threadRootId && !this.#seenReplyIds.has(m.id),
      );
      if (reply) {
        const state = reply.agent_session?.state;
        if (state === "failed") throw new Error(`agent session failed for thread ${threadRootId}`);
        if (!state || state === "completed") {
          this.#seenReplyIds.add(reply.id);
          return { text: SuperAppClient.answerText(reply) };
        }
        // still running → fall through to orphan scan + keep waiting
      }

      // 2) orphan adoption: agent answered a different (human) message posted after ours
      const orphan = msgs.find((m) =>
        m.role === "assistant"
        && m.thread_root_id !== threadRootId
        && !this.#seenReplyIds.has(m.id)
        && m.created_at
        && Date.parse(m.created_at) >= postedAtMs - 60_000 // clock-skew tolerance
        && (!m.agent_session || m.agent_session.state === "completed"),
      );
      if (orphan) {
        this.#seenReplyIds.add(orphan.id);
        const text = SuperAppClient.answerText(orphan);
        if (text.trim()) {
          this.onEvent({ type: "adopted", threadRootId: orphan.thread_root_id });
          await this.#log({ type: "adopted", expectedRoot: threadRootId, adoptedRoot: orphan.thread_root_id, text: text.slice(0, 4000) });
          return { text };
        }
      }

      const elapsed = Date.now() - start;
      if (elapsed > maxMs) {
        throw new Error(
          `no agent reply after ${Math.round(maxMs / 60000)} min. The thread is intact — ` +
          `send "continue" in the thread (a running watch adopts it instantly; a fresh exec adopts it too) ` +
          `or re-run: exec --channel ${this.channelId}`,
        );
      }
      if (Date.now() - lastBeat >= 30_000) {
        lastBeat = Date.now();
        this.onEvent({ type: "waiting", elapsedMs: elapsed });
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ------------------------------------------------------------------ sessions

export async function listSessions(sessionsDir) {
  let files = [];
  try { files = (await fsp.readdir(sessionsDir)).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  const out = [];
  for (const f of files.sort().reverse()) {
    try {
      const first = (await fsp.readFile(path.join(sessionsDir, f), "utf8")).split("\n")[0];
      out.push(JSON.parse(first));
    } catch { /* skip corrupt */ }
  }
  return out;
}
