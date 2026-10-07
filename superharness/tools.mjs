/**
 * SuperHarness tool implementations. Every tool gets (ctx, args) where ctx =
 * { root, client, channelId }; sandbox tools additionally use client/channelId.
 * a plain serializable result. All paths are jailed; all commands blocklisted.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  jailPath, assertCommandAllowed, scrubEnv, capOutput,
  DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS,
} from "./safety.mjs";

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, extra = {}) => ({ ok: false, error: String(error.message ?? error), ...extra });

async function runCmd(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: scrubEnv() },
      (err, stdout, stderr) => resolve({ err, stdout: stdout ?? "", stderr: stderr ?? "" }));
  });
}

// ------------------------------------------------------------------ bash

async function bash(ctx, args) {
  const command = String(args.command ?? "");
  if (!command.trim()) return fail(new Error("bash: command is required"));
  try { assertCommandAllowed(command); } catch (e) { return fail(e); }

  const timeoutMs = Math.min(Number(args.timeout_ms) || DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
  const cwd = jailPath(ctx.root, args.workdir ?? ".");

  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd, env: scrubEnv(), stdio: ["ignore", "pipe", "pipe"],
    });
    let out = Buffer.alloc(0), err = Buffer.alloc(0);
    const collect = (buf, chunk) => {
      const merged = Buffer.concat([buf, chunk]);
      return merged.length > 256 * 1024 ? merged.subarray(merged.length - 256 * 1024) : merged;
    };
    child.stdout.on("data", (c) => { out = collect(out, c); });
    child.stderr.on("data", (c) => { err = collect(err, c); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exit: code,
        ...(signal ? { signal } : {}),
        stdout: capOutput(out),
        stderr: capOutput(err),
        ...(code !== 0 ? { error: `exit code ${code}${signal ? ` (${signal})` : ""}` } : {}),
      });
    });
    child.on("error", (e) => { clearTimeout(timer); resolve(fail(e)); });
  });
}

// ------------------------------------------------------------------ fs tools

async function read_file(ctx, args) {
  try {
    const p = jailPath(ctx.root, args.path);
    const stat = await fsp.stat(p);
    if (stat.isDirectory()) return fail(new Error(`${args.path} is a directory (use list_dir)`));
    const data = await fsp.readFile(p, "utf8");
    const lines = data.split("\n");
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.min(Number(args.limit) || 2000, 5000);
    const slice = lines.slice(offset, offset + limit);
    const text = slice.map((l, i) => `${offset + i + 1}\t${l}`).join("\n");
    return ok({
      total_lines: lines.length,
      truncated: offset + limit < lines.length,
      content: capOutput(Buffer.from(text)),
    });
  } catch (e) { return fail(e); }
}

async function write_file(ctx, args) {
  try {
    const p = jailPath(ctx.root, args.path);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, String(args.content ?? ""), "utf8");
    return ok({ bytes: Buffer.byteLength(String(args.content ?? "")) });
  } catch (e) { return fail(e); }
}

async function edit_file(ctx, args) {
  try {
    const p = jailPath(ctx.root, args.path);
    const src = await fsp.readFile(p, "utf8");
    const oldS = String(args.old ?? "");
    const newS = String(args.new ?? "");
    if (!oldS) return fail(new Error("edit_file: old is required"));
    const count = src.split(oldS).length - 1;
    if (count === 0) return fail(new Error("edit_file: old text not found"));
    if (count > 1 && !args.replace_all) {
      return fail(new Error(`edit_file: old text matches ${count} times; provide more context or replace_all:true`));
    }
    const next = args.replace_all ? src.split(oldS).join(newS) : src.replace(oldS, newS);
    await fsp.writeFile(p, next, "utf8");
    return ok({ replacements: args.replace_all ? count : 1 });
  } catch (e) { return fail(e); }
}

async function list_dir(ctx, args) {
  try {
    const p = jailPath(ctx.root, args.path ?? ".");
    const depth = Math.min(Number(args.depth) || 1, 4);
    const lines = [];
    const walk = async (dir, rel, d) => {
      if (lines.length > 800) { lines.push("…"); return; }
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if ([".git", "node_modules", "__pycache__", ".venv", "dist", "build"].includes(e.name)) {
          lines.push(`${rel}${e.name}/ (skipped)`);
          continue;
        }
        lines.push(`${rel}${e.name}${e.isDirectory() ? "/" : ""}`);
        if (e.isDirectory() && d < depth) await walk(path.join(dir, e.name), `${rel}${e.name}/`, d + 1);
      }
    };
    await walk(p, "", 1);
    return ok({ listing: lines.join("\n") || "(empty)" });
  } catch (e) { return fail(e); }
}

function globSync(root, pattern) {
  // zero-dep glob: ** / * / ? via regex; run from root
  const re = new RegExp(
    "^" + pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, ".*")
      .replace(/\?/g, "[^/]") + "$",
  );
  const out = [];
  const skip = new Set([".git", "node_modules", "__pycache__", ".venv", "dist", "build"]);
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(dir, e.name), r); }
      else if (re.test(r)) out.push(r);
      if (out.length > 1000) return;
    }
  };
  walk(ctx.root, "");
  return out;
}

async function glob(ctx, args) {
  try {
    const matches = globSync(ctx.root, String(args.pattern ?? "**/*"));
    return ok({ count: matches.length, matches: matches.slice(0, 500) });
  } catch (e) { return fail(e); }
}

