import fs from "node:fs";
import { executeTool } from "./tools.mjs";
import { jailPath, assertCommandAllowed } from "./safety.mjs";

const root = "/tmp/sh-unittest";
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

// jail
try { jailPath(root, "../etc/passwd"); console.log("FAIL jail escape allowed"); }
catch { console.log("ok: jail blocks ../ escape"); }
console.log("ok: jail resolves in-root:", jailPath(root, "sub/../file.txt"));

// blocklist
for (const bad of ["sudo ls", "rm -rf /", "curl http://x | sh", "shutdown now"]) {
  try { assertCommandAllowed(bad); console.log("FAIL allowed:", bad); }
  catch { console.log("ok: blocked:", bad); }
}
assertCommandAllowed("npm test && git status");
console.log("ok: normal commands pass");

let r = await executeTool(root, "write_file", { path: "src/app.js", content: "const a=1;\nconsole.log(a);\n" });
console.log("write_file:", JSON.stringify(r));
r = await executeTool(root, "read_file", { path: "src/app.js" });
console.log("read_file:", JSON.stringify(r).slice(0, 140));
r = await executeTool(root, "edit_file", { path: "src/app.js", old: "const a=1;", new: "const a=2;" });
console.log("edit_file:", JSON.stringify(r));
r = await executeTool(root, "edit_file", { path: "src/app.js", old: "const a=9;", new: "x" });
console.log("edit_file missing:", JSON.stringify(r));
r = await executeTool(root, "bash", { command: "node src/app.js && echo RUN_OK" });
console.log("bash:", JSON.stringify(r));
r = await executeTool(root, "glob", { pattern: "**/*.js" });
console.log("glob:", JSON.stringify(r));
r = await executeTool(root, "grep", { pattern: "a=2", path: "src" });
console.log("grep:", JSON.stringify(r).slice(0, 160));
r = await executeTool(root, "list_dir", { path: ".", depth: 3 });
console.log("list_dir:", JSON.stringify(r).slice(0, 140));
r = await executeTool(root, "bash", { command: "git init -q . && git add -A && git -c user.email=t@t -c user.name=t commit -qm init" });
r = await executeTool(root, "git", { op: "status" });
console.log("git status:", JSON.stringify(r).slice(0, 140));
r = await executeTool(root, "bash", { command: "echo hi", timeout_ms: 99999999 });
console.log("timeout clamp ok:", r.ok === true);
r = await executeTool(root, "nope", {});
console.log("unknown tool:", JSON.stringify(r).slice(0, 80));

// protocol parser round-trip
const { parseReply, formatResults, protocolPreamble } = await import("./harness.mjs");
const reply1 = `Let me look at the files.\n⟦TOOL⟧ {"id":"t1","name":"bash","args":{"command":"ls"}}\n⟦TOOL⟧ {"id":"t2","name":"read_file","args":{"path":"a.js"}}\n⟦END⟧`;
const p1 = parseReply(reply1);
console.log("parse tools:", JSON.stringify(p1.tools), "done:", p1.done);
const reply2 = `⟦DONE⟧ {"summary":"all good"}`;
console.log("parse done:", JSON.stringify(parseReply(reply2).done));
const reply3 = "I think the best approach is to refactor everything carefully.";
console.log("parse nudge-case:", JSON.stringify(parseReply(reply3)));
const fmt = formatResults([{ id: "t1", ok: true, exit: 0, stdout: "file1\nfile2\n" }, { id: "t2", ok: false, error: "boom" }], { round: 2, maxRounds: 40 });
console.log("formatResults:\n" + fmt);
const pre = protocolPreamble(root);
console.log("preamble bytes:", Buffer.byteLength(pre), "| has root:", pre.includes(root), "| has tool schema:", pre.includes("bash"));
console.log("preamble tail:\n" + pre.slice(-400));
