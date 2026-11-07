import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentText, startAcp, until, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { isOutside } from "../src/platform/inside";
import { systemTempDirs } from "../src/sandbox/policy";
import { cleanUpAfterEach, fixProject, fixture, lastUser, shellCheckTest, type Payload, type Step } from "./support/scripting";
import { httpFixture } from "./fixtures/mcp-http-server";

// Bun runs afterEach hooks in the order they are added: the agents stop (with their session processes) before the
// fixture's folders are removed, which Windows refuses while a process works in one.
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
/** Every line on the agent's stdout is one JSON-RPC 2.0 message: nothing else may reach the client. */
const onlyProtocol = (client: AcpClient) => { for (const line of client.lines) expect(JSON.parse(line).jsonrpc).toBe("2.0"); };

/** The checklist call Casper makes before a code change's task turn (its own system prompt). */
const isChecklistCall = (payload: Payload) => JSON.stringify(payload.messages).includes("Casper checklist.");
/** `script` numbers the task's own requests: a fix request first gets the checklist call (as in a terminal session),
 * which lists no cases here. */
const taskTurns = (script: (request: number, payload: Payload) => Step) => {
  let own = 0;
  return (_request: number, payload: Payload): Step => isChecklistCall(payload) ? { text: "[]" } : script(own++, payload);
};

shellCheckTest("casper acp runs a whole task: tools, text, plan, checks, then the receipt as the last message", async () => {
  const f = await fixture(taskTurns((request) => request === 0 ? { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] } : { text: "Fixed sum.js." }));
  await fixProject(f);
  const client = open(f);
  const init = await client.request("initialize", INIT);
  expect(init.protocolVersion).toBe(1);
  expect(init.agentCapabilities).toMatchObject({ loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true } });
  expect(init.agentInfo).toMatchObject({ name: "casper" });
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  const done = await client.request("session/prompt", { sessionId, prompt: text("Fix sum.js") });
  expect(done.stopReason).toBe("end_turn");
  expect(await readFile(path.join(f.project, "sum.js"), "utf8")).toBe("fixed\n");

  const updates = ofSession(client, sessionId);
  const write = updates.find((update) => update.sessionUpdate === "tool_call" && update.title.includes("sum.js"));
  expect(write).toMatchObject({ kind: "edit", status: "in_progress" });
  expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: write.toolCallId, status: "completed" }));
  expect(agentText(client.updates, sessionId)).toContain("Fixed sum.js.");
  // Casper's own steps are the plan: the task, then its checks, each completed by the end.
  const plans = updates.filter((update) => update.sessionUpdate === "plan");
  expect(plans.at(-1).entries.length).toBeGreaterThanOrEqual(2);
  for (const entry of plans.at(-1).entries) expect(entry.status).toBe("completed");
  // The check Casper ran shows as a step of its own, with its result.
  expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call", kind: "execute", status: "completed", title: expect.stringContaining("test") }));

  // The receipt is the last message: readable text, and the same facts as data.
  const last = updates.at(-1);
  expect(last.sessionUpdate).toBe("agent_message_chunk");
  expect(last.content.text).toContain("Changed 1 file: sum.js");
  const receipt = last._meta.casper.receipt;
  expect(receipt).toMatchObject({ outcome: "verified", changed: ["sum.js"], checksRun: [{ name: "test", status: "pass" }], checksNotRun: [] });
  expect(receipt.verdict).toContain("Verified");
  expect(done._meta.casper.receipt).toEqual(receipt);
  onlyProtocol(client);
  expect(await client.close()).toBe(0);

  // session/load opens the saved conversation in a new agent and replays it.
  const again = open(f);
  await again.request("initialize", INIT);
  await again.request("session/load", { sessionId, cwd: f.project, mcpServers: [] });
  expect(ofSession(again, sessionId)).toContainEqual(expect.objectContaining({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Fix sum.js" } }));
  const next = await again.request("session/prompt", { sessionId, prompt: text("And now?") });
  expect(next.stopReason).toBe("end_turn");
  // The model saw the earlier turn: it is the same conversation.
  expect(JSON.stringify(f.payloads.at(-1)!.messages)).toContain("Fix sum.js");
}, childTestLimit(2));

const CASES = ["sum(1, 2) is 3", "sum() is 0"];
/** Lists CASES to a checklist call and answers everything else. */
const listsCases = (_request: number, payload: Payload): Step => isChecklistCall(payload) ? { text: JSON.stringify(CASES) } : { text: "Done." };

test("ACP prompts get the terminal's checklist default: a fix request gets one; a question, a docs request and a pasted transcript do not", async () => {
  const f = await fixture(listsCases);
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  // A pasted agent transcript is context: its "fix" and "add tests" are not what was asked, as in the terminal.
  const pasted = "Why did the other agent stop?\n❯ fix the failing sum test\n● I'll fix sum.js and add tests\n⎿ Edited sum.js\n● Done";
  for (const words of ["What does sum.js return?", "Explain how sum.js adds numbers", pasted]) {
    expect((await client.request("session/prompt", { sessionId, prompt: text(words) })).stopReason).toBe("end_turn");
  }
  expect(f.payloads.filter(isChecklistCall)).toHaveLength(0);
  await client.request("session/prompt", { sessionId, prompt: text("Fix sum.js so sum(1, 2) is 3 and sum() is 0") });
  expect(f.payloads.filter(isChecklistCall)).toHaveLength(1);
  // The task turn is told the cases, as in a terminal session.
  const task = f.payloads.find((payload) => !isChecklistCall(payload) && lastUser(payload).includes("Fix sum.js"))!;
  expect(lastUser(task)).toContain("Casper's checklist");
  for (const item of CASES) expect(lastUser(task)).toContain(`- ${item}`);
  onlyProtocol(client);
}, childTestLimit(1));

test("over ACP verification.checklist: false still turns the checklist off", async () => {
  const f = await fixture(listsCases);
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), "verification:\n  checklist: false\n");
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Fix sum.js so sum(1, 2) is 3") })).stopReason).toBe("end_turn");
  expect(f.payloads.filter(isChecklistCall)).toHaveLength(0);
  expect(JSON.stringify(f.payloads)).not.toContain("Casper's checklist");
}, childTestLimit(1));