async function grep(ctx, args) {
  try {
    const pattern = String(args.pattern ?? "");
    if (!pattern) return fail(new Error("grep: pattern is required"));
    const fixed = Boolean(args.fixed);
    const ig = Boolean(args.ignore_case);
    const cwd = jailPath(ctx.root, args.path ?? ".");
    const globArg = args.glob ? ["--glob", String(args.glob)] : [];
    const base = ["-n", "--max-count", "8", "--max-columns", "400", ...(ig ? ["-i"] : []), ...globArg];
    const useRg = fs.existsSync("/usr/bin/rg") || fs.existsSync("/usr/local/bin/rg");
    if (useRg) {
      const argv = [...(fixed ? ["-F"] : []), ...base, pattern, "."];
      const r = await runCmd("rg", argv, { cwd, timeoutMs: 30000 });
      const text = (r.stdout + r.stderr).trim();
      return ok({ tool: "rg", matches: text ? capOutput(Buffer.from(text)) : "(no matches)" });
    }
    // Node fallback scan
    const re = new RegExp(fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, ig ? "i" : "");
    const hits = [];
    const walk = (dir) => {
      if (hits.length > 200) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (hits.length > 200) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!["node_modules", ".git"].includes(e.name)) walk(full); continue; }
        if (e.name.startsWith(".")) continue;
        let content;
        try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
        content.split("\n").forEach((line, i) => {
          if (re.test(line) && hits.length <= 200) hits.push(`${path.relative(cwd, full)}:${i + 1}:${line.trim().slice(0, 300)}`);
        });
      }
    };
    walk(cwd);
    return ok({ tool: "node", matches: hits.length ? hits.slice(0, 200).join("\n") : "(no matches)" });
  } catch (e) { return fail(e); }
}

// ------------------------------------------------------------------ git

const GIT_OPS = ["status", "diff", "log", "add", "commit", "branch", "checkout", "push", "pull"];

async function git(ctx, args) {
  const op = String(args.op ?? "status");
  if (!GIT_OPS.includes(op)) return fail(new Error(`git: unknown op "${op}" (allowed: ${GIT_OPS.join(", ")})`));
  const extraArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  try { assertCommandAllowed(`git ${op} ${extraArgs.join(" ")}`); } catch (e) { return fail(e); }
  const r = await runCmd("git", [op, ...extraArgs], { cwd: ctx.root, timeoutMs: 120000 });
  const text = capOutput(Buffer.from((r.stdout + "\n" + r.stderr).trim()));
  return { ok: r.err === null || r.err.code === 0 || undefined, exit: r.err ? r.err.code ?? 1 : 0, output: text, ...(r.err ? { error: `git ${op} failed` } : {}) };
}

// ------------------------------------------------------------------ sandbox / attachments
// The SuperApp thread has a server-side "sandbox" FS the agent sees natively
// (Files panel). These tools move data between the real workspace and it.

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_FILES = 200;
const MAX_UPLOAD_DIRS = 40; // one request per directory group

/** Group local files for the sandbox: returns [{ uploadPath, name, data }].
 *  The endpoint flattens '/'-names, so folder structure comes from upload_path. */
