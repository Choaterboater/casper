import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CasperApp } from "../src/app";
import { RESUMED_READY } from "../src/app/commands";
import { openCutShort, savedCutShort } from "../src/app/cut-short";
import { jobsCommand } from "../src/app/jobs";
import { applyRunConversation } from "../src/app/runtime-start";
import { jobsDirectory, writeJobSync, type JobRecord } from "../src/jobs/store";
import { isolatedEnvironment } from "../src/platform/environment";
import type { AgentRuntime, RuntimeConversation, RuntimeSession } from "../src/runtime/types";
import { CUT_SHORT_GO_ON, cutShortLine, cutShortNote, cutShortTurn, markRunning, readCutShort, runningMark, type BranchEntry, type CutShort } from "../src/sessions/cut-short";
import { richApp } from "./support/app";
import { withEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";

/**
 * Casper killed while the AI's `git push` ran: Pi had saved the AI's message with the call, never its result. Resumed,
 * the model reads "No result provided" (an error) for it and may push again. These files are written as Pi writes them.
 */

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });
async function temp(): Promise<string> { const dir = await mkdtemp(path.join(os.tmpdir(), "casper-cut-short-")); roots.push(dir); return dir; }

type Message = Record<string, unknown>;
const user = (text: string, timestamp = 1): Message => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (calls: Array<[string, string, Record<string, unknown>]>, stopReason = "toolUse", timestamp = 2): Message => ({
  role: "assistant", content: [{ type: "text", text: "On it." }, ...calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args }))],
  api: "openai-completions", provider: "fixture", model: "demo", stopReason, timestamp,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const result = (id: string, name: string, text = "done", timestamp = 3): Message => ({ role: "toolResult", toolCallId: id, toolName: name,
  content: [{ type: "text", text }], isError: false, timestamp });

/** A saved conversation file, one message after another, as Pi writes it. */
async function sessionFile(dir: string, messages: Message[]): Promise<string> {
  const file = path.join(dir, `2026-11-17T10-00-00-000Z_0198a000-0000-7000-8000-000000000001.jsonl`);
  const lines: unknown[] = [{ type: "session", version: 3, id: "0198a000-0000-7000-8000-000000000001", timestamp: "2026-11-17T10:00:00.000Z", cwd: dir }];
  messages.forEach((message, index) => lines.push({ type: "message", id: `e${index + 1}`, parentId: index ? `e${index}` : null,
    timestamp: new Date(Date.UTC(2026, 10, 17, 10, 0, index)).toISOString(), message }));
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}

const PUSH: Array<[string, string, Record<string, unknown>]> = [["call_1", "bash", { command: "git push origin main", timeout: 120 }]];

test("a conversation cut short mid-step names each step with no result and the request it worked on", async () => {
  const dir = await temp();
  const file = await sessionFile(dir, [user("push the release"), assistant(PUSH)]);
  const cut = await readCutShort(file);
  expect(cut).toEqual({ entry: "e2", calls: [{ tool: "bash", text: "git push origin main" }], request: "push the release" });
  // Pi opens the same file on the same branch.
  expect(cutShortTurn(SessionManager.open(file, dir).getBranch() as BranchEntry[])).toEqual(cut!);
  // Of two steps, only the one with no result.
  const two = await sessionFile(dir, [user("Casper initial classification:\n- intent: implement\n\nUser request:\nrun the migration"),
    assistant([["a", "write", { path: "db/002.sql", content: "ALTER TABLE t ADD c int;" }], ["b", "bash", { command: "npm run migrate" }]]), result("a", "write")]);
  expect(await readCutShort(two)).toEqual({ entry: "e2", calls: [{ tool: "bash", text: "npm run migrate" }], request: "run the migration" });
});

