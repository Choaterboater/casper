import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startAcp, until, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { cleanUpAfterEach, fixProject, fixture, shellCheckTest, type Payload, type Step } from "./support/scripting";
import { httpFixture } from "./fixtures/mcp-http-server";
import { projectStateDirectory } from "../src/project/model";

// Casper's lines for the person (selected skills, memory, a refused app server) reach an ACP app as notes (decision 88),
// against a real `casper acp` child and the scripted provider.
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();
const open = (...args: Parameters<typeof startAcp>) => { const client = startAcp(...args); clients.push(client); return client; };

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
const text = (words: string) => [{ type: "text", text: words }];
const isChecklistCall = (payload: Payload) => JSON.stringify(payload.messages).includes("Casper checklist.");
const ofSession = (client: AcpClient, sessionId: string) => client.updates.filter((update) => update.sessionId === sessionId).map((update) => update.update);
const since = (client: AcpClient, sessionId: string, from: number) => client.updates.slice(from).filter((update) => update.sessionId === sessionId).map((update) => update.update);
/** The text of every note Casper sent the session. */
const notes = (client: AcpClient, sessionId: string) => ofSession(client, sessionId).flatMap((update) => update.sessionUpdate === "agent_message_chunk" && update._meta?.casper?.note === true ? [String(update.content.text)] : []);
const allText = (client: AcpClient, sessionId: string) => ofSession(client, sessionId).flatMap((update) => update.sessionUpdate === "agent_message_chunk" ? [String(update.content.text)] : []).join("");
const onlyProtocol = (client: AcpClient) => { for (const line of client.lines) expect(JSON.parse(line).jsonrpc).toBe("2.0"); };
const commandsSent = (client: AcpClient) => client.updates.some((update) => update.update.sessionUpdate === "available_commands_update");

/** A skill of your own, picked for a request that says `tag`. */
async function ownSkill(f: Awaited<ReturnType<typeof fixture>>, name: string, tag: string): Promise<void> {
  const folder = path.join(f.home, ".casper/skills", tag);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Guidance for ${tag} work\ntags: [${tag}]\n---\nSay hello to the ${tag}.\n`);
}

shellCheckTest("Selected skills and memory lines arrive as notes, the checking line does not, and stderr keeps every line", async () => {
  const f = await fixture((_request, payload): Step => isChecklistCall(payload) ? { text: "[]" }
    : payload.messages.at(-1)?.role === "tool" ? { text: "Fixed sum.js." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] });
  await fixProject(f);
  await ownSkill(f, "sum-fixes", "sum");
  // Memory Casper cannot read: it says so before the task.
  for (const root of new Set([f.project, realpathSync(f.project)])) {
    const state = projectStateDirectory(root, f.home);
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, "memory.jsonl"), "not json\n");
  }
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Fix the sum in sum.js") })).stopReason).toBe("end_turn");
  const lines = [" skills selected: sum-fixes", "[memory] Facts unavailable"];
  await until(() => lines.every((line) => notes(client, sessionId).some((note) => note.includes(line))), 30_000, "the notes");
  await until(() => [...lines, "• Casper checking: test"].every((line) => client.stderr().includes(line)), 30_000, "every line on stderr");
  expect(allText(client, sessionId)).not.toContain("Casper checking");
  // Each note once, and none of the model's words is one.
  for (const line of lines) expect(notes(client, sessionId).filter((note) => note.includes(line))).toHaveLength(1);
  expect(notes(client, sessionId).join("")).not.toContain("Fixed sum.js.");
  onlyProtocol(client);
}, childTestLimit(1));

const MCP_FIXTURE = path.join(import.meta.dir, "fixtures/mcp-server.ts");

test("A refused app server's note is the first update of the first prompt, and an accepted server's note is never sent", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [
    { type: "sse", name: "old", url: "http://127.0.0.1:9/sse", headers: [] },
    { name: "app", command: process.execPath, args: [MCP_FIXTURE], env: [{ name: "FIXTURE_MODE", value: "generic" }, { name: "FIXTURE_CALLS_FILE", value: path.join(f.root, "calls.jsonl") }] },
  ] });
  await until(() => commandsSent(client), 30_000, "the commands");
  const refused = "[acp] The app's MCP server acp-old is not connected: SSE is not supported.";
  await until(() => [refused, "[acp] The app's MCP server acp-app connects for this session."].every((line) => client.stderr().includes(line)), 30_000, "both server lines on stderr");
  let before = client.updates.length;
  expect((await client.request("session/prompt", { sessionId, prompt: text("Hello") })).stopReason).toBe("end_turn");
  expect(since(client, sessionId, before)[0]).toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${refused}\n` }, _meta: { casper: { note: true } } });
  // Said once: the next prompt does not repeat it.
  before = client.updates.length;
  expect((await client.request("session/prompt", { sessionId, prompt: text("Hello again") })).stopReason).toBe("end_turn");
  expect(JSON.stringify(since(client, sessionId, before))).not.toContain("acp-old");
  expect(client.lines.join("\n")).not.toContain("connects for this session");
  onlyProtocol(client);
}, childTestLimit(1));

test("A note written during a slash command before the model speaks appears once", async () => {
  const f = await fixture(() => ({ text: "Hello, lantern." }));
  await ownSkill(f, "lantern-care", "lantern");
  await mkdir(path.join(f.home, ".casper", "commands"), { recursive: true });
  await writeFile(path.join(f.home, ".casper", "commands", "greet.md"), "---\ndescription: Greet something\n---\nSay hello to the lantern.\n");
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  expect((await client.request("session/prompt", { sessionId, prompt: text("/greet") })).stopReason).toBe("end_turn");
  await until(() => allText(client, sessionId).includes("Hello, lantern."), 30_000, "the model's answer");
  expect(allText(client, sessionId).split("skills selected: lantern-care")).toHaveLength(2);
  onlyProtocol(client);
}, childTestLimit(1));

test("A skill name holding an app header value is sent hidden", async () => {
  const token = `acp-bearer-${crypto.randomUUID()}`;
  const server = await httpFixture(token);
  try {
    const f = await fixture(() => ({ text: "Done." }));
    await ownSkill(f, token, "lantern");
    const client = open(f);
    await client.request("initialize", INIT);
    const { sessionId } = await client.request("session/new", { cwd: f.project,
      mcpServers: [{ type: "http", name: "app", url: server.url, headers: [{ name: "Authorization", value: `Bearer ${token}` }] }] });
    expect((await client.request("session/prompt", { sessionId, prompt: text("Say hello to the lantern") })).stopReason).toBe("end_turn");
    await until(() => notes(client, sessionId).some((note) => note.includes("skills selected: <secret hidden>")), 30_000, "the skills note");
    expect(client.lines.join("\n")).not.toContain(token);
    await until(() => client.stderr().includes("skills selected: <secret hidden>"), 30_000, "the skills line on stderr");
    expect(client.stderr()).not.toContain(token);
    onlyProtocol(client);
  } finally { await server.close(); }
}, childTestLimit(1));
