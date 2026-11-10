import { afterEach, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { startAcp, until, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { isOutside } from "../src/platform/inside";
import { systemTempDirs } from "../src/sandbox/policy";
import { FULL_REFUSED } from "../src/acp/modes";
import { READ_ONLY_NO } from "../src/acp/permission";
import { READ_ONLY_TYPED } from "../src/task/classify";
import { cleanUpAfterEach, fixture, lastUser, type Payload, type Step } from "./support/scripting";

// The app's access chip (decision 82) against a real `casper acp` router, its session children and the scripted
// provider: Read only, Ask first and Don't ask, as session modes and as the `mode` config option.
const clients: AcpClient[] = [];
const outsideFolders: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const folder of outsideFolders.splice(0)) await rm(folder, { recursive: true, force: true });
});
cleanUpAfterEach();
const open = (...args: Parameters<typeof startAcp>) => { const client = startAcp(...args); clients.push(client); return client; };

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
const text = (words: string) => [{ type: "text", text: words }];
const ofSession = (client: AcpClient, sessionId: string) => client.updates.filter((update) => update.sessionId === sessionId).map((update) => update.update);
type Option = { id: string; currentValue: string; options: Array<{ value: string }> };
const modeOf = (options: Option[]) => options.find((option) => option.id === "mode");
const modeUpdates = (client: AcpClient, sessionId: string) => ofSession(client, sessionId).filter((update) => update.sessionUpdate === "current_mode_update").map((update) => update.currentModeId);
const refusal = (reply: Promise<unknown>) => reply.then(() => undefined, (error: { code: number; message: string }) => ({ code: error.code, message: error.message }));
const isChecklistCall = (payload: Payload) => JSON.stringify(payload.messages).includes("Casper checklist.");
const option = (params: Record<string, any>, kind: string) => ({ optionId: (params.options as Array<{ kind: string; optionId: string }>).find((choice) => choice.kind === kind)!.optionId });
/** The model's first answer to a request that names `marker` calls `tools`; after a tool result it says Done. */
const callsFor = (marker: string, tools: Array<{ name: string; args: unknown }>) => (_request: number, payload: Payload): Step =>
  isChecklistCall(payload) ? { text: "[]" } : payload.messages.at(-1)?.role !== "tool" && lastUser(payload).includes(marker) ? { tools } : { text: "Done." };

/** A folder outside the project that is no system temp folder (Casper writes in temp without asking). */
const SCRATCH = path.resolve(import.meta.dir, "..", ".scratch");
const scratchInTemp = systemTempDirs().some((temp) => !isOutside(path.relative(temp, realpathSync(path.dirname(SCRATCH)))));
async function outsideFolder(): Promise<string> {
  await mkdir(SCRATCH, { recursive: true });
  const folder = await realpath(await mkdtemp(path.join(SCRATCH, "acp-modes-")));
  outsideFolders.push(folder);
  return folder;
}

// The app's own MCP server (decision 77).
const MCP_FIXTURE = path.join(import.meta.dir, "fixtures/mcp-server.ts");
const stdioEntry = (calls: string, meta?: Record<string, unknown>) => ({ name: "app", command: process.execPath, args: [MCP_FIXTURE],
  env: [{ name: "FIXTURE_MODE", value: "generic" }, { name: "FIXTURE_CALLS_FILE", value: calls }], ...(meta ? { _meta: meta } : {}) });
const ASKS = { "casper/clientAsks": true };
const toolsCalled = async (file: string) => existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line).tool as string) : [];

