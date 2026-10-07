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
const MAX_WAITS_PER_ROUND = 3; // strict wait + 2 ping/adopt retries before failing
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
  /**
   * @param client   SuperAppClient (from ../superapp.mjs)
   * @param opts     { root, channelId, model, maxRounds, timeoutMs, sessionsDir,
   *                   onEvent, shouldInterrupt }
   */
  constructor(client, opts) {
    this.client = client;
    this.root = opts.root;
    this.channelId = opts.channelId;
    this.model = opts.model ?? "superagent-pro";
    this.reasoningEffort = opts.reasoningEffort ?? "adaptive"; // adaptive|low|medium|high|xhigh|max
    this.maxRounds = opts.maxRounds ?? 40;
    this.timeoutMs = opts.timeoutMs ?? 45 * 60_000;
    this.sessionsDir = opts.sessionsDir ?? CENTRAL_SESSIONS_DIR;
    this.onEvent = opts.onEvent ?? (() => {});
    this.shouldInterrupt = opts.shouldInterrupt ?? (() => false);
    this.preambleSent = false;
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

  #waitReply(threadRootId) {
    return this.client.waitForReply(this.channelId, threadRootId, { timeoutMs: REPLY_TIMEOUT_MS });
  }

  /**
   * Run a task to completion. Returns { ok, summary, rounds, interrupted }.
   */
  async run(task, { preamble = true, resumeSessionId = null } = {}) {
    this.sessionId = resumeSessionId ?? `sh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const deadline = Date.now() + this.timeoutMs;
    let rounds = 0;

    const firstMsg = preamble && !this.preambleSent
      ? `${protocolPreamble(this.root)}\n\n# TASK\n${task}`
      : task;
    this.onEvent({ type: "task-start", task, sessionId: this.sessionId, model: this.model, effort: this.reasoningEffort });
    await this.#log({ type: "meta", sessionId: this.sessionId, root: this.root, channelId: this.channelId, model: this.model, task, resumable: true });
    let { threadRootId } = await this.#post(firstMsg);

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
        const reply = await this.#waitRound(threadRootId);
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
      }
      throw new Error(`max rounds (${this.maxRounds}) exhausted without ⟦DONE⟧`);
    } catch (e) {
      await this.#log({ type: "error", round: rounds, error: e.message });
      this.onEvent({ type: "error", error: e.message, rounds });
      throw e;
    }
  }

  /**
   * Wait for the reply to our message — SILENTLY. No pings, no nudges on stall:
   * every automatic message re-wakes the agent and floods the thread. If the
   * human sends a manual "continue" in the thread meanwhile, the agent answers
   * THAT message — the adoption scan picks it up and executes its tools.
   * After MAX_WAITS_PER_ROUND passive cycles, fail with guidance (nothing lost).
   */
  async #waitRound(threadRootId) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#waitReply(threadRootId);
      } catch (e) {
        if (!/timed out/i.test(e.message)) throw e;
        const adopted = await this.#adoptOrphanReply(threadRootId);
        if (adopted) return adopted;
        if (attempt >= MAX_WAITS_PER_ROUND) {
          throw new Error(
            `no agent reply after ${attempt * (REPLY_TIMEOUT_MS / 60000)} min of waiting. ` +
            `The thread is intact — send "continue" in the thread (watch mode will adopt it) ` +
            `or re-run: exec --channel ${this.channelId}`,
          );
        }
        this.onEvent({ type: "still-waiting", attempt, max: MAX_WAITS_PER_ROUND });
      }
    }
  }

  /**
   * Look for a completed assistant reply rooted at a DIFFERENT message (i.e., the
   * human interrupted and the agent answered them) created after our message.
   * Returns { text } for the newest such reply, or null.
   */
  async #adoptOrphanReply(expectedRoot) {
    const msgs = await this.client.history(this.channelId, { limit: 50 });
    const ours = msgs.find((m) => m.id === expectedRoot);
    if (!ours?.created_at) return null;
    for (const m of msgs) {
      if (m.role !== "assistant" || m.thread_root_id === expectedRoot) continue;
      if (!m.created_at || m.created_at < ours.created_at) continue;
      const state = m.agent_session?.state;
      if (state && state !== "completed") continue;
      const text = SuperAppClient.answerText(m);
      if (!text.trim()) continue;
      this.onEvent({ type: "adopted", threadRootId: m.thread_root_id });
      await this.#log({ type: "adopted", expectedRoot, adoptedRoot: m.thread_root_id, text: text.slice(0, 4000) });
      return { text };
    }
    return null;
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