async function collectUploadEntries(root, localPath, sandboxPath) {
  const abs = jailPath(root, localPath);
  const stat = await fsp.stat(abs);
  const baseName = path.basename(abs);
  const groups = new Map(); // relDir -> [{ name, data }]
  let total = 0, count = 0;
  const add = (relDir, name, data) => {
    total += data.length;
    if (total > MAX_UPLOAD_BYTES) throw new Error(`upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`);
    if (++count > MAX_UPLOAD_FILES) throw new Error(`upload exceeds ${MAX_UPLOAD_FILES} files`);
    if (!groups.has(relDir)) groups.set(relDir, []);
    groups.get(relDir).push({ name, data });
  };
  if (stat.isDirectory()) {
    const walk = async (dir, rel) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        if (["node_modules", ".git", "__pycache__", ".venv"].includes(e.name)) continue;
        if (e.isDirectory()) await walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
        else add(rel ?? "", e.name, await fsp.readFile(path.join(dir, e.name)));
      }
    };
    await walk(abs, "");
  } else {
    add("", baseName, await fsp.readFile(abs));
  }
  if (!count) throw new Error("nothing to upload");
  const target = sandboxPath ? sandboxPath.replace(/^\/+|\/+$/g, "") : "";
  const batches = [];
  for (const [relDir, files] of groups) {
    const uploadPath = target ? (relDir ? `${target}/${relDir}` : target) : relDir;
    batches.push({ uploadPath, files });
  }
  if (batches.length > MAX_UPLOAD_DIRS) {
    throw new Error(`folder spans ${batches.length} directories (max ${MAX_UPLOAD_DIRS}); zip it and upload the zip instead`);
  }
  return batches;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

async function sandbox_upload(ctx, args) {
  try {
    const batches = await collectUploadEntries(ctx.root, String(args.path ?? "."), args.sandbox_path ? String(args.sandbox_path) : "");
    const uploaded = [];
    const viewPaths = [];
    for (const b of batches) {
      const res = await ctx.client.sandboxUpload(ctx.channelId, b.files, b.uploadPath);
      for (const f of res?.uploadedFiles ?? []) {
        const p = f.path ?? f.filename;
        uploaded.push(p);
        if (args.view && IMAGE_EXTS.has(("." + String(p).split(".").pop()).toLowerCase())) viewPaths.push(p);
      }
    }
    const result = { uploaded: uploaded.length, files: uploaded.slice(0, 50) };
    // view:true → the harness attaches these images to its next message so the
    // model receives them as vision input in the following round
    if (viewPaths.length) result.view_file_paths = viewPaths;
    return ok(result);
  } catch (e) { return fail(e); }
}

async function sandbox_list(ctx, args) {
  try {
    const res = await ctx.client.sandboxList(ctx.channelId, String(args.path ?? ""));
    return ok({ listing: capOutput(Buffer.from(JSON.stringify(res, null, 1))) });
  } catch (e) { return fail(e); }
}

async function sandbox_read(ctx, args) {
  try {
    if (!args.path) return fail(new Error("sandbox_read: path is required"));
    const res = await ctx.client.sandboxRead(ctx.channelId, String(args.path).replace(/^\/+/, ""));
    return ok({ content: capOutput(Buffer.from(typeof res === "string" ? res : JSON.stringify(res, null, 1))) });
  } catch (e) { return fail(e); }
}

async function sandbox_download(ctx, args) {
  try {
    if (!args.path) return fail(new Error("sandbox_download: path is required"));
    const sp = String(args.path).replace(/^\/+/, "");
    const buf = await ctx.client.sandboxDownload(ctx.channelId, sp);
    const local = jailPath(ctx.root, args.local_path ?? path.basename(sp));
    await fsp.mkdir(path.dirname(local), { recursive: true });
    await fsp.writeFile(local, buf);
    return ok({ local_path: path.relative(ctx.root, local), bytes: buf.length });
  } catch (e) { return fail(e); }
}

