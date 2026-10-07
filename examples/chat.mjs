// Send a message to a channel and wait for the AI's answer — pure API, no UI.
// Usage: node examples/chat.mjs "your question" [channelId]
import SuperAppClient from "../superapp.mjs";

const text = process.argv[2] ?? "Hello from automation — reply with one short sentence.";
const channelId = process.argv[3] ?? "9071aa0e-dad9-4079-bd77-2a2d2c58521a"; // Home thread

const client = process.env.SUPERAPP_COOKIE
  ? new SuperAppClient({ cookies: process.env.SUPERAPP_COOKIE })
  : await SuperAppClient.fromCookieFile(new URL("../cookies.json", import.meta.url).pathname);

console.log(`Sending: ${text}`);
try {
  const { threadRootId } = await client.send(channelId, text);
  console.log("Accepted, thread:", threadRootId);

  const { text: answer } = await client.waitForReply(channelId, threadRootId, { timeoutMs: 120000 });
  console.log("\nSuperApp replied:\n" + answer);
} finally {
  await client.save(); // persist rotated session cookie
  client.closeGateway();
}
