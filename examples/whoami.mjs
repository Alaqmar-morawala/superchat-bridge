// Snapshot of your SuperApp account: session, workspaces, channels, models, unread.
// Usage: node examples/whoami.mjs
import SuperAppClient from "../superapp.mjs";

const client = process.env.SUPERAPP_COOKIE
  ? new SuperAppClient({ cookies: process.env.SUPERAPP_COOKIE })
  : await SuperAppClient.fromCookieFile(new URL("../cookies.json", import.meta.url).pathname);

const accounts = await client.accounts();
console.log("Session:", accounts.map((a) => `${a.email} (session ${a.session_id.slice(0, 8)}…)`));

const ws = await client.workspaces();
console.log("\nWorkspace:", ws.active_workspace_id, "—", ws.workspaces.map((w) => `${w.name} [${w.role}]`).join(", "));

const rooms = await client.channels();
console.log(`\nChannels/threads (${rooms.length}):`);
for (const r of rooms) {
  console.log(`  ${r.id}  ${r.description ?? r.display_name ?? "(unnamed)"}${r.is_dm ? " [DM]" : ""}`);
}

const models = await client.models();
console.log("\nModels catalog:", JSON.stringify(models).slice(0, 600));

console.log("\nUnread:", JSON.stringify(await client.unread()));
