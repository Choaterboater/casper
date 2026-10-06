// Casper's screen in a real Windows pseudo-console (ConPTY), driven like a person at Windows Terminal: keys go in
// as Windows Terminal sends them, the screen comes back through the console, and the checks read the screen text.
// Tasks use a local fake model server; nothing signs in and nothing leaves this machine.
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { ConptySession } from "./support/conpty";
import { removeTempDir } from "./support/temp-dir";

// Windows only. POSIX screens run through the Python PTY fixtures (tests/fixtures/*-pty.py), which need the pty
// module Windows doesn't have; this file is their Windows counterpart.
const conpty = test.skipIf(process.platform !== "win32");
const repo = path.resolve(import.meta.dir, "..");
// WINDOWS_SCREEN_BINARY runs the same checks against a built casper-windows-x64.exe instead of the source (not a
// CASPER_ name: the test preload clears those).
const casperCommand = process.env.WINDOWS_SCREEN_BINARY ? [path.resolve(process.env.WINDOWS_SCREEN_BINARY)] : [process.execPath, path.join(repo, "src/cli.ts")];
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Terminal = "windows-terminal" | "old-console";
interface Started { s: ConptySession; home: string; project: string; release: () => void; requests: string[]; conversations: string[] }

/** The user's request in a model call: Casper wraps it, so take what follows "User request:". */
function requestText(body: { messages: { role: string; content: unknown }[] }): string {
  const user = body.messages.filter((message) => message.role === "user").at(-1);
  const content = typeof user?.content === "string" ? user.content
    : Array.isArray(user?.content) ? user.content.map((part: { text?: string }) => part.text ?? "").join("") : "";
  return content.split("User request:\n").at(-1)!.trim();
}

/** A fake OpenAI-style model: "make hello" writes hello.txt, "run mkdir" asks to run `mkdir made`, "slow …" waits
 * for release(), anything else answers "Answer: <request>". */
function fakeModel() {
  let calls = 0;
  const requests: string[] = [];
  const conversations: string[] = []; // each call's messages, as JSON
  let waiting: (() => void)[] = [];
  const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  const tool = (name: string, args: unknown) => chunk({ role: "assistant", tool_calls: [{
    index: 0, id: `call_${++calls}`, type: "function", function: { name, arguments: JSON.stringify(args) },
  }] }, null) + chunk({}, "tool_calls");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    const body = await request.json() as { messages: { role: string; content: unknown }[] };
    const text = requestText(body);
    if (body.messages.at(-1)?.role === "user") requests.push(text);
    conversations.push(JSON.stringify(body.messages));
    let reply: string;
    if (body.messages.at(-1)?.role === "tool") reply = chunk({ role: "assistant", content: "Done with the step." }, "stop");
    else if (text === "make hello") reply = tool("write", { path: "hello.txt", content: "hello\n" });
    else if (text === "run mkdir") reply = tool("bash", { command: "mkdir made" });
    else if (text.startsWith("slow")) {
      await new Promise<void>((resolve) => waiting.push(resolve));
      reply = chunk({ role: "assistant", content: `Finished ${text}.` }, "stop");
    } else reply = chunk({ role: "assistant", content: `Answer: ${text}` }, "stop");
    return new Response(reply + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const release = () => { const now = waiting; waiting = []; for (const resolve of now) resolve(); };
  return { server, release, requests, conversations };
}

async function startCasper(options: { terminal?: Terminal; env?: Record<string, string>; cols?: number; rows?: number } = {}): Promise<Started> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-conpty-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true });
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "README.md"), "# demo\n"); // An empty folder would offer a new project first.
  const { server, release, requests, conversations } = fakeModel();
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture" }],
  } } }));
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false } }));
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }));
  // Windows Terminal sets WT_SESSION; the old console (conhost) sets nothing. Neither sets TERM.
  const env = isolatedEnvironment(home, {
    CASPER_OFFLINE: "1", PI_TELEMETRY: "0", CASPER_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
    CASPER_BROWSER_EXECUTABLE: path.join(home, "no-browser"),
    ...(options.terminal === "old-console" ? {} : { WT_SESSION: "00000000-0000-0000-0000-000000000000" }),
    ...options.env,
  });
  const s = new ConptySession(casperCommand, { cwd: project, env, cols: options.cols, rows: options.rows });
  cleanup.push(async () => {
    await s.close();
    release();
    server.stop(true);
    await removeTempDir(root);
  });
  await idle(s);
  return { s, home, project, release, requests, conversations };
}

/** The last line on screen: the footer. */
const footer = (s: ConptySession) => s.visible().trimEnd().split("\n").at(-1) ?? "";
/** Casper waits for a line: the idle footer (○ then the project, │ between parts; the first frame's "○ Casper · /
 * for commands" comes before Casper reads keys) and an empty editor. Wait for a command's own output first: just
 * after Enter the footer still shows the idle from before. */
