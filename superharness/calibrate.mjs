/** Calibrate protocol compliance across the three frontier presets. */
import SuperAppClient from "../superapp.mjs";
import { AgentLoop } from "./harness.mjs";

const PRESETS = {
  astra: "openai/gpt-6-astra",
  sol: "openai/gpt-6.1-sol",
  opus: "anthropic/claude-opus-5-5",
};

const client = await SuperAppClient.fromCookieFile(new URL("../cookies.json", import.meta.url).pathname);
const root = "/tmp/sh-calib";
const fs = await import("node:fs");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

for (const [name, model] of Object.entries(PRESETS)) {
  const t0 = Date.now();
  console.log(`\n=== ${name} (${model}) ===`);
  try {
    const loop = new AgentLoop(client, {
      root,
      channelId: "9071aa0e-dad9-4079-bd77-2a2d2c58521a",
      model,
      maxRounds: 12,
      timeoutMs: 8 * 60_000,
      onEvent: (ev) => {
        if (ev.type === "tool-call") console.log(`  ⚙ ${ev.call.name} ${JSON.stringify(ev.call.args).slice(0, 100)}`);
        if (ev.type === "protocol-warn") console.log(`  ! drift: ${ev.errors.join("; ")}`);
        if (ev.type === "stalled") console.log("  … stalled");
      },
    });
    const r = await loop.run(
      `Create a file named ${name}-calib.txt whose only content is the single word CALIBRATED. Verify by reading it back, then finish.`,
    );
    const content = fs.existsSync(`${root}/${name}-calib.txt`)
      ? fs.readFileSync(`${root}/${name}-calib.txt`, "utf8").trim()
      : "(file missing)";
    console.log(`  result: ok=${r.ok} rounds=${r.rounds} ${Math.round((Date.now() - t0) / 1000)}s file="${content}"`);
    console.log(`  summary: ${r.summary?.slice(0, 140)}`);
  } catch (e) {
    console.log(`  FAILED: ${e.message.slice(0, 200)} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
}
client.closeGateway();
await client.save();
