import { afterEach, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { startAcp, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { cleanUpAfterEach, fixture, shellCheckTest, type Payload, type Step } from "./support/scripting";

// What an ACP client is shown of each tool step (decision 79), against a real `casper acp` child and the scripted provider.
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();
const open = (...args: Parameters<typeof startAcp>) => { const client = startAcp(...args); clients.push(client); return client; };

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
const text = (words: string) => [{ type: "text", text: words }];
const onlyProtocol = (client: AcpClient) => { for (const line of client.lines) expect(JSON.parse(line).jsonrpc).toBe("2.0"); };
const isChecklistCall = (payload: Payload) => JSON.stringify(payload.messages).includes("Casper checklist.");
/** Tool results the model has had since the person's last message. */
const resultsSoFar = (payload: Payload) => {
  const lastUserAt = payload.messages.map((message) => message.role).lastIndexOf("user");
  return payload.messages.slice(lastUserAt + 1).filter((message) => message.role === "tool").length;
};
/** The model's turns by how many tool results it has had: `turns[n]` answers after n results, else Done. */
const byResults = (turns: Record<number, Step>) => (_request: number, payload: Payload): Step =>
  isChecklistCall(payload) ? { text: "[]" } : turns[resultsSoFar(payload)] ?? { text: "Done." };
/** A step's start and its last update, by the title it started with. */
function step(client: AcpClient, sessionId: string, title: string): { start: Record<string, any>; end: Record<string, any> } {
  const updates = client.updates.filter((update) => update.sessionId === sessionId).map((update) => update.update);
  const start = updates.find((update) => update.sessionUpdate === "tool_call" && update.title === title);
  expect(start).toBeDefined();
  const end = updates.filter((update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === start.toolCallId).at(-1);
  expect(end).toBeDefined();
  return { start, end };
}

const SUM = `${Array.from({ length: 10 }, (_, index) => `// line ${index + 1}`).join("\n")}\nfunction sum(a, b) {\n  return a - b;\n}\nmodule.exports = sum;\n`;

shellCheckTest("steps carry their output: an edit's diff from its patch with its line, a write's diff, a shell exit code, grep, ls and read shapes", async () => {
  const f = await fixture(byResults({
    0: { tools: [
      { name: "edit", args: { path: "sum.js", edits: [{ oldText: "return a - b;", newText: "return a + b;" }] } },
      { name: "write", args: { path: "fresh.txt", content: "hello\n" } },
      { name: "write", args: { path: "old.txt", content: "after\n" } },
    ] },
    3: { tools: [{ name: "bash", args: { command: "echo five; exit 3", description: "Print five and exit" } }] },
    4: { tools: [{ name: "grep", args: { pattern: "sum", path: "." } }, { name: "ls", args: { path: "." } }, { name: "read", args: { path: "sum.js" } }] },
  }));
  await writeFile(path.join(f.project, "sum.js"), SUM);
  await writeFile(path.join(f.project, "old.txt"), "before\n");
  const client = open(f);
  await client.request("initialize", INIT);
  client.answerPermissions((params) => ({ optionId: (params.options as Array<{ kind: string; optionId: string }>).find((choice) => choice.kind === "allow_once")!.optionId }));
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Fix sum.js, write the notes, then look around") })).stopReason).toBe("end_turn");
  expect(await readFile(path.join(f.project, "sum.js"), "utf8")).toContain("return a + b;");
  const file = (name: string) => path.join(f.project, name);

  // The edit: its replacement at the start, the patch's hunk (context and its new start line) at the end.
  const edit = step(client, sessionId, "edit sum.js");
  expect(edit.start).toMatchObject({ kind: "edit", rawInput: { path: "sum.js", edits: [{ oldText: "return a - b;", newText: "return a + b;" }] },
    content: [{ type: "diff", path: file("sum.js"), oldText: "return a - b;", newText: "return a + b;" }], _meta: { casper: { tool: "edit", target: "sum.js" } } });
  expect(edit.end).toMatchObject({ status: "completed", rawOutput: { path: file("sum.js"), added: 1, removed: 1 }, locations: [{ path: file("sum.js"), line: 8 }] });
  expect(edit.end.content).toEqual([{ type: "diff", path: file("sum.js"), oldText: "// line 8\n// line 9\n// line 10\nfunction sum(a, b) {\n  return a - b;\n}\nmodule.exports = sum;\n",
    newText: "// line 8\n// line 9\n// line 10\nfunction sum(a, b) {\n  return a + b;\n}\nmodule.exports = sum;\n" }]);

  // A new file has no old text; an overwrite has the old one.
  expect(step(client, sessionId, "write fresh.txt").end).toMatchObject({ content: [{ type: "diff", path: file("fresh.txt"), oldText: null, newText: "hello\n" }], rawOutput: { created: true } });
  expect(step(client, sessionId, "write old.txt").end).toMatchObject({ content: [{ type: "diff", path: file("old.txt"), oldText: "before\n", newText: "after\n" }], rawOutput: { created: false } });

  // The shell step: its title, its output and its exit code.
  const shell = step(client, sessionId, "bash echo five; exit 3");
  expect(shell.start).toMatchObject({ kind: "execute", rawInput: { command: "echo five; exit 3" }, _meta: { casper: { tool: "bash", description: "Print five and exit" } } });
  expect(shell.end).toMatchObject({ status: "failed", rawOutput: { exitCode: 3, truncated: false } });
  expect(shell.end.content[0].content.text).toStartWith("```text\nfive\n");

  // Pi's grep runs ripgrep, and this fixture is offline (no download): a machine without rg on PATH (the Windows CI
  // image) gets a failed step that says why, never an empty result.
  const grep = step(client, sessionId, "grep sum").end;
  const searchPath = Object.entries(f.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  if (Bun.which("rg", { PATH: searchPath })) {
    expect(grep.rawOutput).toMatchObject({ shape: "matches", truncated: false });
    expect(grep.rawOutput.files).toContainEqual({ path: "sum.js", matches: expect.arrayContaining([{ lineNumber: 11, line: "function sum(a, b) {" }]) });
  } else {
    expect(grep).toMatchObject({ status: "failed", content: [{ type: "content", content: { type: "text", text: expect.stringContaining("ripgrep") } }] });
  }
  // ls, not find: pi's find needs fd, which a CI machine may not have (find's paths are read the same way: acp-tool-content).
  // The whole update, so a listing that failed shows what it said.
  expect(step(client, sessionId, "ls .").end).toMatchObject({ status: "completed", rawOutput: { shape: "paths", paths: expect.arrayContaining(["sum.js"]) } });
  const read = step(client, sessionId, "read sum.js");
  expect(read.start.locations).toEqual([{ path: file("sum.js"), line: 1 }]);
  expect(read.end.rawOutput).toMatchObject({ path: file("sum.js"), offset: 1, truncated: false });
  expect(read.end.content[0].content.text).toContain("return a + b;");
  onlyProtocol(client);
}, childTestLimit(1));

shellCheckTest("a session opened in a subfolder of a repository names the file the runtime wrote, at the repository's top", async () => {
  const f = await fixture(byResults({ 0: { tools: [{ name: "write", args: { path: "made.txt", content: "made\n" } }] } }));
  execFileSync("git", ["init", "-q"], { cwd: f.project, env: f.env });
  await mkdir(path.join(f.project, "sub"));
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: path.join(f.project, "sub"), mcpServers: [] });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Write made.txt") })).stopReason).toBe("end_turn");
  // The runtime works at the repository's top, so that is where the file is, and every path the app is given says so.
  const top = path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: f.project, env: f.env, encoding: "utf8" }).trim());
  const made = path.join(top, "made.txt");
  expect(existsSync(made)).toBe(true);
  expect(existsSync(path.join(f.project, "sub", "made.txt"))).toBe(false);
  const write = step(client, sessionId, "write made.txt");
  expect(write.start.locations).toEqual([{ path: made }]);
  expect(write.end).toMatchObject({ rawOutput: { path: made, created: true }, content: [{ type: "diff", path: made, oldText: null, newText: "made\n" }] });
  onlyProtocol(client);
}, childTestLimit(1));