const idle = (s: ConptySession) => s.waitFor("idle footer", () => footer(s).startsWith("○ ") && footer(s).includes(" │ ") && /^❯\s*$/m.test(s.visible()));
/** A choice box ignores keys for a moment after it opens, so a key typed early can't answer it. */
const boxReady = () => Bun.sleep(600);
/** Separator lines drawn across the whole screen at this width. */
const ruleWidths = (s: ConptySession) => s.visible().split("\n").filter((line) => /^─{20,}$/.test(line)).map((line) => line.length);

async function exitWith(s: ConptySession, keys: () => void): Promise<number | null> {
  keys();
  return s.exited(15_000);
}

conpty("ConPTY: a small task, undo and redo, and a shell command that asks first", async () => {
  const { s, project } = await startCasper();
  expect(s.text()).toContain("not sandboxed (Windows has no sandbox yet)");
  s.send("make hello\n");
  await s.until("✓ write · hello.txt");
  await s.until("Next: 1 Show diff · 2 Undo");
  await idle(s);
  expect(await readFile(path.join(project, "hello.txt"), "utf8")).toBe("hello\n");

  s.send("/undo\n");
  await s.until("✓ Undone");
  await idle(s);
  expect(existsSync(path.join(project, "hello.txt"))).toBe(false);
  s.send("/redo\n");
  await s.until("✓ Redone");
  await idle(s);
  expect(await readFile(path.join(project, "hello.txt"), "utf8")).toBe("hello\n");

  // No sandbox on Windows: a command that changes things asks first, in a numbered box where 1 is No.
  s.send("run mkdir\n");
  await s.until("Run this command?  mkdir made");
  await s.until("→ 1 No");
  await boxReady();
  s.send("2");
  await s.until("✓ bash · mkdir made");
  await idle(s);
  expect(existsSync(path.join(project, "made"))).toBe(true);

  expect(await exitWith(s, () => s.send("/exit\n"))).toBe(0);
}, 120_000);

conpty("ConPTY: numbered sign-in with hidden key entry, /settings, /resume picker and /pane", async () => {
  const { s, home, conversations } = await startCasper();
  s.send("/login\n");
  await s.until("Type a number (1-6), or Up/Down and Enter · Esc cancels");
  expect(s.visible()).toContain("→ 1 ");
  await boxReady();
  s.press("escape");
  await s.until("[login] Cancelled; no credential saved.");
  await idle(s);

  // Arrows move the highlight; a pasted key stays hidden and is not saved on Esc.
  const secret = "synthetic-private-api-key-0123456789";
  s.send("/login\n");
  await s.untilNew("Type a number (1-6)");
  await boxReady();
  s.press("down");
  s.press("down");
  await s.waitFor("row 3 highlighted", () => /→ 3 Anthropic \(Claude\) · paste an API key/.test(s.visible()));
  s.press("enter");
  await s.until("Private input: [empty]");
  s.write(`\x1b[200~${secret}\x1b[201~`);
  await s.until(`Private input: ${secret.length} characters (hidden)`);
  s.press("escape");
  await s.untilNew("[login]");
  await idle(s);
  expect(s.raw).not.toContain(secret);
  expect(await readFile(path.join(home, ".pi/agent/auth.json"), "utf8").catch(() => "")).not.toContain(secret);

  s.send("/settings\n");
  await s.until("Pick one to change:");
  await s.until("→ 1 Done");
  await boxReady();
  s.press("escape");
  await s.until("(skipped)");
  await idle(s);

  s.send("hello one\n");
  await s.until("Answer: hello one");
  await idle(s);
  s.send("/clear\n");
  await s.until("[session] New conversation.");
  await idle(s);
  s.send("/resume\n");
  await s.until("Resume which conversation?");
  await s.until("2 hello one");
  await boxReady();
  s.send("2");
  await s.until("[session] Back in");
  await idle(s);
  // Back in that conversation: the model sees its earlier messages.
  s.send("hello two\n");
  await s.until("Answer: hello two");
  expect(conversations.at(-1)).toContain("hello one");
  await idle(s);

  s.send("/pane\n");
  await s.until("[pane]");
  await idle(s);
  expect(await exitWith(s, () => s.send("/exit\n"))).toBe(0);
}, 120_000);

conpty("ConPTY: Enter during a task steers it, Ctrl+C stops a task, and Ctrl+C twice exits", async () => {
  const { s, release, requests } = await startCasper();
  s.send("slow one\n");
  // Steering needs the model call under way; a line typed before that is queued (the next test).
  await s.waitFor("the model call", () => requests.includes("slow one"));
  s.send("also this\n");
  await s.until("↳ sent to the AI");
  release();
  await s.until("Finished slow one.");
  await s.until("Answer: also this");
  await idle(s);

  s.send("slow two\n");
  await s.waitFor("the model call", () => requests.includes("slow two"));
  s.press("ctrl+c");
  await s.until("Stopped — cancelled");
  await idle(s);
  release();

  s.press("ctrl+c");
  await s.until("Ctrl-C again to exit");
  expect(await exitWith(s, () => s.press("ctrl+c"))).toBe(0);
}, 120_000);