test("session/cancel stops the running task; the prompt ends cancelled with a receipt", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(async (request) => { if (request === 0) { await held; } return { text: "too late" }; });
  try {
    const client = open(f);
    await client.request("initialize", INIT);
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    const prompt = client.request("session/prompt", { sessionId, prompt: text("Wait for me") });
    await until(() => f.payloads.length > 0, 60_000, "the model request");
    client.notify("session/cancel", { sessionId });
    const done = await prompt;
    expect(done.stopReason).toBe("cancelled");
    expect(done._meta.casper.receipt.outcome).toBe("cancelled");
    // The session stays usable after a cancel.
    release();
    const next = await client.request("session/prompt", { sessionId, prompt: text("Hello again") });
    expect(next.stopReason).toBe("end_turn");
    onlyProtocol(client);
  } finally { release(); }
}, childTestLimit(1));

/** The model writes a file outside the project, then answers. Writing there is an approval box in Casper. */
/** A folder outside the project that is no system temp folder: Casper writes in temp without asking, and on Linux the
 * fixture's own folders are in /tmp. The checkout's .scratch is ignored by git. */
const SCRATCH = path.resolve(import.meta.dir, "..", ".scratch");
/** A checkout in a temp folder (/tmp, /var/tmp) has no such place: those tests are skipped there, not failed as a
 * missing approval box. */
const scratchInTemp = systemTempDirs().some((temp) => !isOutside(path.relative(temp, realpathSync(path.dirname(SCRATCH)))));
async function outsideFolder(): Promise<string> {
  await mkdir(SCRATCH, { recursive: true });
  const folder = await realpath(await mkdtemp(path.join(SCRATCH, "acp-outside-")));
  outsideFolders.push(folder);
  return folder;
}
/** The model writes outside-<word>.txt in `folder`, the word taken from "session <word>" in the request. */
const outsideWrite = (folder: string) => (_request: number, payload: Payload): Step =>
  payload.messages.at(-1)?.role === "tool" ? { text: "Done." }
    : { tools: [{ name: "write", args: { path: path.join(folder, `outside-${/session (\w+)/.exec(lastUser(payload))?.[1]}.txt`), content: "hello\n" } }] };