test("a turn that ended, an Esc, a failed reply, or a request after it is not cut short", async () => {
  const dir = await temp();
  const ended = await sessionFile(dir, [user("push the release"), assistant(PUSH), result("call_1", "bash"), assistant([], "stop", 4)]);
  expect(await readCutShort(ended)).toBeUndefined();
  // Esc while the step ran: Pi gives it a result, and the next reply is recorded as aborted.
  const esc = await sessionFile(dir, [user("push the release"), assistant([...PUSH, ["call_2", "bash", { command: "git push --tags" }]]),
    result("call_1", "bash", "Operation aborted"), assistant([], "aborted", 4)]);
  expect(await readCutShort(esc)).toBeUndefined();
  // Esc as the reply streamed, or a failed reply: Pi never ran its steps and leaves the message out next time.
  expect(await readCutShort(await sessionFile(dir, [user("push the release"), assistant(PUSH, "aborted")]))).toBeUndefined();
  expect(await readCutShort(await sessionFile(dir, [user("push the release"), assistant(PUSH, "error")]))).toBeUndefined();
  // The note already went with a request (or the person asked something else): nothing to say again.
  expect(await readCutShort(await sessionFile(dir, [user("push the release"), assistant(PUSH), user("check the tag", 5)]))).toBeUndefined();
  expect(await readCutShort(path.join(dir, "missing.jsonl"))).toBeUndefined();
});

test("the note names each step, says it may have run, and asks to check before repeating; alone it asks to go on", () => {
  const cut: CutShort = { entry: "e2", calls: [{ tool: "bash", text: "git push origin main" }, { tool: "write", text: "db/002.sql" }], request: "push" };
  const note = cutShortNote(cut);
  expect(note).toContain("- bash: git push origin main\n- write: db/002.sql");
  expect(note).toContain("\"No result provided\" doesn't mean they failed: each may have run, or may still be running.");
  expect(note).toContain("Before you repeat a step that changes something (a push, a migration, a deploy, a write), check whether it already happened.");
  expect(note).not.toContain("go on");
  expect(cutShortNote(cut, true).endsWith("Then go on with the task.")).toBe(true);
  expect(cutShortLine(cut)).toBe("[session] Its last task was cut short while bash and write were running; the AI checks before repeating a step.");
  // A long command is one trimmed line.
  const long = cutShortTurn([{ type: "message", id: "x", message: { role: "assistant", stopReason: "toolUse",
    content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: `echo ${"a".repeat(400)}\nrm -rf build` } }] } }]);
  expect(long!.calls[0]!.text.length).toBe(160);
  expect(long!.calls[0]!.text).not.toContain("\n");
});

test("cut_short: off turns it off; a runtime that can't tell has none", async () => {
  const cut: CutShort = { entry: "e2", calls: [{ tool: "bash", text: "git push origin main" }] };
  const session = { cutShort: () => cut } as unknown as RuntimeSession;
  expect(openCutShort({}, session)).toEqual(cut);
  expect(openCutShort({ projectContext: { cutShort: true } }, session)).toEqual(cut);
  expect(openCutShort({ projectContext: { cutShort: false } }, session)).toBeUndefined();
  expect(openCutShort({}, { cutShort: () => { throw new Error("no record"); } } as unknown as RuntimeSession)).toBeUndefined();
  const dir = await temp();
  const file = await sessionFile(dir, [user("push the release"), assistant(PUSH)]);
  const conversation = { id: "a", modified: new Date().toISOString(), file };
  expect((await savedCutShort({}, conversation))?.entry).toBe("e2");
  expect(await savedCutShort({ projectContext: { cutShort: false } }, conversation)).toBeUndefined();
});

test("a conversation another live Casper is working in isn't cut short; one whose Casper is gone is", async () => {
  const dir = await temp();
  const file = await sessionFile(dir, [user("push the release"), assistant(PUSH)]);
  // Another Casper in the same folder, its git push still running: its mark names a live process.
  writeFileSync(runningMark(file), String(process.ppid));
  expect(await readCutShort(file)).toBeUndefined();
  // Its process is gone (it crashed mid-step): the mark it left doesn't count.
  writeFileSync(runningMark(file), "999999991");
  expect((await readCutShort(file))?.entry).toBe("e2");
  // This process's own mark: it is this Casper's own conversation.
  const unmark = markRunning(file);
  expect(await readCutShort(file)).toBeDefined();
  unmark();
  expect(existsSync(runningMark(file))).toBe(false);
  expect(markRunning(path.join(dir, "missing", "x.jsonl"))).toBeFunction();
});

