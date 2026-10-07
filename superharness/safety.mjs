/**
 * SuperHarness safety layer: path jail, shell blocklist, output caps.
 * Everything is hard — even in full-auto mode these cannot be bypassed.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const OUTPUT_CAP_BYTES = 8 * 1024; // tool stdout/stderr tail kept per result
export const MAX_TOOL_CALLS_PER_ROUND = 8;
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 10 * 60_000;

/** Resolve p against root and refuse anything escaping the jail (symlinks included). */
export function jailPath(root, p = ".") {
  const absRoot = fs.realpathSync(root);
  const target = path.resolve(absRoot, p);
  // realpath of the nearest existing ancestor, so not-yet-created files are fine
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = fs.realpathSync(probe);
  if (real !== absRoot && !real.startsWith(absRoot + path.sep)) {
    throw new Error(`path escapes workspace jail: ${p}`);
  }
  return target;
}

const DENY_PATTERNS = [
  /\bsudo\b/,
  /\bsu\s+-/,
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*\/(\s|$)/, // rm -rf /
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+~/,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+[^|]*\bof=\/dev\/(sd|nvme|disk)/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\biptables\b/,
  /\bcurl\b[^|]*\|\s*(ba)?sh/, // curl | sh
  /\bwget\b[^|]*\|\s*(ba)?sh/,
  />\s*\/dev\/sd[a-z]/,
  /\bchmod\s+-R\s+777\s+\//,
];

export function assertCommandAllowed(command) {
  for (const re of DENY_PATTERNS) {
    if (re.test(command)) {
      throw new Error(`command blocked by harness safety policy: matched /${re.source}/`);
    }
  }
}

/** Strip env vars that could leak secrets into AI-visible output. */
export function scrubEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(SUPERAPP_|.*TOKEN|.*SECRET|.*PASSWORD|.*KEY$|AWS_|GH_|GITHUB_|NPM_TOKEN)/i.test(k)) continue;
    out[k] = v;
  }
  out.SUPERHARNESS = "1";
  return out;
}

export function capOutput(buf) {
  const s = buf.toString("utf8");
  if (Buffer.byteLength(s) <= OUTPUT_CAP_BYTES) return s;
  return `…(truncated; showing last ${OUTPUT_CAP_BYTES} bytes)…\n` + s.slice(-OUTPUT_CAP_BYTES);
}

export function newId(prefix = "t") {
  return `${prefix}${crypto.randomBytes(3).toString("hex")}`;
}