test.skipIf(scratchInTemp)("an approval box goes to the client as session/request_permission: yes writes, no, cancelled and an error do not", async () => {
  const outside = await outsideFolder();
  const f = await fixture(outsideWrite(outside));
  const client = open(f);
  await client.request("initialize", INIT);
  const answers: Record<string, string> = {};
  client.answerPermissions((params) => {
    const answer = answers[params.sessionId];
    const option = (kind: string) => ({ optionId: params.options.find((choice: { kind: string }) => choice.kind === kind).optionId });
    return answer === "yes" ? option("allow_once") : answer === "no" ? option("reject_once") : answer === "error" ? "error" : "cancelled";
  });
  for (const answer of ["yes", "no", "cancelled", "error"]) {
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    answers[sessionId] = answer;
    const done = await client.request("session/prompt", { sessionId, prompt: text(`Write it for session ${answer}`) });
    expect(done.stopReason).toBe("end_turn");
    const asked = client.permissions.filter((params) => params.sessionId === sessionId);
    expect(asked).toHaveLength(1);
    // The same choices as the terminal's box, the safe one first.
    expect(asked[0].options[0]).toMatchObject({ name: "No", kind: "reject_once" });
    expect(asked[0].options.map((choice: { name: string }) => choice.name)).toContain("Yes, this once");
    expect(asked[0].toolCall.title).toContain("outside-");
    expect(existsSync(path.join(outside, `outside-${answer}.txt`))).toBe(answer === "yes");
  }
  onlyProtocol(client);
}, childTestLimit(1));

test.skipIf(scratchInTemp)("a permission request the client never answers is No once the session is cancelled", async () => {
  const outside = await outsideFolder();
  const f = await fixture(outsideWrite(outside));
  const client = open(f);
  await client.request("initialize", INIT);
  client.answerPermissions(() => "never");
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  const prompt = client.request("session/prompt", { sessionId, prompt: text("Write it for session never") });
  await until(() => client.permissions.length > 0, 60_000, "the permission request");
  client.notify("session/cancel", { sessionId });
  expect((await prompt).stopReason).toBe("cancelled");
  expect(existsSync(path.join(outside, "outside-never.txt"))).toBe(false);
}, childTestLimit(1));

shellCheckTest.skipIf(Bun.which("junoser") !== null)("a check that did not run is \"not run\" in the receipt, in words and in data", async () => {
  const f = await fixture(taskTurns((request) => request === 0 ? { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] } : { text: "Fixed." }));
  await mkdir(path.join(f.project, ".casper"));
  await mkdir(path.join(f.project, "configs"));
  await writeFile(path.join(f.project, "configs/r1.conf"), "system { host-name r1; }\n");
  await writeFile(path.join(f.project, ".casper/project.yaml"), 'verify:\n  test: "grep -q fixed sum.js"\n  checks:\n    junoser:\n      preset: junoser\n      files: [configs/]\n');
  await writeFile(path.join(f.project, "sum.js"), "broken\n");
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  const done = await client.request("session/prompt", { sessionId, prompt: text("Fix sum.js") });
  const receipt = done._meta.casper.receipt;
  expect(receipt.outcome).toBe("incomplete");
  expect(receipt.checksRun).toEqual([expect.objectContaining({ name: "test", status: "pass" })]);
  expect(receipt.checksNotRun).toEqual([{ name: "junoser", reason: expect.stringContaining("not installed") }]);
  const last = ofSession(client, sessionId).at(-1);
  expect(last.content.text).toContain("junoser not run");
}, childTestLimit(1));

test("secrets stay hidden in every update: model text, tool titles, arguments, output, written text and the receipt", async () => {
  const value = "acp-env-secret-7f3a9c";
  const f = await fixture((_request, payload) => isChecklistCall(payload) ? { text: "[]" } : payload.messages.at(-1)?.role === "tool"
    ? { text: `Here: sk-live1234567890abcdef and token=hunter2-literal and ${value}.\nBearer abcdef0123456789` }
    : { tools: [{ name: "bash", args: { command: `echo ok --password hunter3-literal # ${value}` } },
      { name: "bash", args: { command: "printf 'key %s\\n' \"$DEMO_API_KEY\"" } },
      { name: "write", args: { path: "deploy.env", content: `DEMO_API_KEY=${value}\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n` } }] });
  const client = open(f, [], { DEMO_API_KEY: value });
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  client.answerPermissions((params) => option(params, "allow_once"));
  const done = await client.request("session/prompt", { sessionId, prompt: text("Show me") });
  expect(done.stopReason).toBe("end_turn");
  expect(agentText(client.updates, sessionId)).toContain("Here:");
  // The steps ran and ended with what they showed: the printed key and the written file, secrets hidden.
  const updates = ofSession(client, sessionId);
  const ends = updates.filter((update) => update.sessionUpdate === "tool_call_update" && String(update.toolCallId).startsWith("casper-tool-"));
  expect(ends.length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(ends)).toContain("key ");
  // Its exit code too, though hiding the key replaced the output the shell reported it with.
  expect(ends).toContainEqual(expect.objectContaining({ rawOutput: { exitCode: 0, truncated: false } }));
  expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call", title: "write deploy.env", rawInput: { path: "deploy.env", content: expect.stringMatching(/^<not shown: /) } }));
  const everything = client.lines.join("\n");
  for (const secret of ["sk-live1234567890abcdef", "hunter2-literal", "hunter3-literal", value, "abcdef0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"]) expect(everything).not.toContain(secret);
}, childTestLimit(1));