conpty("ConPTY: a resize redraws at the new width, also with a choice box open", async () => {
  const { s } = await startCasper({ cols: 100, rows: 30 });
  expect(ruleWidths(s)).toEqual([100, 100]);
  s.resize(60, 20);
  await s.waitFor("60-wide rules", () => ruleWidths(s).length > 0 && ruleWidths(s).every((width) => width === 60));
  await idle(s);

  s.send("/settings\n");
  await s.until("Press 1-8");
  s.resize(80, 24);
  await s.waitFor("80-wide rules", () => ruleWidths(s).length > 0 && ruleWidths(s).every((width) => width === 80));
  expect(s.visible()).toContain("Press 1-8");
  await boxReady();
  s.press("escape");
  await s.until("(skipped)");
  await idle(s);

  s.resize(40, 15);
  await s.waitFor("40-wide rules", () => ruleWidths(s).length > 0 && ruleWidths(s).every((width) => width === 40));
  s.send("hello narrow\n");
  await s.until("Answer: hello narrow");
  await idle(s);
  expect(ruleWidths(s).every((width) => width === 40)).toBe(true);
  expect(await exitWith(s, () => s.send("/exit\n"))).toBe(0);
}, 120_000);

conpty("ConPTY: Windows Terminal gets rounded corners and color, the old console square corners, NO_COLOR no color", async () => {
  const colour = /\x1b\[(?:[0-9;]*;)?(?:3[0-7]|9[0-7])m/;
  for (const [terminal, env, corner, coloured] of [
    ["windows-terminal", {}, "╭─ Sign in", true],
    ["old-console", {}, "┌─ Sign in", true],
    ["windows-terminal", { NO_COLOR: "1" }, "╭─ Sign in", false],
  ] as const) {
    const { s } = await startCasper({ terminal, env });
    s.send("/login\n");
    await s.until("Type a number (1-6)");
    expect(s.visible()).toContain(corner);
    await boxReady();
    s.press("escape");
    await s.until("[login] Cancelled");
    await idle(s);
    expect({ terminal, env, coloured: colour.test(s.raw) }).toEqual({ terminal, env, coloured });
    // The tab title names Casper and the folder.
    expect(s.raw).toContain("\x1b]0;Casper · project\x07");
    expect(await exitWith(s, () => s.send("/exit\n"))).toBe(0);
  }
}, 180_000);

conpty("ConPTY: a line typed during work is queued, and Esc stops the task and gives it back", async () => {
  // The scripted app (tests/fixtures/terminal-app.ts): its runtime can't steer, so a line during work is queued.
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-conpty-queue-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "README.md"), "# demo\n");
  const env = isolatedEnvironment(home, { CASPER_TTY_CONTROL: root, WT_SESSION: "00000000-0000-0000-0000-000000000000" });
  const s = new ConptySession([process.execPath, path.join(repo, "tests/fixtures/terminal-app.ts")], { cwd: project, env });
  cleanup.push(async () => { await s.close(); await removeTempDir(root); });
  await idle(s);
  s.send("hold\n");
  await s.until("Waiting for cancellation.");
  s.send("next idea\n");
  await s.until("↳ queued · runs when this task ends");
  s.press("escape");
  await s.waitFor("the line back in the prompt", () => /^❯ next idea\s*$/m.test(s.visible()) && footer(s).startsWith("○ "));
  // Sent again, it runs as its own task.
  s.press("enter");
  await s.until("Echo: next idea");
  await idle(s);
  expect(await exitWith(s, () => s.send("/exit\n"))).toBe(0);
}, 120_000);

conpty("ConPTY: Windows Terminal keys: Ctrl+Enter adds a line, Shift+Tab cycles effort, Up brings back the last line", async () => {
  const { s } = await startCasper();
  // Windows Terminal sends Shift+Enter as a plain Enter, so the new-line keys there are Ctrl+Enter and Ctrl+J.
  s.send("one");
  s.press("ctrl+enter");
  s.send("two");
  s.write("\n"); // Ctrl+J
  s.send("three");
  await s.waitFor("three lines in the editor", () => /^❯ one\n {2}two\n {2}three\s*$/m.test(s.visible()));
  s.press("enter");
  await s.until("Answer: one\ntwo\nthree");
  await idle(s);
  s.press("up");
  await s.waitFor("the last line back", () => /^❯ one\n {2}two\n {2}three\s*$/m.test(s.visible()));
  s.press("ctrl+c"); // Clears the draft.
  await s.waitFor("an empty editor", () => /^❯\s*$/m.test(s.visible()));
  s.press("shift+tab");
  await s.waitFor("effort in the footer", () => /effort .*saved/.test(footer(s)));
  await idle(s);
  expect(await exitWith(s, () => s.send("/exit\n"))).toBe(0);
}, 120_000);