test("new and load list the modes with Ask first current; a set is taken, not echoed, and an unknown session or mode is an error", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  const client = open(f);
  await client.request("initialize", INIT);
  const created = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  const sessionId = created.sessionId as string;
  expect(created.modes.currentModeId).toBe("ask");
  expect(created.modes.availableModes.map((mode: { id: string }) => mode.id)).toEqual(["read", "ask", "full"]);
  // The option is last, and lists the same modes.
  expect((created.configOptions as Option[]).at(-1)).toMatchObject({ id: "mode", name: "Access", category: "mode", currentValue: "ask" });
  expect(modeOf(created.configOptions)!.options.map((entry) => entry.value)).toEqual(["read", "ask", "full"]);

  expect(await client.request("session/set_mode", { sessionId, modeId: "read" })).toEqual({});
  const options = (await client.request("session/set_config_option", { sessionId, configId: "mode", value: "full" })).configOptions as Option[];
  expect(modeOf(options)!.currentValue).toBe("full");
  expect(await refusal(client.request("session/set_mode", { sessionId, modeId: "everything" }))).toEqual({ code: -32602, message: "Unknown mode: everything (read, ask, full)" });
  expect(await refusal(client.request("session/set_config_option", { sessionId, configId: "mode", value: 3 }))).toEqual({ code: -32602, message: "mode takes one of its listed values" });
  expect(await refusal(client.request("session/set_mode", { sessionId: "nope", modeId: "read" }))).toEqual({ code: -32002, message: "Unknown session" });
  // A prompt's end says nothing of what the client set itself.
  expect((await client.request("session/prompt", { sessionId, prompt: text("hello") })).stopReason).toBe("end_turn");
  expect(modeUpdates(client, sessionId)).toEqual([]);
  expect(ofSession(client, sessionId).filter((update) => update.sessionUpdate === "config_option_update")).toEqual([]);
  expect(client.stderr()).toContain("[permissions] The app set Read only");
  expect(await client.close()).toBe(0);

  // A loaded session starts at Ask first: the app sets its chip again.
  const again = open(f);
  await again.request("initialize", INIT);
  const loaded = await again.request("session/load", { sessionId, cwd: f.project, mcpServers: [] });
  expect(loaded.modes.currentModeId).toBe("ask");
  expect(modeOf(loaded.configOptions)!.currentValue).toBe("ask");
}, childTestLimit(2));

test("Read only: a write and an edit are not run, touch asks first and a cancel is No, ls runs, no checks run and the receipt names read only", async () => {
  const f = await fixture(callsFor("notes", [
    { name: "write", args: { path: "notes.txt", content: "changed\n" } },
    { name: "edit", args: { path: "notes.txt", edits: [{ oldText: "first", newText: "changed" }] } },
    { name: "bash", args: { command: "touch x.txt" } },
    { name: "bash", args: { command: "ls" } }]));
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), 'verify:\n  test: "touch tested.txt"\n');
  await writeFile(path.join(f.project, "notes.txt"), "first\n");
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  await client.request("session/set_mode", { sessionId, modeId: "read" });
  const done = await client.request("session/prompt", { sessionId, prompt: text("Fix the notes: add a line to notes.txt and run touch x.txt") });
  expect(done.stopReason).toBe("end_turn");
  expect(await readFile(path.join(f.project, "notes.txt"), "utf8")).toBe("first\n");
  expect(existsSync(path.join(f.project, "x.txt"))).toBe(false);
  // The project's test command never ran.
  expect(existsSync(path.join(f.project, "tested.txt"))).toBe(false);
  const updates = ofSession(client, sessionId);
  const ended = (id: string) => updates.find((update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === id && ["completed", "failed"].includes(update.status));
  const steps = updates.filter((update) => update.sessionUpdate === "tool_call" && String(update.toolCallId).startsWith("casper-tool-"));
  const step = (tool: string, target?: string) => steps.find((update) => update._meta?.casper?.tool === tool && (!target || JSON.stringify(update.rawInput).includes(target)));
  for (const blocked of [step("write"), step("edit")]) expect(JSON.stringify(ended(blocked.toolCallId))).toContain("Read only:");
  // touch is not a look command: it asks (plan_commands, decision 95), and the client's cancel is No.
  expect(JSON.stringify(ended(step("bash", "touch").toolCallId))).toContain("the user said no to this command while Read only");
  expect(ended(step("bash", "ls").toolCallId).status).toBe("completed");
  expect(JSON.stringify(ended(step("bash", "ls").toolCallId))).toContain("notes.txt");
  expect(JSON.stringify(done._meta.casper.receipt)).toContain("read only (set by the app)");
  // No checklist call, and the request says Read only to the model this once.
  expect(f.payloads.some(isChecklistCall)).toBe(false);
  expect(JSON.stringify(f.payloads[0]!.messages)).toContain(READ_ONLY_TYPED);
  expect(client.permissions).toHaveLength(1);
  expect(client.permissions[0]!.toolCall.title).toStartWith("Run this command? The app set Read only, and it may change files.");
  expect(client.permissions[0]!.options.map((entry: { name: string; kind: string }) => [entry.name, entry.kind])).toEqual([["No", "reject_once"], ["Yes, this once", "allow_once"]]);
}, childTestLimit(1));