test("two sessions run in parallel, each with its own updates", async () => {
  let both!: () => void;
  const ready = new Promise<void>((resolve) => { both = resolve; });
  const f = await fixture(async (_request, payload) => {
    const word = lastUser(payload).includes("alpha") ? "ALPHA" : "BETA";
    // Neither answers until both requests reached the model: the two tasks are running at the same time.
    if (f.payloads.length >= 2) both();
    await ready;
    return { text: `answer ${word}` };
  });
  const client = open(f);
  await client.request("initialize", INIT);
  const projectB = path.join(f.root, "project-b");
  await mkdir(projectB);
  const a = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId;
  const b = (await client.request("session/new", { cwd: projectB, mcpServers: [] })).sessionId;
  expect(a).not.toBe(b);
  const [doneA, doneB] = await Promise.all([client.request("session/prompt", { sessionId: a, prompt: text("alpha") }), client.request("session/prompt", { sessionId: b, prompt: text("beta") })]);
  expect([doneA.stopReason, doneB.stopReason]).toEqual(["end_turn", "end_turn"]);
  expect(agentText(client.updates, a)).toContain("answer ALPHA");
  expect(agentText(client.updates, a)).not.toContain("BETA");
  expect(agentText(client.updates, b)).toContain("answer BETA");
  expect(agentText(client.updates, b)).not.toContain("ALPHA");
  // Each session works in its own folder.
  expect(await realpath(f.project)).not.toBe(await realpath(projectB));
  onlyProtocol(client);
}, childTestLimit(2));

// The app's own MCP servers, listed in session/new (decision 77).
const MCP_FIXTURE = path.join(import.meta.dir, "fixtures/mcp-server.ts");
/** A stdio server entry the way ACP lists one: an absolute command, and env as name/value pairs. */
const stdioEntry = (calls: string, mode = "generic", meta?: Record<string, unknown>) => ({ name: "app", command: process.execPath, args: [MCP_FIXTURE],
  env: [{ name: "FIXTURE_MODE", value: mode }, { name: "FIXTURE_CALLS_FILE", value: calls }], ...(meta ? { _meta: meta } : {}) });
const ASKS = { "casper/clientAsks": true };
/** Tool results the model has had since the person's last message. */
const resultsSoFar = (payload: Payload) => {
  const lastUserAt = payload.messages.map((message) => message.role).lastIndexOf("user");
  return payload.messages.slice(lastUserAt + 1).filter((message) => message.role === "tool").length;
};
/** The model calls each capability in turn (one per answer), then says Done. Only the task's turns call anything. */
const callsInTurn = (...calls: Array<{ id: string; arguments?: Record<string, unknown> }>) => (_request: number, payload: Payload): Step => {
  if (isChecklistCall(payload)) return { text: "[]" };
  const next = calls[resultsSoFar(payload)];
  return next && lastUser(payload).includes("app's server") ? { tools: [{ name: "call_capability", args: { id: next.id, arguments: next.arguments ?? {} } }] } : { text: "Done." };
};
const toolsCalled = async (file: string) => existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line).tool as string) : [];
const option = (params: Record<string, any>, kind: string) => ({ optionId: (params.options as Array<{ kind: string; optionId: string }>).find((choice) => choice.kind === kind)!.optionId });

