import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { startAcp, until, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { cleanUpAfterEach, fixture, lastUser, type Payload, type Step } from "./support/scripting";

// An ACP app forks a Casper conversation (decision 97), against a real `casper acp` router, its session children and
// the scripted provider (fixture/first: no effort levels; fixture/second: reasoning).
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();
const open = (...args: Parameters<typeof startAcp>) => { const client = startAcp(...args); clients.push(client); return client; };

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
const text = (words: string) => [{ type: "text", text: words }];
type Option = { id: string; currentValue: string };
const optionOf = (options: Option[], id: string) => options.find((option) => option.id === id);
const refusal = (reply: Promise<unknown>) => reply.then(() => undefined, (error: { code: number; message: string }) => ({ code: error.code, message: error.message }));
/** The words of each user_message_chunk a session got, in order: a load's replay. */
const replayed = (client: AcpClient, sessionId: string) => client.updates.filter((update) => update.sessionId === sessionId && update.update.sessionUpdate === "user_message_chunk")
  .map((update) => update.update.content.text as string);
/** The model call whose last user words carry `marker`. */
const askedWith = (payloads: Payload[], marker: string) => payloads.find((payload) => lastUser(payload).includes(marker));
/** Every saved conversation file under the fixture's home. */
const conversationFiles = async (home: string) => (await readdir(home, { recursive: true })).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(home, name));
const conversationFile = async (home: string, id: string) => (await conversationFiles(home)).find((file) => file.endsWith(`_${id}.jsonl`))!;

const MCP_FIXTURE = path.join(import.meta.dir, "fixtures/mcp-server.ts");
/** A stdio server entry the way ACP lists one, as the app's own (decision 89). */
const stdioEntry = (calls: string) => ({ name: "app", command: process.execPath, args: [MCP_FIXTURE],
  env: [{ name: "FIXTURE_MODE", value: "generic" }, { name: "FIXTURE_CALLS_FILE", value: calls }], _meta: { "casper/clientAsks": true } });
/** Every session_info_update a session got, in order: its chat titles (decision 96). */
const titles = (client: AcpClient, sessionId: string) => client.updates
  .filter((update) => update.sessionId === sessionId && update.update.sessionUpdate === "session_info_update").map((update) => update.update.title as string);
const toolsCalled = async (file: string) => existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line).tool as string) : [];

/** A conversation file's entries after its header, each line parsed: a torn line throws. */
const entriesOf = async (file: string) => (await readFile(file, "utf8")).split("\n").filter(Boolean).slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);

/** "Done." to everything; a request that names the app's server calls its status tool first; "Wait for me" waits for
 * `held`. */
const script = (held: Promise<void>) => async (_request: number, payload: Payload): Promise<Step> => {
  const last = lastUser(payload);
  if (last.includes("Wait for me")) await held;
  if (last.includes("app's server") && payload.messages.at(-1)?.role !== "tool") return { tools: [{ name: "call_capability", args: { id: "mcp:acp-app:status", arguments: {} } }] };
  return { text: "Done." };
};

