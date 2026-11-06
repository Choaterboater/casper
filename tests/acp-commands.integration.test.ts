import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentText, startAcp, until, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { cleanUpAfterEach, fixture } from "./support/scripting";
import { httpFixture } from "./fixtures/mcp-http-server";

// Casper's / commands over ACP (decision 80), against a real `casper acp` router and its session child.
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();
const open = (...args: Parameters<typeof startAcp>) => { const client = startAcp(...args); clients.push(client); return client; };

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
const text = (words: string) => [{ type: "text", text: words }];
const onlyProtocol = (client: AcpClient) => { for (const line of client.lines) expect(JSON.parse(line).jsonrpc).toBe("2.0"); };
const messages = (client: AcpClient) => client.lines.map((line) => JSON.parse(line) as Record<string, any>);
/** Where in the agent's stdout the reply to request `id` is, and each commands update. */
const replyAt = (client: AcpClient, id: number) => messages(client).findIndex((message) => message.id === id && message.method === undefined);
const commandsAt = (client: AcpClient) => messages(client).flatMap((message, index) => message.params?.update?.sessionUpdate === "available_commands_update" ? [index] : []);
const lists = (client: AcpClient, sessionId: string) => client.updates.filter((update) => update.sessionId === sessionId && update.update.sessionUpdate === "available_commands_update")
  .map((update) => update.update.availableCommands as Array<{ name: string; description: string; input?: { hint: string } }>);
/** The updates the last prompt sent: everything after the one before it. */
const since = (client: AcpClient, sessionId: string, from: number) => client.updates.slice(from).filter((update) => update.sessionId === sessionId).map((update) => update.update);

test("the / commands come after the session/new reply and again after a load; /status is Casper's reply in one block, with no echo and no empty receipt", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  // Request 2 is session/new: its commands follow its reply.
  await until(() => commandsAt(client).length === 1, 30_000, "the commands");
  expect(commandsAt(client)[0]).toBeGreaterThan(replyAt(client, 2));
  const [list] = lists(client, sessionId);
  expect(list!.map((command) => command.name)).toEqual(expect.arrayContaining(["status", "review", "mcp", "diff", "usage", "plan"]));
  for (const name of ["clear", "resume", "pane", "theme", "login", "effort", "model", "permissions", "export"]) expect(list!.map((command) => command.name)).not.toContain(name);
  expect(list!.find((command) => command.name === "review")).toEqual({ name: "review", description: expect.any(String), input: { hint: "[branch|commit]" } });

  // A request first, so there is a saved conversation to load.
  expect((await client.request("session/prompt", { sessionId, prompt: text("Hello") })).stopReason).toBe("end_turn");
  const calls = f.payloads.length;
  const before = client.updates.length;
  const done = await client.request("session/prompt", { sessionId, prompt: text("/status") });
  expect(done.stopReason).toBe("end_turn");
  expect(done._meta.casper.error).toBeUndefined();
  const updates = since(client, sessionId, before);
  // Only the command's output: no echo of the line, no receipt line, no model call.
  expect(updates.every((update) => update.sessionUpdate === "agent_message_chunk" && !update._meta)).toBe(true);
  const shown = updates.map((update) => update.content.text).join("");
  expect(shown).toStartWith("````text\n");
  expect(shown).toEndWith("\n````\n");
  expect(shown).toContain(" mcp       ");
  expect(shown).not.toContain("/status");
  expect(f.payloads).toHaveLength(calls);
  // The list did not change, so it is not sent again.
  expect(commandsAt(client)).toHaveLength(1);
  onlyProtocol(client);
  expect(await client.close()).toBe(0);

  // A loaded conversation gets the list after its reply, after the conversation it replays.
  const again = open(f);
  await again.request("initialize", INIT);
  await again.request("session/load", { sessionId, cwd: f.project, mcpServers: [] });
  await until(() => commandsAt(again).length === 1, 30_000, "the commands after a load");
  expect(commandsAt(again)[0]).toBeGreaterThan(replyAt(again, 2));
  expect(lists(again, sessionId)[0]).toEqual(list!);
  onlyProtocol(again);
}, childTestLimit(2));