test("The app's stdio MCP server connects for the session and closes with it", async () => {
  const f = await fixture(callsInTurn({ id: "mcp:acp-app:status" }));
  const calls = path.join(f.root, "calls.jsonl");
  const client = open(f);
  const init = await client.request("initialize", INIT);
  expect(init.agentCapabilities.mcpCapabilities).toEqual({ http: true, sse: false });
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [stdioEntry(calls)] });
  expect(client.stderr()).toContain("[acp] The app's MCP server acp-app connects for this session.");
  expect((await client.request("session/prompt", { sessionId, prompt: text("What does the app's server say its status is?") })).stopReason).toBe("end_turn");
  expect(client.permissions).toHaveLength(0);
  expect(await toolsCalled(calls)).toEqual(["status"]);
  const answer = JSON.stringify(f.payloads.map((payload) => payload.messages));
  const pid = Number(/\\"pid\\":(\d+)/.exec(answer)?.[1]);
  expect(pid).toBeGreaterThan(0);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  expect(alive()).toBe(true);
  expect(await client.close()).toBe(0);
  // Its process ends with the session: nothing of it is left behind or written down.
  await until(() => !alive(), 30_000, "the app's server to stop");
  expect(existsSync(path.join(f.home, ".casper/mcp.json"))).toBe(false);
  expect(existsSync(path.join(f.home, ".casper/mcp-consent.json"))).toBe(false);
  onlyProtocol(client);
}, childTestLimit(1));

test("A session/load that fails closes the app's servers, and session/new on the same process then works", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  // One session process, driven directly (as the router drives it), so the retry reaches the process that failed.
  const client = open(f, [], { CASPER_ACP_SESSION: "1" });
  await client.request("initialize", INIT);
  const pidFile = (name: string) => path.join(f.root, `${name}.pid`);
  const entry = (name: string) => ({ name, command: process.execPath, args: [MCP_FIXTURE], env: [{ name: "FIXTURE_PID_FILE", value: pidFile(name) }] });
  const pidOf = (name: string) => existsSync(pidFile(name)) ? Number(readFileSync(pidFile(name), "utf8").trim().split("\n").at(-1)) : 0;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const failed = await client.request("session/load", { sessionId: "no-such-conversation", cwd: f.project, mcpServers: [entry("first")] })
    .then(() => undefined, (error: Error) => error);
  expect(failed?.message).toContain("no-such-conversation");
  const first = await until(() => pidOf("first"), 30_000, "the failed session's server to have started");
  // The failed load left nothing running: its server stopped, and the process holds no session.
  await until(() => !alive(first), 30_000, "the failed session's server to stop");
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [entry("second")] });
  expect(typeof sessionId).toBe("string");
  expect(client.stderr()).toContain("[acp] The app's MCP server acp-second connects for this session.");
  expect(alive(await until(() => pidOf("second"), 30_000, "the new session's server to start"))).toBe(true);
  expect((await client.request("session/prompt", { sessionId, prompt: text("hi") })).stopReason).toBe("end_turn");
  onlyProtocol(client);
}, childTestLimit(1));

test("A read tool from the app runs without a box; a change asks through request_permission", async () => {
  const f = await fixture(callsInTurn({ id: "mcp:acp-app:status" }, { id: "mcp:acp-app:set_site", arguments: { site: "lab" } }));
  const calls = path.join(f.root, "calls.jsonl");
  const client = open(f);
  await client.request("initialize", INIT);
  client.answerPermissions((params) => option(params, "allow_once"));
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [stdioEntry(calls)] });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Read the app's server status, then set site lab") })).stopReason).toBe("end_turn");
  // One box, for the change only, with Casper's choices.
  expect(client.permissions).toHaveLength(1);
  expect(client.permissions[0].options[0]).toMatchObject({ name: "No", kind: "reject_once" });
  expect(JSON.stringify(client.permissions[0])).toContain("set_site");
  expect(await toolsCalled(calls)).toEqual(["status", "set_site"]);
  onlyProtocol(client);
}, childTestLimit(1));

test("A server the app says asks for itself runs its change with no Casper box", async () => {
  const f = await fixture(callsInTurn({ id: "mcp:acp-app:set_site", arguments: { site: "lab" } }));
  const calls = path.join(f.root, "calls.jsonl");
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [stdioEntry(calls, "generic", ASKS)] });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Use the app's server to set site lab") })).stopReason).toBe("end_turn");
  expect(client.permissions).toHaveLength(0);
  expect(await toolsCalled(calls)).toEqual(["set_site"]);
  onlyProtocol(client);
}, childTestLimit(1));