/** A runtime whose saved conversation is `saved`, cut short (`cut`) once it is opened, until a request is in it. A prompt
 * that `fails` throws before its request reaches the conversation (no sign-in), so it stays cut short. */
function runtime(saved: RuntimeConversation[], cut: CutShort | undefined, resumed: string[], prompts: string[], project: string,
  fails: (text: string) => boolean = () => false): AgentRuntime {
  let answered = false;
  const file = path.join(path.dirname(project), "session.jsonl");
  writeFileSync(file, "");
  return {
    async start() {
      return {
        setTools: () => {},
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const }),
        getState: () => ({ cwd: "", isStreaming: false }),
        getSessionInfo: () => ({ cwd: project, sessionId: "current", sessionFile: file }),
        forkSession: async () => ({ cwd: project, sessionId: "fork", sessionFile: file }),
        switchSession: async () => ({ cwd: project, sessionId: "current", sessionFile: file }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async (text: string) => {
          prompts.push(text);
          if (fails(text)) throw new Error("No API key found for the fixture provider");
          answered = true;
        },
        listConversations: async () => saved,
        resumeConversation: async (id: string) => { resumed.push(id); },
        recentTurns: () => [],
        cutShort: () => resumed.length && !answered ? cut : undefined,
      };
    },
    async dispose() {},
  };
}

test("the start's row goes on with a task cut short; its key sends the note alone, once", async () => {
  const dir = await temp();
  const file = await sessionFile(dir, [user("push the release"), assistant(PUSH)]);
  const cut = await readCutShort(file);
  const saved: RuntimeConversation[] = [{ id: "a0a0a0a0-0000", name: "push the release", modified: new Date().toISOString(), messages: 2, file }];
  const resumed: string[] = [], prompts: string[] = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => runtime(saved, cut, resumed, prompts, project), { savedConversations: async () => saved });
    try {
      await app.until(text => /1\s+Go on with the task that was cut short \(push the release, today\)/.test(text));
      // One key, no second choice; anything typed still starts a new conversation.
      expect(app.screen()).not.toContain("Continue today's conversation");
      expect(app.screen()).toContain("Anything you type starts a new conversation");
      app.input.write("1\r");
      await app.until(() => prompts.length === 1);
      expect(resumed).toEqual(["a0a0a0a0-0000"]);
      expect(prompts[0]).toContain("- bash: git push origin main");
      expect(prompts[0]).toContain("Then go on with the task.");
      expect(prompts[0]).not.toContain(CUT_SHORT_GO_ON);
      await app.until(text => text.includes("[session] Continuing today's conversation (push the release)."));
      await app.until(text => text.lastIndexOf("idle") > text.lastIndexOf("Continuing today's conversation"));
      app.input.write("check the tag\r");
      await app.until(() => prompts.length === 2);
      expect(prompts[1]).toContain("check the tag");
      expect(prompts[1]).not.toContain("Casper note:");
    } finally { await app.close(); }
  });
}, 30_000);

test("/continue into a task cut short says so before Ready, and the next request carries the note", async () => {
  const cut: CutShort = { entry: "e2", calls: [{ tool: "bash", text: "git push origin main" }], request: "push the release" };
  const saved: RuntimeConversation[] = [{ id: "a0a0a0a0-0000", name: "push the release", modified: new Date().toISOString(), messages: 2 }];
  const resumed: string[] = [], prompts: string[] = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => runtime(saved, cut, resumed, prompts, project));
    try {
      await app.until(text => text.includes("idle"));
      app.input.write("/continue\r");
      await app.until(text => text.includes(RESUMED_READY));
      const screen = app.screen();
      expect(screen.indexOf(cutShortLine(cut))).toBeGreaterThan(-1);
      expect(screen.indexOf(cutShortLine(cut))).toBeLessThan(screen.indexOf(RESUMED_READY));
      app.input.write("make the tag too\r");
      await app.until(() => prompts.length === 1);
      expect(prompts[0]).toContain(cutShortNote(cut));
      expect(prompts[0]).toContain("make the tag too");
      expect(prompts[0]).not.toContain("Then go on with the task.");
    } finally { await app.close(); }
  });
}, 30_000);