shellCheckTest("with netconan installed, a device config the AI writes is not shown in the app, only a note naming it", async () => {
  const f = await fixture(byResults({ 0: { tools: [{ name: "write", args: { path: "configs/edge1.set", content: "set services custom-app token Zq8LeakyToken\n" } }] } }));
  // Found is enough: the write never runs it (a run that fails falls back to Casper's own rules).
  const netconan = path.join(f.root, "netconan");
  await writeFile(netconan, "#!/bin/sh\nexit 1\n");
  await chmod(netconan, 0o755);
  await mkdir(path.join(f.project, "configs"));
  const client = open(f, [], { CASPER_NETCONAN: netconan });
  await client.request("initialize", INIT);
  client.answerPermissions((params) => ({ optionId: (params.options as Array<{ kind: string; optionId: string }>).find((choice) => choice.kind === "allow_once")!.optionId }));
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Write the config") })).stopReason).toBe("end_turn");
  expect(await readFile(path.join(f.project, "configs/edge1.set"), "utf8")).toContain("Zq8LeakyToken");
  const write = step(client, sessionId, "write configs/edge1.set");
  expect(write.start.rawInput).toEqual({ path: "configs/edge1.set", content: "<not shown: a device config netconan checks>" });
  expect(write.end.content).toEqual([{ type: "content", content: { type: "text", text: "Changed configs/edge1.set (+1 −0): not shown, netconan checks this device config only as the AI reads it" } }]);
  expect(client.lines.join("\n")).not.toContain("Zq8LeakyToken");
  onlyProtocol(client);
}, childTestLimit(1));
