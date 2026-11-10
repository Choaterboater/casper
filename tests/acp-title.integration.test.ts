import { afterEach, expect, test } from "bun:test";
import { startAcp, until, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { cleanUpAfterEach, fixture } from "./support/scripting";
import { httpFixture } from "./fixtures/mcp-http-server";

// The app's chat title over ACP (decision 96), against a real `casper acp` router and its session child. The agents stop
// before the fixture's folders are removed (see acp.integration).
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();
const open = (...args: Parameters<typeof startAcp>) => { const client = startAcp(...args); clients.push(client); return client; };

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
const text = (words: string) => [{ type: "text", text: words }];
const onlyProtocol = (client: AcpClient) => { for (const line of client.lines) expect(JSON.parse(line).jsonrpc).toBe("2.0"); };
const messages = (client: AcpClient) => client.lines.map((line) => JSON.parse(line) as Record<string, any>);
/** Every session_info_update the session sent, in order. */
const titles = (client: AcpClient, sessionId: string) => client.updates
  .filter((update) => update.sessionId === sessionId && update.update.sessionUpdate === "session_info_update").map((update) => update.update);

test("The first prompt names the chat once, hidden; a typed /rename and a load send the new name", async () => {
  // Short enough to stay whole in the title, long enough to be hidden.
  const token = `ln${crypto.randomUUID().slice(0, 8)}`;
  const server = await httpFixture(token);
  try {
    const f = await fixture(() => ({ text: "Done." }));
    const client = open(f);
    const init = await client.request("initialize", INIT);
    expect(init.agentCapabilities._meta.casper.title).toBe(true);
    const { sessionId } = await client.request("session/new", { cwd: f.project,
      mcpServers: [{ type: "http", name: "app", url: server.url, headers: [{ name: "Authorization", value: `Bearer ${token}` }] }] });
    // A new conversation has no name yet: no title with the reply.
    expect(titles(client, sessionId)).toEqual([]);

    expect((await client.request("session/prompt", { sessionId, prompt: text(`Say hello to the lantern ${token}`) })).stopReason).toBe("end_turn");
    const [first, ...more] = titles(client, sessionId);
    expect(more).toEqual([]);
    expect(first).toEqual({ sessionUpdate: "session_info_update", title: "Say hello to the lantern <secret hidden>", updatedAt: expect.any(String) });
    expect(new Date(first!.updatedAt).toISOString()).toBe(first!.updatedAt);
    expect(client.lines.filter((line) => line.includes("session_info_update")).join("\n")).not.toContain(token);
    // The title is sent as the prompt starts, before the model's first words (not only with the receipt at the end).
    const all = messages(client).map((message) => message.params?.update?.sessionUpdate);
    expect(all.indexOf("agent_message_chunk")).toBeGreaterThan(-1);
    expect(all.indexOf("session_info_update")).toBeLessThan(all.indexOf("agent_message_chunk"));

    // A second prompt keeps the name: nothing is sent again.
    expect((await client.request("session/prompt", { sessionId, prompt: text("And a second thing") })).stopReason).toBe("end_turn");
    expect(titles(client, sessionId)).toHaveLength(1);

    // A typed /rename is sent once, as the new title.
    expect((await client.request("session/prompt", { sessionId, prompt: text("/rename Garden shed") })).stopReason).toBe("end_turn");
    expect(titles(client, sessionId).map((update) => update.title)).toEqual(["Say hello to the lantern <secret hidden>", "Garden shed"]);
    onlyProtocol(client);
    expect(await client.close()).toBe(0);

    // A load sends the stored name once, after its reply.
    const again = open(f);
    await again.request("initialize", INIT);
    await again.request("session/load", { sessionId, cwd: f.project, mcpServers: [] });
    await until(() => titles(again, sessionId).length === 1, 30_000, "the loaded conversation's title");
    expect(titles(again, sessionId)[0]).toMatchObject({ title: "Garden shed", updatedAt: expect.any(String) });
    const loaded = messages(again);
    const reply = loaded.findIndex((message) => message.id === 2 && message.method === undefined);
    expect(loaded.findIndex((message) => message.params?.update?.sessionUpdate === "session_info_update")).toBeGreaterThan(reply);
    expect((await again.request("session/prompt", { sessionId, prompt: text("Go on") })).stopReason).toBe("end_turn");
    expect(titles(again, sessionId)).toHaveLength(1);
    onlyProtocol(again);
  } finally { await server.close(); }
}, childTestLimit(2));

test("A client token longer than the title's first word is hidden, not cut into the chat list", async () => {
  const token = `lt${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().slice(0, 14)}`;
  const server = await httpFixture(token);
  try {
    const f = await fixture(() => ({ text: "Done." }));
    const client = open(f);
    await client.request("initialize", INIT);
    const { sessionId } = await client.request("session/new", { cwd: f.project,
      mcpServers: [{ type: "http", name: "app", url: server.url, headers: [{ name: "Authorization", value: `Bearer ${token}` }] }] });
    expect((await client.request("session/prompt", { sessionId, prompt: text(`${token} gets a 401 from the server, why`) })).stopReason).toBe("end_turn");
    expect(titles(client, sessionId).map((update) => update.title)).toEqual(["<secret hidden>…"]);
    const sent = client.lines.filter((line) => line.includes("session_info_update")).join("\n");
    for (let start = 0; start + 6 <= token.length; start++) expect(sent).not.toContain(token.slice(start, start + 6));
    onlyProtocol(client);
  } finally { await server.close(); }
}, childTestLimit(1));