test("an unknown command ends the turn with its error; /clear is refused and the conversation is kept; [plan] lines are notes", async () => {
  const f = await fixture(() => ({ text: "Noted." }));
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  expect((await client.request("session/prompt", { sessionId, prompt: text("The code word is PLUM") })).stopReason).toBe("end_turn");

  let before = client.updates.length;
  const unknown = await client.request("session/prompt", { sessionId, prompt: text("/nope") });
  expect(unknown.stopReason).toBe("end_turn");
  expect(unknown._meta.casper.error).toContain("/nope");
  expect(since(client, sessionId, before).map((update) => update.content?.text)).toContainEqual(expect.stringMatching(/^\[error\] .*\/nope/));

  before = client.updates.length;
  const cleared = await client.request("session/prompt", { sessionId, prompt: text("/clear") });
  const refused = "/clear starts a new conversation inside Casper, but this app keeps its own chats: start a new chat in the app. Nothing changed.";
  expect(cleared).toEqual({ stopReason: "end_turn", _meta: { casper: { refused } } });
  expect(since(client, sessionId, before)).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${refused}\n` } }]);

  // Plan mode's own line is for the person: a note, not a block.
  before = client.updates.length;
  await client.request("session/prompt", { sessionId, prompt: text("/plan off") });
  expect(since(client, sessionId, before).map((update) => update.content?.text)).toContain("[plan] Plan mode off.\n");

  // The same conversation: the model still has the first turn.
  const calls = f.payloads.length;
  await client.request("session/prompt", { sessionId, prompt: text("What was the code word?") });
  expect(f.payloads).toHaveLength(calls + 1);
  expect(JSON.stringify(f.payloads.at(-1)!.messages)).toContain("The code word is PLUM");
  expect(agentText(client.updates, sessionId)).toContain("Noted.");
  onlyProtocol(client);
}, childTestLimit(1));

test("a command file you add is in the list the next prompt sends, before its reply; your command runs as a request", async () => {
  const f = await fixture(() => ({ text: "Shipped." }));
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  await until(() => commandsAt(client).length === 1, 30_000, "the commands");
  await mkdir(path.join(f.home, ".casper", "commands"), { recursive: true });
  await writeFile(path.join(f.home, ".casper", "commands", "ship.md"), "---\ndescription: Ship the build\nargument-hint: <env>\n---\nShip the build to $1.\n");
  const done = await client.request("session/prompt", { sessionId, prompt: text("/ship staging") });
  expect(done.stopReason).toBe("end_turn");
  // Request 3 is this prompt: the new list comes before its reply.
  expect(commandsAt(client)).toHaveLength(2);
  expect(commandsAt(client)[1]).toBeLessThan(replyAt(client, 3));
  expect(lists(client, sessionId)[1]!.at(-1)).toEqual({ name: "ship", description: "Ship the build", input: { hint: "<env>" } });
  // The file's text, with the words in it, went to the model, and its answer is the reply.
  expect(JSON.stringify(f.payloads.at(-1)!.messages)).toContain("Ship the build to staging.");
  expect(agentText(client.updates, sessionId)).toContain("Shipped.");
  onlyProtocol(client);
}, childTestLimit(1));

test("/mcp detail over ACP never shows the bearer value the app gave its server", async () => {
  const token = `acp-bearer-${crypto.randomUUID()}`;
  const server = await httpFixture(token);
  try {
    const f = await fixture(() => ({ text: "Done." }));
    const client = open(f);
    await client.request("initialize", INIT);
    const { sessionId } = await client.request("session/new", { cwd: f.project,
      mcpServers: [{ type: "http", name: "app", url: server.url, headers: [{ name: "Authorization", value: `Bearer ${token}` }] }] });
    const before = client.updates.length;
    const done = await client.request("session/prompt", { sessionId, prompt: text("/mcp detail") });
    expect(done.stopReason).toBe("end_turn");
    const shown = since(client, sessionId, before).map((update) => update.content?.text ?? "").join("");
    expect(shown).toStartWith("````text\n");
    expect(shown).toContain("acp-app");
    expect(client.lines.join("\n")).not.toContain(token);
    expect(client.stderr()).not.toContain(token);
    onlyProtocol(client);
  } finally { await server.close(); }
}, childTestLimit(1));