describe("an ACP app forks a Casper conversation (decision 97)", () => {
  test("A fork with no mark copies the whole conversation under a new ID, on its model and effort, with the app's servers; the source is unchanged", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture(script(held));
    try {
      const calls = path.join(f.root, "calls.jsonl");
      // The app starts every Casper with its own start model, as it does for a load (decision 89).
      const client = open(f, ["--model", "fixture/first"]);
      await client.request("initialize", INIT);
      const source = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
      await client.request("session/set_config_option", { sessionId: source, configId: "model", value: "fixture/second" });
      await client.request("session/set_config_option", { sessionId: source, configId: "effort", value: "high" });
      expect((await client.request("session/prompt", { sessionId: source, prompt: text("Say ONE") })).stopReason).toBe("end_turn");
      expect((await client.request("session/prompt", { sessionId: source, prompt: text("Say TWO") })).stopReason).toBe("end_turn");
      const sourceFile = await conversationFile(f.home, source);
      const before = await readFile(sourceFile, "utf8");
      const files = await conversationFiles(f.home);
      // The first prompt named the source chat (decision 96).
      const [name] = titles(client, source);
      expect(name).toBeTruthy();

      const forked = await client.request("session/fork", { sessionId: source, cwd: f.project, mcpServers: [stdioEntry(calls)] });
      const copy = forked.sessionId as string;
      // The copy is the one new conversation file: the fork leaves no empty one behind.
      expect((await conversationFiles(f.home)).sort()).toEqual([...files, await conversationFile(f.home, copy)].sort());
      expect(copy).toMatch(/^[0-9a-f-]{36}$/);
      expect(copy).not.toBe(source);
      expect(optionOf(forked.configOptions, "model")!.currentValue).toBe("fixture/second");
      expect(optionOf(forked.configOptions, "effort")!.currentValue).toBe("high");
      expect(forked.modes.currentModeId).toBeDefined();
      // A fork replays nothing: the app already shows the conversation.
      expect(replayed(client, copy)).toEqual([]);
      // The copy's stored name is its chat title, sent once after the fork's reply, as a load sends it.
      await until(() => titles(client, copy).length === 1, 30_000, "the forked conversation's title");
      expect(titles(client, copy)).toEqual([name!]);
      const sent = client.lines.map((line) => JSON.parse(line) as Record<string, any>);
      const reply = sent.findIndex((message) => message.method === undefined && message.result?.sessionId === copy);
      expect(reply).toBeGreaterThan(-1);
      expect(sent.findIndex((message) => message.params?.sessionId === copy && message.params?.update?.sessionUpdate === "session_info_update")).toBeGreaterThan(reply);
      // The forked session connected the app's server: its process got the client's mcpServers.
      await until(() => client.stderr().includes("[acp] The app's MCP server acp-app connects for this session."), 30_000, "the app server line on stderr");

      // A prompt to the new ID reaches the fork: it knows the whole conversation, calls the app's tool, and runs on the
      // source's model and effort.
      expect((await client.request("session/prompt", { sessionId: copy, prompt: text("Ask the app's server for its status") })).stopReason).toBe("end_turn");
      expect(await toolsCalled(calls)).toEqual(["status"]);
      // The copy keeps its name: a prompt to it sends no new title.
      expect(titles(client, copy)).toEqual([name!]);
      const asked = askedWith(f.payloads, "app's server")!;
      expect(asked).toMatchObject({ model: "second", reasoning_effort: "high" });
      expect(JSON.stringify(asked.messages)).toContain("Say ONE");
      expect(JSON.stringify(asked.messages)).toContain("Say TWO");
      // A set reaches the fork only.
      const set = await client.request("session/set_config_option", { sessionId: copy, configId: "effort", value: "low" });
      expect(optionOf(set.configOptions, "effort")!.currentValue).toBe("low");
      // A cancel reaches the fork.
      const waiting = client.request("session/prompt", { sessionId: copy, prompt: text("Wait for me") });
      await until(() => askedWith(f.payloads, "Wait for me"), 60_000, "the fork's model request");
      client.notify("session/cancel", { sessionId: copy });
      expect((await waiting).stopReason).toBe("cancelled");
      release();
      // The source conversation's file is as it was.
      expect(await readFile(sourceFile, "utf8")).toBe(before);
      expect(await client.close()).toBe(0);

      const again = open(f);
      await again.request("initialize", INIT);
      await again.request("session/load", { sessionId: copy, cwd: f.project, mcpServers: [] });
      expect(replayed(again, copy).slice(0, 2)).toEqual(["Say ONE", "Say TWO"]);
      await again.request("session/load", { sessionId: source, cwd: f.project, mcpServers: [] });
      expect(replayed(again, source)).toEqual(["Say ONE", "Say TWO"]);
    } finally { release(); }
  }, childTestLimit(2));

  test("A fork at a prompt's mark keeps the conversation up to that prompt; an unknown mark or conversation is refused and writes nothing", async () => {
    const f = await fixture(script(Promise.resolve()));
    // With the app's own start model, as apps start Casper (decision 89): a fork records it on no file of its own.
    const client = open(f, ["--model", "fixture/second"]);
    await client.request("initialize", INIT);
    const source = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
    const one = await client.request("session/prompt", { sessionId: source, prompt: text("Say ONE") });
    const two = await client.request("session/prompt", { sessionId: source, prompt: text("Say TWO") });
    const mark = one._meta.casper.mark as string;
    expect(mark).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(two._meta.casper.mark).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(two._meta.casper.mark).not.toBe(mark);

    const files = await conversationFiles(f.home);
    expect(await refusal(client.request("session/fork", { sessionId: source, cwd: f.project, mcpServers: [], _meta: { casper: { at: "ffffffff" } } })))
      .toMatchObject({ code: -32602, message: expect.stringContaining("ffffffff") });
    const missing = await refusal(client.request("session/fork", { sessionId: "no-such-conversation", cwd: f.project, mcpServers: [] }));
    expect(missing).toMatchObject({ code: -32002, message: expect.stringContaining("No saved conversation no-such-conversation") });
    expect(await refusal(client.request("session/fork", { sessionId: source, cwd: f.project, mcpServers: [], _meta: { casper: { at: "../x" } } })))
      .toMatchObject({ code: -32602 });
    expect((await conversationFiles(f.home)).sort()).toEqual(files.sort());

    const copy = (await client.request("session/fork", { sessionId: source, cwd: f.project, mcpServers: [], _meta: { casper: { at: mark } } })).sessionId as string;
    expect(copy).not.toBe(source);
    expect((await conversationFiles(f.home)).sort()).toEqual([...files, await conversationFile(f.home, copy)].sort());
    expect((await client.request("session/prompt", { sessionId: copy, prompt: text("Say THREE") })).stopReason).toBe("end_turn");
    const asked = JSON.stringify(askedWith(f.payloads, "Say THREE")!.messages);
    expect(asked).toContain("Say ONE");
    expect(asked).not.toContain("Say TWO");
    expect(await client.close()).toBe(0);

    const again = open(f);
    await again.request("initialize", INIT);
    await again.request("session/load", { sessionId: copy, cwd: f.project, mcpServers: [] });
    expect(replayed(again, copy)).toEqual(["Say ONE", "Say THREE"]);
  }, childTestLimit(2));

  test("A fork while the source's own process answers a prompt copies whole entries only, a prefix of the source, and never writes to it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture(script(held));
    try {
      const client = open(f);
      await client.request("initialize", INIT);
      const source = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
      const one = await client.request("session/prompt", { sessionId: source, prompt: text("Say ONE") });
      const sourceFile = await conversationFile(f.home, source);
      // The source's process is in a prompt: its request is on disk and its answer is still to come.
      const waiting = client.request("session/prompt", { sessionId: source, prompt: text("Wait for me") });
      waiting.catch(() => {});
      await until(() => askedWith(f.payloads, "Wait for me"), 60_000, "the source's model request");
      const during = await readFile(sourceFile, "utf8");

      // An entry the source is still writing: half of its line is on disk when the fork reads the file.
      const line = JSON.stringify({ ...(await entriesOf(sourceFile)).at(-1), id: "f0f0f0f0" });
      const half = Math.floor(line.length / 2);
      await appendFile(sourceFile, line.slice(0, half));
      const cut = (await client.request("session/fork", { sessionId: source, cwd: f.project, mcpServers: [], _meta: { casper: { at: one._meta.casper.mark } } })).sessionId as string;
      const whole = (await client.request("session/fork", { sessionId: source, cwd: f.project, mcpServers: [] })).sessionId as string;
      // The fork wrote nothing to the source: the rest of the line goes on where the source left it.
      expect(await readFile(sourceFile, "utf8")).toBe(during + line.slice(0, half));
      await appendFile(sourceFile, `${line.slice(half)}\n`);
      release();
      expect((await waiting).stopReason).toBe("end_turn");

      // Every line of every file is a whole entry, and each copy is a prefix of the source as it was when it was read.
      const after = await entriesOf(sourceFile);
      const before = during.split("\n").filter(Boolean).slice(1).map((entry) => JSON.parse(entry) as Record<string, unknown>);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.some((entry) => entry.id === "f0f0f0f0")).toBe(true);
      expect(await entriesOf(await conversationFile(f.home, whole))).toEqual(before);
      const cutEntries = await entriesOf(await conversationFile(f.home, cut));
      expect(cutEntries.length).toBeLessThan(before.length);
      expect(cutEntries.map((entry) => entry.id)).toEqual(before.slice(0, cutEntries.length).map((entry) => entry.id));
      // Each copy names the source conversation as the one it came from.
      for (const copy of [whole, cut]) {
        const header = JSON.parse((await readFile(await conversationFile(f.home, copy), "utf8")).split("\n")[0]!) as { id: string; parentSession: string };
        expect(header.id).toBe(copy);
        expect(path.basename(header.parentSession)).toBe(path.basename(sourceFile));
        expect(header.parentSession).not.toContain("casper-fork-");
      }
      expect(await client.close()).toBe(0);

      // Each copy loads with the requests it was read with.
      const again = open(f);
      await again.request("initialize", INIT);
      await again.request("session/load", { sessionId: whole, cwd: f.project, mcpServers: [] });
      expect(replayed(again, whole)).toEqual(["Say ONE", "Wait for me"]);
      await again.request("session/load", { sessionId: cut, cwd: f.project, mcpServers: [] });
      expect(replayed(again, cut)).toEqual(["Say ONE"]);
    } finally { release(); }
  }, childTestLimit(5));
});