test("a request that failed before it reached the conversation leaves the note for the next one", async () => {
  const cut: CutShort = { entry: "e2", calls: [{ tool: "bash", text: "git push origin main" }], request: "push the release" };
  const saved: RuntimeConversation[] = [{ id: "a0a0a0a0-0000", name: "push the release", modified: new Date().toISOString(), messages: 2 }];
  const resumed: string[] = [], prompts: string[] = [];
  let failing = true;
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => runtime(saved, cut, resumed, prompts, project, () => failing));
    try {
      await app.until(text => text.includes("idle"));
      app.input.write("/continue\r");
      await app.until(text => text.includes(RESUMED_READY));
      app.input.write("make the tag too\r");
      await app.until(() => prompts.length === 1);
      expect(prompts[0]).toContain(cutShortNote(cut));
      await app.until(text => text.includes("No API key found"));
      await app.until(text => text.lastIndexOf("idle") > text.lastIndexOf("No API key found"));
      // Signed in again: the request that goes through still carries the note, and the one after it doesn't.
      failing = false;
      app.input.write("go on\r");
      await app.until(() => prompts.length === 2);
      expect(prompts[1]).toContain(cutShortNote(cut));
      await app.until(text => text.lastIndexOf("idle") > text.lastIndexOf("go on"));
      app.input.write("check the tag\r");
      await app.until(() => prompts.length === 3);
      expect(prompts[2]).not.toContain("Casper note:");
    } finally { await app.close(); }
  });
}, 30_000);

test("with cut_short: off the start keeps its usual Continue row and no note is sent", async () => {
  const dir = await temp();
  const file = await sessionFile(dir, [user("push the release"), assistant(PUSH)]);
  const cut = await readCutShort(file);
  const saved: RuntimeConversation[] = [{ id: "a0a0a0a0-0000", name: "push the release", modified: new Date().toISOString(), messages: 2, file }];
  const resumed: string[] = [], prompts: string[] = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => runtime(saved, cut, resumed, prompts, project), { savedConversations: async () => saved },
      { homeFiles: { ".casper/config.yaml": "cut_short: off\n" } });
    try {
      await app.until(text => /1\s+Continue today's conversation \(push the release, 2 messages\)/.test(text));
      expect(app.screen()).not.toContain("cut short");
      app.input.write("1\r");
      await app.until(text => text.includes(RESUMED_READY));
      expect(app.screen()).not.toContain("cut short");
      app.input.write("make the tag too\r");
      await app.until(() => prompts.length === 1);
      expect(prompts[0]).not.toContain("Casper note:");
    } finally { await app.close(); }
  });
}, 30_000);

test("an Esc'd conversation keeps the start's usual Continue row", async () => {
  const dir = await temp();
  const file = await sessionFile(dir, [user("push the release"), assistant(PUSH, "aborted")]);
  const saved: RuntimeConversation[] = [{ id: "a0a0a0a0-0000", name: "push the release", modified: new Date().toISOString(), messages: 2, file }];
  const resumed: string[] = [], prompts: string[] = [];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => runtime(saved, undefined, resumed, prompts, project), { savedConversations: async () => saved });
    try {
      await app.until(text => /1\s+Continue today's conversation \(push the release, 2 messages\)/.test(text));
      expect(app.screen()).not.toContain("cut short");
    } finally { await app.close(); }
  });
}, 30_000);