async function sandbox_zip(ctx, args) {
  try {
    const paths = Array.isArray(args.paths) ? args.paths.map((p) => String(p).replace(/^\/+/, "")) : [];
    if (!paths.length) return fail(new Error("sandbox_zip: paths[] is required"));
    const buf = await ctx.client.sandboxDownloadZip(ctx.channelId, paths, String(args.zip_name ?? "sandbox.zip"));
    const local = jailPath(ctx.root, args.local_path ?? "sandbox.zip");
    await fsp.writeFile(local, buf);
    return ok({ local_path: path.relative(ctx.root, local), bytes: buf.length });
  } catch (e) { return fail(e); }
}

async function save_attachment(ctx, args) {
  try {
    if (!args.attachment_id) return fail(new Error("save_attachment: attachment_id is required (from the task's [attachment: …] note)"));
    const buf = await ctx.client.attachmentDownload(ctx.channelId, String(args.attachment_id));
    const local = jailPath(ctx.root, args.local_path ?? String(args.name ?? `attachment-${String(args.attachment_id).slice(0, 8)}`));
    await fsp.mkdir(path.dirname(local), { recursive: true });
    await fsp.writeFile(local, buf);
    return ok({ local_path: path.relative(ctx.root, local), bytes: buf.length });
  } catch (e) { return fail(e); }
}

// ------------------------------------------------------------------ registry

export const TOOLS = {
  bash: { desc: "Run a bash command inside the workspace. Returns exit code + output tails.", args: { command: "string (required)", timeout_ms: "number (default 120000, max 600000)", workdir: "string (relative to root)" }, fn: bash },
  read_file: { desc: "Read a text file with line numbers.", args: { path: "string (required)", offset: "number (0-based line)", limit: "number (default 2000 lines)" }, fn: read_file },
  write_file: { desc: "Create or overwrite a file.", args: { path: "string (required)", content: "string (required)" }, fn: write_file },
  edit_file: { desc: "Search/replace inside a file. old must match exactly once unless replace_all.", args: { path: "string (required)", old: "string (required)", new: "string (required)", replace_all: "boolean" }, fn: edit_file },
  list_dir: { desc: "List directory entries (recursive up to depth 4).", args: { path: "string (default .)", depth: "number (1-4)" }, fn: list_dir },
  glob: { desc: "Filename pattern match, e.g. **/*.js.", args: { pattern: "string (required)" }, fn: glob },
  grep: { desc: "Content search (ripgrep when available).", args: { pattern: "string (required)", path: "string (default .)", glob: "string (e.g. *.py)", fixed: "boolean (literal search)", ignore_case: "boolean" }, fn: grep },
  git: { desc: "Version control: status|diff|log|add|commit|branch|checkout|push|pull.", args: { op: "string (required)", args: "string[] (extra cli args, e.g. [\"-m\",\"msg\"])" }, fn: git },
  sandbox_upload: { desc: "Upload a local file OR folder into this thread's sandbox (Files panel). Use view:true on images so the harness shows them to you visually next round.", args: { path: "string (required, local)", sandbox_path: "string (optional dest dir)", view: "boolean (attach images to next message for vision)" }, fn: sandbox_upload },
  sandbox_list: { desc: "List files in this thread's sandbox.", args: { path: "string (optional subdir)" }, fn: sandbox_list },
  sandbox_read: { desc: "Read a text file from this thread's sandbox.", args: { path: "string (required)" }, fn: sandbox_read },
  sandbox_download: { desc: "Copy a sandbox file into the real workspace.", args: { path: "string (required, sandbox)", local_path: "string (optional)" }, fn: sandbox_download },
  sandbox_zip: { desc: "Download several sandbox files as one zip into the workspace.", args: { paths: "string[] (required)", zip_name: "string", local_path: "string" }, fn: sandbox_zip },
  save_attachment: { desc: "Save a chat attachment (file the human uploaded) into the real workspace.", args: { attachment_id: "string (required)", name: "string (suggested filename)", local_path: "string (optional)" }, fn: save_attachment },
};

export function toolSchemas() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, desc: t.desc, args: t.args }));
}

export async function executeTool(ctx, name, args) {
  if (typeof ctx === "string") ctx = { root: ctx };
  const t = TOOLS[name];
  if (!t) return { ok: false, error: `unknown tool "${name}" (available: ${Object.keys(TOOLS).join(", ")})` };
  try {
    return await t.fn(ctx, args ?? {});
  } catch (e) {
    return fail(e);
  }
}