test("A delete-named tool on a clientAsks server still asks for the kind", async () => {
  const f = await fixture(callsInTurn({ id: "mcp:acp-app:delete_site", arguments: { site: "lab" } }));
  const calls = path.join(f.root, "calls.jsonl");
  const client = open(f);
  await client.request("initialize", INIT);
  const answers: string[] = ["reject_once", "allow_once"];
  client.answerPermissions((params) => option(params, answers.shift()!));
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [stdioEntry(calls, "own", ASKS)] });
  // No: nothing is deleted.
  expect((await client.request("session/prompt", { sessionId, prompt: text("Ask the app's server to delete site lab") })).stopReason).toBe("end_turn");
  expect(client.permissions).toHaveLength(1);
  expect(client.permissions[0].toolCall.title).toContain("Allow deletes");
  expect(await toolsCalled(calls)).toEqual([]);
  // Yes to the kind: it runs, with no change box after it (the app asks for that itself).
  expect((await client.request("session/prompt", { sessionId, prompt: text("Ask the app's server to delete site lab again") })).stopReason).toBe("end_turn");
  expect(client.permissions).toHaveLength(2);
  expect(client.permissions[1].toolCall.title).toContain("Allow deletes");
  expect(await toolsCalled(calls)).toEqual(["delete_site"]);
  onlyProtocol(client);
}, childTestLimit(1));

test("The app's http MCP server with a bearer header connects, and the header value never appears in an update or the receipt", async () => {
  const token = `acp-bearer-${crypto.randomUUID()}`;
  const server = await httpFixture(token);
  try {
    // The model even repeats the token in its answer: the client never sees it.
    const f = await fixture((request, payload) => isChecklistCall(payload) ? { text: "[]" }
      : resultsSoFar(payload) === 0 ? { tools: [{ name: "call_capability", args: { id: "mcp:acp-app:whoami", arguments: {} } }] }
      : { text: `The app's server says ${token}.\n` });
    const client = open(f);
    await client.request("initialize", INIT);
    const { sessionId } = await client.request("session/new", { cwd: f.project,
      mcpServers: [{ type: "http", name: "app", url: server.url, headers: [{ name: "Authorization", value: `Bearer ${token}` }], _meta: ASKS }] });
    const done = await client.request("session/prompt", { sessionId, prompt: text("Who does the app's server think I am?") });
    expect(done.stopReason).toBe("end_turn");
    expect(server.calls.map((call) => call.name)).toEqual(["whoami"]);
    expect(server.refused()).toBe(0);
    // The server's answer reached the model with the token hidden.
    expect(JSON.stringify(f.payloads)).not.toContain(token);
    expect(agentText(client.updates, sessionId)).toContain("The app's server says");
    expect(client.lines.join("\n")).not.toContain(token);
    expect(JSON.stringify(done)).not.toContain(token);
    expect(client.stderr()).not.toContain(token);
    onlyProtocol(client);
  } finally { await server.close(); }
}, childTestLimit(1));

test("A call to the app's server carries the ACP tool call id", async () => {
  const token = `acp-bearer-${crypto.randomUUID()}`;
  const server = await httpFixture(token);
  try {
    const f = await fixture(callsInTurn({ id: "mcp:acp-app:set_site", arguments: { site: "lab" } }));
    const client = open(f);
    await client.request("initialize", INIT);
    const { sessionId } = await client.request("session/new", { cwd: f.project,
      mcpServers: [{ type: "http", name: "app", url: server.url, headers: [{ name: "Authorization", value: `Bearer ${token}` }], _meta: ASKS }] });
    expect((await client.request("session/prompt", { sessionId, prompt: text("Use the app's server to set site lab") })).stopReason).toBe("end_turn");
    expect(server.calls).toHaveLength(1);
    const step = ofSession(client, sessionId).find((update) => update.sessionUpdate === "tool_call" && String(update.title).startsWith("call_capability"));
    expect(step?.toolCallId).toMatch(/^casper-tool-\d+$/);
    expect(server.calls[0]!.meta).toEqual({ "casper/acpToolCallId": step.toolCallId });
    // The step names the app's server and tool it reached, and carries the model's arguments.
    expect(step._meta.casper).toMatchObject({ tool: "call_capability", mcp: { server: "acp-app", tool: "set_site" } });
    expect(step.rawInput).toEqual({ id: "mcp:acp-app:set_site", arguments: { site: "lab" } });
    onlyProtocol(client);
  } finally { await server.close(); }
}, childTestLimit(1));

