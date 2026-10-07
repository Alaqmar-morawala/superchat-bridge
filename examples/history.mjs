// Print the latest messages of a channel (newest first).
// Usage: node examples/history.mjs [channelId] [limit]
import SuperAppClient from "../superapp.mjs";

const channelId = process.argv[2] ?? "9071aa0e-dad9-4079-bd77-2a2d2c58521a";
const limit = Number(process.argv[3] ?? 10);

const client = process.env.SUPERAPP_COOKIE
  ? new SuperAppClient({ cookies: process.env.SUPERAPP_COOKIE })
  : await SuperAppClient.fromCookieFile(new URL("../cookies.json", import.meta.url).pathname);

const msgs = await client.history(channelId, { limit });
for (const m of msgs) {
  const who = m.role === "assistant" ? (m.asst_name ?? "SuperApp") : (m.user_email ?? m.user_name ?? m.role);
  const body = SuperAppClient.answerText(m) || JSON.stringify(m.content).slice(0, 120);
  console.log(`[${m.created_at}] ${who}: ${body.slice(0, 300)}`);
}
