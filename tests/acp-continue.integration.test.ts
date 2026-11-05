import { afterEach, expect, test } from "bun:test";
import { startAcp, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { cleanUpAfterEach, fixture } from "./support/scripting";

// Added before the fixture's own cleanup, so the agents have stopped before their folders are removed (see acp.integration).
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();

test("casper acp --continue: session/new picks up the folder's latest conversation, as casper --continue does", async () => {
  const f = await fixture((request) => ({ text: `answer ${request}` }));
  const first = startAcp(f);
  clients.push(first);
  await first.request("initialize", { protocolVersion: 1 });
  const { sessionId } = await first.request("session/new", { cwd: f.project, mcpServers: [] });
  expect((await first.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Remember the word kestrel" }] })).stopReason).toBe("end_turn");
  expect(await first.close()).toBe(0);

  const again = startAcp(f, ["--continue"]);
  clients.push(again);
  await again.request("initialize", { protocolVersion: 1 });
  const continued = await again.request("session/new", { cwd: f.project, mcpServers: [] });
  expect(continued.sessionId).toBe(sessionId);
  await again.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Which word?" }] });
  expect(JSON.stringify(f.payloads.at(-1)!.messages)).toContain("kestrel");
}, childTestLimit(2));