test("Read only: the app's Yes, this once runs a command that is not a look command; plan_commands: off refuses it with no box", async () => {
  const f = await fixture(callsFor("notes", [{ name: "bash", args: { command: "touch x.txt" } }]));
  const client = open(f);
  await client.request("initialize", INIT);
  client.answerPermissions((params) => option(params, "allow_once"));
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  await client.request("session/set_mode", { sessionId, modeId: "read" });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Fix the notes: run touch x.txt") })).stopReason).toBe("end_turn");
  expect(client.permissions).toHaveLength(1);
  expect(existsSync(path.join(f.project, "x.txt"))).toBe(true);
  expect(await client.close()).toBe(0);

  await writeFile(path.join(f.home, ".casper/config.yaml"), "plan_commands: off\n", { flag: "a" });
  await rm(path.join(f.project, "x.txt"));
  const off = open(f);
  await off.request("initialize", INIT);
  off.answerPermissions((params) => option(params, "allow_once"));
  const second = await off.request("session/new", { cwd: f.project, mcpServers: [] });
  await off.request("session/set_mode", { sessionId: second.sessionId, modeId: "read" });
  expect((await off.request("session/prompt", { sessionId: second.sessionId, prompt: text("Fix the notes: run touch x.txt") })).stopReason).toBe("end_turn");
  expect(off.permissions).toEqual([]);
  expect(existsSync(path.join(f.project, "x.txt"))).toBe(false);
  expect(JSON.stringify(ofSession(off, second.sessionId))).toContain("Read only: the app set Casper to look and answer");
}, childTestLimit(2));

test("a command naming ~/.ssh asks in a card in Ask first and in Read only, and the app's No refuses it (private_commands, decision 95)", async () => {
  const f = await fixture(callsFor("hosts", [{ name: "bash", args: { command: "cat ~/.ssh/config" } }]));
  await mkdir(path.join(f.home, ".ssh"), { recursive: true });
  await writeFile(path.join(f.home, ".ssh/config"), "Host build\n  HostName 192.0.2.10\n");
  // The sandbox off, as it is by default at a terminal (with it on, it hides ~/.ssh and nothing asks).
  await writeFile(path.join(f.home, ".casper/config.yaml"), "sandbox: off\n", { flag: "a" });
  const client = open(f);
  await client.request("initialize", INIT);
  client.answerPermissions((params) => option(params, "reject_once"));
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Which hosts? cat ~/.ssh/config") })).stopReason).toBe("end_turn");
  await client.request("session/set_mode", { sessionId, modeId: "read" });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Which hosts now? cat ~/.ssh/config") })).stopReason).toBe("end_turn");
  expect(client.permissions.map((entry: Record<string, any>) => String(entry.toolCall.title).split("\n")[0])).toEqual([
    "Run this command? It uses ~/.ssh, which is private (keys and logins).  cat ~/.ssh/config",
    "Run this command? It uses ~/.ssh, which is private (keys and logins).  cat ~/.ssh/config"]);
  expect(client.permissions[0]!.options.map((entry: { name: string }) => entry.name)).toEqual(["No", "Yes, this once", "Yes, for this session"]);
  const said = JSON.stringify(ofSession(client, sessionId));
  expect(said).toContain("the user said no to reading ~/.ssh");
  expect(said).not.toContain("HostName 192.0.2.10");
}, childTestLimit(1));