test("--continue into a task cut short says so", async () => {
  const cut: CutShort = { entry: "e2", calls: [{ tool: "bash", text: "git push origin main" }] };
  const lines: string[] = [];
  const app = { runConversation: { continue: true }, interactive: false, output: { write: (text: string) => { lines.push(text); } } } as unknown as CasperApp;
  const session = { listConversations: async () => [{ id: "a0a0a0a0-0000", modified: "2026-11-17T10:00:00.000Z", messages: 2 }],
    resumeConversation: async () => {}, getSessionInfo: () => ({ cwd: "", sessionId: "current", sessionFile: "" }), cutShort: () => cut } as unknown as RuntimeSession;
  await applyRunConversation(app, session);
  expect(lines).toEqual(["[session] Continuing conversation a0a0a0a0-0000.\n", `${cutShortLine(cut)}\n`]);
});

test("a walk-away job Casper stopped mid-step offers to go on with it in its own folder, and says where elsewhere", async () => {
  const home = await temp();
  const state = path.join(home, ".casper", "projects", "app-0123456789abcdef");
  const record: JobRecord = { version: 1, id: "a1b2c3d4e5f6", pid: 999_999_991, root: path.join(home, "app"), folder: "app", request: "push the release",
    leftAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", status: "running" };
  writeJobSync(jobsDirectory(state), record);
  const file = await sessionFile(home, [user("push the release"), assistant(PUSH)]);
  const saved: RuntimeConversation[] = [{ id: "a0a0a0a0-0000", name: "push the release", modified: new Date().toISOString(), messages: 2, file }];
  const lines: string[] = [], rows: string[] = [];
  const app = (stateDirectory: string) => ({ output: { write: (text: string) => { lines.push(text); } }, interactive: true, homeDir: () => home,
    projectContext: { stateDirectory }, savedConversations: async () => saved,
    terminal: { offerNext: (row?: { line: string }) => { if (row) rows.push(row.line); } } }) as unknown as CasperApp;
  // Its process is gone, so it reads as stopped before it ended.
  await jobsCommand(app(state), `show ${record.id}`);
  expect(lines.join("")).toContain("stopped");
  expect(rows).toEqual([expect.stringContaining("Next: 1 Go on with the task that was cut short (push the release, today)")]);
  // From another folder: where to go on with it.
  lines.length = 0; rows.length = 0;
  await jobsCommand(app(path.join(home, ".casper", "projects", "web-0123456789abcdef")), "show app-0123456789abcdef/a1b2c3d4e5f6");
  expect(lines.join("")).toContain("[jobs] Its last task was cut short while bash was running. To go on with it, start Casper in ");
  expect(rows).toEqual([]);
});

test("Pi's runtime marks the conversation as its own while a request runs, and takes the mark away after", async () => {
  const root = await realpath(await temp());
  const home = path.join(root, "home"), project = path.join(root, "project"), agent = path.join(home, ".casper/agent");
  await mkdir(agent, { recursive: true }); await mkdir(project);
  const marks = async () => (await readdir(path.join(agent, "sessions"), { recursive: true }).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl.running"));
  const seen: string[] = [];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    await request.json();
    // While the request runs: one mark, naming the process that runs it.
    for (const mark of await marks()) seen.push(`${(await readFile(path.join(agent, "sessions", mark), "utf8")) === String(child?.pid)}`);
    const chunk = `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "DONE" }, finish_reason: "stop" }] })}\n\n`;
    return new Response(`${chunk}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture" }] } } }));
    const routing = { defaultProvider: "fixture", defaultModel: "fixture" };
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ ...routing, retry: { enabled: false } }));
    await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify(routing));
    child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/runtime/pi.ts"))};
      const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd(), localModels: false });
      try { await session.prompt("Say done."); console.log(JSON.stringify({ file: session.getSessionInfo().sessionFile })); } finally { await runtime.dispose(); }`],
    { cwd: project, env: { ...isolatedEnvironment(home), TMPDIR: root, PI_CODING_AGENT_DIR: agent, CASPER_AGENT_DIR: agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" },
      stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(seen).toEqual(["true"]);
    expect(await marks()).toEqual([]);
    expect(existsSync(JSON.parse(stdout).file)).toBe(true);
  } finally { server.stop(true); }
}, 30_000);