test("acp_mcp off leaves the app's servers unconnected and initialize says http false", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  await writeFile(path.join(f.home, ".casper/config.yaml"), "acp_mcp: off\n");
  const calls = path.join(f.root, "calls.jsonl");
  const client = open(f);
  const init = await client.request("initialize", INIT);
  expect(init.agentCapabilities.mcpCapabilities).toEqual({ http: false, sse: false });
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [stdioEntry(calls)] });
  expect(client.stderr()).toContain("[acp] The app's MCP server acp-app is not connected: acp_mcp is off.");
  expect((await client.request("session/prompt", { sessionId, prompt: text("What does the app's server say its status is?") })).stopReason).toBe("end_turn");
  expect(await toolsCalled(calls)).toEqual([]);
  // The model was never offered the server's tools.
  const offered = JSON.stringify(f.payloads.map((payload) => (payload as Payload & { tools?: unknown }).tools ?? []));
  expect(offered).toContain('"name":"read"');
  expect(offered).not.toContain("call_capability");
  onlyProtocol(client);
}, childTestLimit(1));

describe("the AI's questions reach a form app (decision 83)", () => {
  const FORMS = { ...INIT, clientCapabilities: { ...INIT.clientCapabilities, elicitation: { form: {} } } };
  const ASK = { name: "ask", args: { question: "Which database should the app use?", options: [{ label: "Postgres", description: "a server" }, { label: "SQLite" }] } };
  /** The model asks once, then says what the answer was (the ask tool's result, as the model got it). */
  const asksThenTells = taskTurns((_request, payload) => {
    const last = payload.messages.at(-1);
    return last?.role === "tool" ? { text: `Told: ${JSON.stringify(last.content)}` } : { tools: [ASK] };
  });
  const toolResult = (f: Awaited<ReturnType<typeof fixture>>) => JSON.stringify(f.payloads.at(-1)?.messages.at(-1)?.content ?? "");

  test("The ask tool over casper acp reaches a form client and its answer reaches the model", async () => {
    const f = await fixture(asksThenTells);
    const client = open(f);
    await client.request("initialize", FORMS);
    client.answerForms(() => ({ action: "accept", content: { answer: "2" } }));
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    expect((await client.request("session/prompt", { sessionId, prompt: text("Pick a database for the app") })).stopReason).toBe("end_turn");
    expect(client.forms).toHaveLength(1);
    const form = client.forms[0]!;
    // The form is the ask tool's own step, as the app saw it start: no step of its own.
    const step = ofSession(client, sessionId).find((update) => update.sessionUpdate === "tool_call" && update._meta?.casper?.tool === "ask");
    expect(form).toMatchObject({ sessionId, toolCallId: step?.toolCallId, mode: "form", message: "Which database should the app use?",
      _meta: { casper: { question: { from: "ai", multi: false, typed: true } } } });
    expect(form.requestedSchema.properties.answer.oneOf.map((option: { title: string }) => option.title)).toEqual(["Postgres", "SQLite"]);
    expect(ofSession(client, sessionId).filter((update) => String(update.toolCallId).startsWith("casper-question-"))).toEqual([]);
    expect(toolResult(f)).toContain("SQLite");
    expect(toolResult(f)).toContain('\\"skipped\\":false');
    onlyProtocol(client);
  }, childTestLimit(1));

  test("With acp_questions off the ask tool is skipped and no elicitation/create is sent", async () => {
    const f = await fixture(asksThenTells);
    await writeFile(path.join(f.home, ".casper/config.yaml"), "acp_questions: off\n");
    const client = open(f);
    await client.request("initialize", FORMS);
    client.answerForms(() => ({ action: "accept", content: { answer: "2" } }));
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    expect((await client.request("session/prompt", { sessionId, prompt: text("Pick a database for the app") })).stopReason).toBe("end_turn");
    expect(client.forms).toEqual([]);
    expect(toolResult(f)).toContain("skipped");
    expect(toolResult(f)).not.toContain("SQLite");
    onlyProtocol(client);
  }, childTestLimit(1));

  test("The router passes the client's capabilities to the session and forwards elicitation/create", async () => {
    // A client that did not say it shows forms gets none: the session knows only what the router passed on.
    const f = await fixture(asksThenTells);
    const plain = open(f);
    await plain.request("initialize", INIT);
    const first = await plain.request("session/new", { cwd: f.project, mcpServers: [] });
    expect((await plain.request("session/prompt", { sessionId: first.sessionId, prompt: text("Pick a database for the app") })).stopReason).toBe("end_turn");
    expect(plain.forms).toEqual([]);
    expect(toolResult(f)).toContain("skipped");
    expect(await plain.close()).toBe(0);
    // One that did gets the form from the session it opened, through the router, and its answer goes back.
    const forms = open(f);
    await forms.request("initialize", FORMS);
    forms.answerForms(() => ({ action: "accept", content: { answer: "1", other: "MySQL, please" } }));
    const second = await forms.request("session/new", { cwd: f.project, mcpServers: [] });
    expect((await forms.request("session/prompt", { sessionId: second.sessionId, prompt: text("Pick a database for the app") })).stopReason).toBe("end_turn");
    expect(forms.forms.map((form) => form.sessionId)).toEqual([second.sessionId]);
    expect(toolResult(f)).toContain("MySQL, please");
    onlyProtocol(forms);
  }, childTestLimit(2));

  test("The before-changes question is asked in a form app", async () => {
    // The model writes; Casper's gate sends it to ask first; with the answer it writes.
    const f = await fixture(taskTurns((_request, payload) => {
      const last = JSON.stringify(payload.messages.at(-1)?.content ?? "");
      if (payload.messages.at(-1)?.role !== "tool") return { tools: [{ name: "write", args: { path: "greeting.txt", content: "hello\n" } }] };
      if (last.includes("beforeChanges")) return { tools: [ASK] };
      if (last.includes("answers")) return { tools: [{ name: "write", args: { path: "greeting.txt", content: "hello\n" } }] };
      return { text: "Done." };
    }));
    await mkdir(path.join(f.project, ".casper"));
    await writeFile(path.join(f.project, ".casper/project.yaml"), "behavior:\n  askQuestions: beforeChanges\n");
    const client = open(f);
    await client.request("initialize", FORMS);
    client.answerForms(() => ({ action: "accept", content: { answer: "2" } }));
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    expect((await client.request("session/prompt", { sessionId, prompt: text("Add a greeting page") })).stopReason).toBe("end_turn");
    expect(client.forms).toHaveLength(1);
    expect(JSON.stringify(f.payloads)).toContain("beforeChanges");
    expect(await readFile(path.join(f.project, "greeting.txt"), "utf8")).toBe("hello\n");
    onlyProtocol(client);
  }, childTestLimit(1));
});