test("Read only: the app's change tool is refused with no box, and its read tool runs", async () => {
  const f = await fixture((_request: number, payload: Payload): Step => {
    if (isChecklistCall(payload)) return { text: "[]" };
    const results = payload.messages.slice(payload.messages.map((message) => message.role).lastIndexOf("user") + 1).filter((message) => message.role === "tool").length;
    const calls = [{ id: "mcp:acp-app:status" }, { id: "mcp:acp-app:set_site", arguments: { site: "lab" } }];
    const next = calls[results];
    return next ? { tools: [{ name: "call_capability", args: { id: next.id, arguments: next.arguments ?? {} } }] } : { text: "Done." };
  });
  const calls = path.join(f.root, "calls.jsonl");
  const client = open(f);
  await client.request("initialize", INIT);
  client.answerPermissions((params) => option(params, "allow_once"));
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [stdioEntry(calls)] });
  await client.request("session/set_config_option", { sessionId, configId: "mode", value: "read" });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Read the app's server status, then set site lab") })).stopReason).toBe("end_turn");
  expect(client.permissions).toEqual([]);
  expect(await toolsCalled(calls)).toEqual(["status"]);
  expect(JSON.stringify(ofSession(client, sessionId))).toContain("read only: the app set Casper to look and answer");
}, childTestLimit(1));

test.skipIf(scratchInTemp)("Read only set during a prompt closes the open box as No, and the write behind it is not run", async () => {
  const outside = await outsideFolder();
  const f = await fixture(callsFor("outside", [
    { name: "write", args: { path: path.join(outside, "one.txt"), content: "one\n" } },
    { name: "write", args: { path: path.join(outside, "two.txt"), content: "two\n" } }]));
  const client = open(f);
  await client.request("initialize", INIT);
  client.answerPermissions(() => "never");
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  const running = client.request("session/prompt", { sessionId, prompt: text("Write both files outside") });
  await until(() => client.permissions.length > 0, 60_000, "the first box");
  // Taken while the prompt runs.
  const options = (await client.request("session/set_config_option", { sessionId, configId: "mode", value: "read" })).configOptions as Option[];
  expect(modeOf(options)!.currentValue).toBe("read");
  expect((await running).stopReason).toBe("end_turn");
  expect(existsSync(path.join(outside, "one.txt"))).toBe(false);
  expect(existsSync(path.join(outside, "two.txt"))).toBe(false);
  expect(client.permissions).toHaveLength(1);
  const closed = ofSession(client, sessionId).find((update) => update.toolCallId === client.permissions[0].toolCall.toolCallId && update.status === "failed");
  expect(closed.content[0].content.text).toBe(READ_ONLY_NO);
}, childTestLimit(1));

test.skipIf(scratchInTemp)("Don't ask: a write outside the project needs no box, while the app's own server's change asks in Casper's box", async () => {
  const outside = await outsideFolder();
  const f = await fixture((_request: number, payload: Payload): Step => {
    if (isChecklistCall(payload) || payload.messages.at(-1)?.role === "tool") return { text: isChecklistCall(payload) ? "[]" : "Done." };
    const asked = lastUser(payload);
    if (asked.includes("outside")) return { tools: [{ name: "write", args: { path: path.join(outside, "full.txt"), content: "full\n" } }] };
    if (asked.includes("app's server")) return { tools: [{ name: "call_capability", args: { id: "mcp:acp-app:set_site", arguments: { site: "lab" } } }] };
    return { text: "Done." };
  });
  const calls = path.join(f.root, "calls.jsonl");
  const client = open(f);
  await client.request("initialize", INIT);
  client.answerPermissions((params) => option(params, "allow_once"));
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [stdioEntry(calls, ASKS)] });
  await client.request("session/set_mode", { sessionId, modeId: "full" });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Write the file outside") })).stopReason).toBe("end_turn");
  expect(await readFile(path.join(outside, "full.txt"), "utf8")).toBe("full\n");
  expect(client.permissions).toEqual([]);
  // The app asks nothing in its Don't ask, so its server's change gets Casper's box: one box.
  expect((await client.request("session/prompt", { sessionId, prompt: text("Use the app's server to set site lab") })).stopReason).toBe("end_turn");
  expect(client.permissions).toHaveLength(1);
  expect(JSON.stringify(client.permissions[0])).toContain("set_site");
  expect(await toolsCalled(calls)).toEqual(["set_site"]);
  // Ask first again: the app asks for its own server, so Casper does not.
  await client.request("session/set_mode", { sessionId, modeId: "ask" });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Use the app's server to set site lab again") })).stopReason).toBe("end_turn");
  expect(client.permissions).toHaveLength(1);
  expect(await toolsCalled(calls)).toEqual(["set_site", "set_site"]);
}, childTestLimit(1));