describe("an ACP app sees Casper's usage and the receipt's fields (decision 88)", () => {
  shellCheckTest("Usage reaches the app between a response's text and its tool call, and the receipt carries usage, cost and root", async () => {
    const f = await fixture(taskTurns((request) => request === 0 ? { said: "Writing the fix.\n", tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] } : { text: "Fixed sum.js." }));
    await fixProject(f);
    const client = open(f);
    await client.request("initialize", INIT);
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    const done = await client.request("session/prompt", { sessionId, prompt: text("Fix sum.js") });
    expect(done.stopReason).toBe("end_turn");
    const updates = ofSession(client, sessionId);
    const said = updates.findIndex((update) => update.sessionUpdate === "agent_message_chunk" && String(update.content?.text).includes("Writing the fix."));
    const step = updates.findIndex((update) => update.sessionUpdate === "tool_call" && String(update.title).includes("sum.js"));
    const usages = updates.flatMap((update, index) => update.sessionUpdate === "usage_update" ? [{ update, index }] : []);
    // One per task response: the checklist call is not the task's runtime, so it sends none.
    expect(usages).toHaveLength(2);
    expect(said).toBeGreaterThanOrEqual(0);
    expect(said).toBeLessThan(usages[0]!.index);
    expect(usages[0]!.index).toBeLessThan(step);
    // The scripted provider reports 100 prompt and 20 output tokens a response, at $1 and $2 per million: $0.00014.
    for (const [at, { update }] of usages.entries()) {
      expect(update).toMatchObject({ used: 120, size: 128_000, cost: { currency: "USD" },
        _meta: { casper: { response: { input: 100, output: 20, tokens: 120, toolUse: at === 0 }, model: { provider: "fixture", model: "first" }, cost: "estimate" } } });
      // The session's cost so far: each response counted once.
      expect(update.cost.amount).toBeCloseTo(0.00014 * (at + 1), 10);
    }
    const receipt = done._meta.casper.receipt;
    // The task's usage counts the checklist call too.
    expect(receipt).toMatchObject({ usage: { turns: 2, tokens: 360 }, cost: "estimate" });
    // The folder the changed files are in, as the app named it or as the system resolves it.
    expect([f.project, realpathSync(f.project)]).toContain(receipt.root);
    expect(updates.at(-1)._meta.casper.receipt).toEqual(receipt);
    onlyProtocol(client);
  }, childTestLimit(1));
});