test("/permissions all typed in the app asks in a card, and its yes moves the app's mode to Don't ask before the reply; /permissions ask moves it back", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  const client = open(f);
  await client.request("initialize", INIT);
  client.answerPermissions((params) => ({ optionId: (params.options as Array<{ name: string; optionId: string }>).find((choice) => choice.name === "Stop asking until I quit")!.optionId }));
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  const from = client.lines.length;
  const done = await client.request("session/prompt", { sessionId, prompt: text("/permissions all") });
  expect(done.stopReason).toBe("end_turn");
  expect(client.permissions).toHaveLength(1);
  expect(client.permissions[0].toolCall.title).toContain("Stop asking until you quit?");
  expect(modeUpdates(client, sessionId)).toEqual(["full"]);
  const after = client.lines.slice(from).map((line) => JSON.parse(line) as Record<string, any>);
  const update = after.findIndex((message) => message.params?.update?.sessionUpdate === "current_mode_update");
  const config = after.findIndex((message) => message.params?.update?.sessionUpdate === "config_option_update");
  const reply = after.findIndex((message) => message.id !== undefined && message.method === undefined && message.result?.stopReason);
  expect(update).toBeGreaterThanOrEqual(0);
  expect(update).toBeLessThan(reply);
  expect(modeOf(after[config]!.params.update.configOptions)!.currentValue).toBe("full");
  expect((await client.request("session/prompt", { sessionId, prompt: text("/permissions ask") })).stopReason).toBe("end_turn");
  expect(modeUpdates(client, sessionId)).toEqual(["full", "ask"]);
}, childTestLimit(1));

test("a box a / command asks ends the command's block before its card, and what the command prints after it is a new block", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  const client = open(f);
  await client.request("initialize", INIT);
  client.answerPermissions((params) => ({ optionId: (params.options as Array<{ name: string; optionId: string }>).find((choice) => choice.name === "Keep asking")!.optionId }));
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  const from = client.lines.length;
  expect((await client.request("session/prompt", { sessionId, prompt: text("/permissions") })).stopReason).toBe("end_turn");
  expect(client.permissions).toHaveLength(1);
  // The prompt's updates in order: text, the box card (B) and its close (C).
  const order = client.lines.slice(from).map((line) => JSON.parse(line) as Record<string, any>).flatMap((message) => {
    const update = message.params?.update;
    if (update?.sessionUpdate === "agent_message_chunk") return [update.content.text as string];
    if (update?.toolCallId === client.permissions[0].toolCall.toolCallId) return [update.sessionUpdate === "tool_call" ? "B" : "C"];
    return [];
  });
  const card = order.indexOf("B");
  const before = order.slice(0, card).join("");
  const after = order.slice(order.indexOf("C") + 1).join("");
  expect(before).toStartWith("````text\n");
  expect(before).toEndWith("````\n");
  expect(before).toContain("Asking is on");
  expect(order.slice(card, order.indexOf("C") + 1)).toEqual(["B", "C"]);
  expect(after).toStartWith("````text\n");
  expect(after).toContain("Keep asking");
  expect(after).toEndWith("````\n");
}, childTestLimit(1));

test("acp_access off offers Read only and Ask first only, and refuses Don't ask in plain words", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  await writeFile(path.join(f.home, ".casper/config.yaml"), "acp_access: off\n");
  const client = open(f);
  await client.request("initialize", INIT);
  const created = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  expect(created.modes.availableModes.map((mode: { id: string }) => mode.id)).toEqual(["read", "ask"]);
  expect(modeOf(created.configOptions)!.options.map((entry) => entry.value)).toEqual(["read", "ask"]);
  expect(await refusal(client.request("session/set_mode", { sessionId: created.sessionId, modeId: "full" }))).toEqual({ code: -32602, message: FULL_REFUSED });
  expect(await client.request("session/set_mode", { sessionId: created.sessionId, modeId: "read" })).toEqual({});
}, childTestLimit(1));
