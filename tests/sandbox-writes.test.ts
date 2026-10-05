import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionSandbox, outsideWritesReceipt, runtimeShell, SANDBOX_REFUSED, writeAllowedLine, writeCantAsk, writeDeclined, writeOnceLine, type SandboxHost } from "../src/app/sandbox";
import { writeChoices } from "../src/app/safe-choices";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import type { ShellSandboxOptions } from "../src/sandbox/manager";
import { SandboxStore } from "../src/sandbox/store";
import { formatReceipt, formatTaskResult } from "../src/task/result";
import { fakeEngine } from "./support/sandbox-fakes";
import { posixOnly } from "./support/platform";

/**
 * Writes outside the project, by the AI's shell or its edit and write tools: one question per folder (1 No · 2 Yes,
 * this once · 3 Yes, for this session), never remembered past the session. A run that can't ask refuses at once;
 * private, protected, system and git places are refused without a question.
 */

// The shell sandbox runs only on macOS and Linux, and its refusal lines name POSIX paths, so the shell route
// (posixOnly below) can't ask on Windows. The write and edit tool route asks there too and runs everywhere.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-writes-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project"), app = path.join(home, "apps", "SomeApp");
  await mkdir(project, { recursive: true }); await mkdir(app, { recursive: true }); await mkdir(path.join(home, ".ssh"));
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  return { base, home, project, app, context };
}

function host(answers: Array<string | undefined>, canAsk = true, delay = 0) {
  const asked: Array<{ question: string; options: string[] }> = [];
  const value: SandboxHost = {
    canAsk: () => canAsk,
    pick: async (question, options) => {
      asked.push({ question, options: options.map((option) => option.label) });
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return answers.shift();
    },
    write: () => {},
    planning: () => false,
  };
  return { value, asked };
}

/** A session whose fake sandbox refuses what `refuse` names; the system temp folder is not writable here, so
 * the fixture's own folders count as outside. */
async function session(answers: Array<string | undefined>, options: { canAsk?: boolean; delay?: number; refuse?: (command: string) => string[];
  seams?: Partial<ShellSandboxOptions>; noSandbox?: boolean } = {}) {
  const dirs = await fixture();
  const terminal = host(answers, options.canAsk ?? true, options.delay ?? 0);
  const engine = fakeEngine(options.refuse);
  const sandbox = createSessionSandbox(terminal.value, dirs.context, { root: () => dirs.project, home: dirs.home, ...(options.noSandbox ? { noSandbox: true } : {}),
    seams: { engine, problem: () => undefined, platform: "linux", tempDirs: [], ...options.seams } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(dirs.context.stateDirectory));
  return { ...dirs, terminal, engine, sandbox, shell };
}

const FOLDER = "~/apps/SomeApp";

posixOnly("a shell write outside the project asks once, No first; allowed for the session, the next command may write there", async () => {
  const s = await session(["Yes, for this session"], { refuse: (command) => command.startsWith("touch")
    ? [`deny(1) file-write-create ${path.join(s.app, "config.json")}`] : [] });
  const run = await s.shell.wrap("touch config.json", s.project);
  expect(await s.shell.refused!(run.id!, "")).toBe(writeAllowedLine(FOLDER));
  expect(writeAllowedLine(FOLDER)).toBe(`[sandbox] The user allowed writes to ${FOLDER} for this session. Run the command again.`);
  expect(s.terminal.asked).toEqual([{ question: `A shell command wants to write to ${FOLDER}. Allow it?`, options: ["No", "Yes, this once", "Yes, for this session"] }]);
  // The policy is rebuilt per command: the next one may write the folder; its denies still win.
  await s.shell.wrap("true", s.project);
  expect(s.engine.wrapped.at(-1)!.policy.allowWrite).toContain(s.app);
  // The same folder never asks again this session, by shell or by the AI's write tool.
  expect(await s.shell.outsideWrite!(path.join(s.app, "other.json"))).toBeUndefined();
  expect(s.terminal.asked).toHaveLength(1);
  // The receipt says allowed, not written: the sandbox can't tell whether the rerun wrote there.
  const receipt = outsideWritesReceipt(s.sandbox);
  expect(receipt).toEqual({ outsideAllowed: [FOLDER] });
  expect(formatReceipt({ execution: "completed", ...receipt })).toContain(`• Allowed writes outside the project: ${FOLDER} (no undo copy)`);
  expect(formatReceipt({ execution: "completed", ...receipt })).not.toContain("Wrote outside the project");
  // Nothing is kept for the next session.
  const next = await session([]);
  expect(next.sandbox.allowedWriteFolders()).toEqual([]);
  await s.sandbox.close(); await next.sandbox.close();
});

posixOnly("Yes, this once lets the next shell command write the folder, then it asks again", async () => {
  const s = await session(["Yes, this once", "No"], { refuse: (command) => command.startsWith("touch")
    ? [`deny(1) file-write-create ${path.join(s.app, "config.json")}`] : [] });
  const run = await s.shell.wrap("touch config.json", s.project);
  expect(await s.shell.refused!(run.id!, "")).toBe(writeOnceLine(FOLDER));
  expect(writeOnceLine(FOLDER)).toBe(`[sandbox] The user allowed writes to ${FOLDER} for the next command only. Run the command again.`);
  await s.shell.wrap("touch config.json", s.project);
  expect(s.engine.wrapped.at(-1)!.policy.allowWrite).toContain(s.app);
  await s.shell.wrap("true", s.project);
  expect(s.engine.wrapped.at(-1)!.policy.allowWrite).not.toContain(s.app);
  expect(s.sandbox.allowedWriteFolders()).toEqual([]);
  expect(outsideWritesReceipt(s.sandbox)).toEqual({ outsideAllowed: [FOLDER] });
  await s.sandbox.close();
});

test("Yes, this once lets the AI's write tool write that file once; the next write there asks again", async () => {
  const s = await session(["Yes, this once", "No"], { seams: { platform: "win32" as const } });
  const file = path.join(s.app, "servers.json");
  expect(await s.shell.outsideWrite!(file)).toBeUndefined();
  s.shell.wroteOutside!(file);
  expect(outsideWritesReceipt(s.sandbox)).toEqual({ outsideWrites: [FOLDER] });
  expect(await s.shell.outsideWrite!(file)).toMatch(/^Not done: /);
  expect(s.terminal.asked).toHaveLength(2);
  await s.sandbox.close();
});

posixOnly("No (or Enter) keeps the shell write blocked and tells the AI not to work around it", async () => {
  for (const answer of ["No", undefined]) {
    const s = await session([answer], { refuse: () => [`deny(1) file-write-create ${path.join(s.app, "config.json")}`] });
    const run = await s.shell.wrap("touch config.json", s.project);
    const line = await s.shell.refused!(run.id!, "");
    expect(line).toBe(`[sandbox] Blocked by the sandbox (wanted to write ${path.join(s.app, "config.json")}). ${writeDeclined(FOLDER)}`);
    expect(writeDeclined(FOLDER)).toBe(`The user said no to writing ${FOLDER}. Don't retry it or work around it.`);
    await s.shell.wrap("true", s.project);
    expect(s.engine.wrapped.at(-1)!.policy.allowWrite).not.toContain(s.app);
    expect(s.sandbox.takeOutsideWrites()).toEqual({ wrote: [], allowed: [] });
    await s.sandbox.close();
  }
});

posixOnly("a run that can't ask refuses the shell write at once with the allowWrite fix", async () => {
  const s = await session([], { canAsk: false, refuse: () => [`deny(1) file-write-create ${path.join(s.app, "config.json")}`] });
  const run = await s.shell.wrap("touch config.json", s.project);
  expect(await s.shell.refused!(run.id!, "")).toContain(writeCantAsk(FOLDER));
  expect(writeCantAsk(FOLDER)).toBe(`${FOLDER} is outside this project and this run can't ask. To allow it for one run: --allow-write ${FOLDER}.`);
  expect(s.terminal.asked).toEqual([]);
  await s.sandbox.close();
});

test("private, protected, system and git places, ~ itself, reads and hosts get the plain refusal, never a question", async () => {
  let refusal: string[] = [];
  const s = await session(["Yes, for this session"], { refuse: () => refusal });
  const other = path.join(s.base, "other-repo");
  await mkdir(path.join(other, ".git", "hooks"), { recursive: true });
  for (const lines of [
    [`deny(1) file-write-create ${path.join(s.home, ".bashrc")}`],
    [`deny(1) file-write-create ${path.join(s.home, ".ssh", "config")}`],
    ["deny(1) file-write-data /etc/hosts"],
    [`deny(1) file-write-create ${path.join(other, ".git", "hooks", "pre-commit")}`],
    // A write to an allowed-looking folder, with anything else refused too.
    [`deny(1) file-write-create ${path.join(s.app, "config.json")}`, "network-outbound evil.example:443"],
    [`deny(1) file-read-data ${path.join(s.app, "config.json")}`],
  ]) {
    refusal = lines;
    const run = await s.shell.wrap("do-it", s.project);
    expect(await s.shell.refused!(run.id!, "")).toEndWith(SANDBOX_REFUSED);
  }
  expect(SANDBOX_REFUSED).toBe("The sandbox refuses this every time. Don't retry it or work around it, not with the write or edit tool either. If the task needs it, say in one line what was blocked. No helper scripts for the user to run outside Casper.");
  // The AI's write tool: the same places are refused without a question.
  for (const file of ["/etc/hosts", path.join(s.home, ".bashrc"), path.join(other, ".git", "config"), path.join(s.home, ".ssh", "new")]) {
    expect(await s.shell.outsideWrite!(file)).toMatch(/^Not done: .* is outside this project, and Casper doesn't let the AI write there\.$/);
  }
  expect(s.terminal.asked).toEqual([]);
  await s.sandbox.close();
});

test("the AI's write tool outside the project asks the same question on Windows, and the receipt says so; --no-sandbox turns it off", async () => {
  const s = await session(["Yes, for this session"], { seams: { platform: "win32" as const } });
  expect(s.sandbox.on).toBe(false);
  const file = path.join(s.app, "servers.json");
  expect(await s.shell.outsideWrite!(file)).toBeUndefined();
  expect(s.terminal.asked).toEqual([{ question: `The AI wants to write to ${FOLDER}. Allow it?`, options: ["No", "Yes, this once", "Yes, for this session"] }]);
  // A new file in a new subfolder of it: allowed, no second question.
  expect(await s.shell.outsideWrite!(path.join(s.app, "new", "deep.json"))).toBeUndefined();
  expect(s.terminal.asked).toHaveLength(1);
  s.shell.wroteOutside!(file);
  const receipt = outsideWritesReceipt(s.sandbox);
  expect(receipt).toEqual({ outsideWrites: [FOLDER] });
  expect(outsideWritesReceipt(s.sandbox)).toEqual({});
  expect(formatReceipt({ execution: "completed", ...receipt })).toContain(`• Wrote outside the project: ${FOLDER} (you allowed it; no undo copy)`);
  expect(formatTaskResult({ execution: "completed", ...receipt })).toContain(`wrote ${FOLDER} (you allowed it; no undo copy)`);
  await s.sandbox.close();
  // You turned the sandbox off: outside edits and writes go through as before, no question.
  const off = await session([], { noSandbox: true });
  expect(await off.shell.outsideWrite!(path.join(off.app, "servers.json"))).toBeUndefined();
  expect(off.terminal.asked).toEqual([]);
  await off.sandbox.close();
});

test("the AI's write tool asks about the file alone when its folder can't be offered (~, or ~/Documents holding the project)", async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-writes-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(home, "Documents", "proj");
  await mkdir(path.join(project, ".git", "hooks"), { recursive: true });
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  const terminal = host(["Yes, for this session", "No"]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home,
    seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux", tempDirs: [] } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  const report = path.join(home, "Documents", "report.md");
  expect(sandbox.writeFolder(report)).toBeUndefined();
  expect(await shell.outsideWrite!(report)).toBeUndefined();
  expect(await shell.outsideWrite!(report)).toBeUndefined();
  expect(await shell.outsideWrite!(path.join(home, "notes.md"))).toBe(`Not done: ${writeDeclined("~/notes.md")}`);
  expect(terminal.asked).toEqual([
    { question: "The AI wants to write to ~/Documents/report.md. Allow it?", options: ["No", "Yes, this once", "Yes, for this session"] },
    { question: "The AI wants to write to ~/notes.md. Allow it?", options: ["No", "Yes, this once", "Yes, for this session"] },
  ]);
  // A file allowed for the AI's tools is not the shell's, and not its folder.
  await shell.wrap("true", project);
  expect(sandbox.policy().allowWrite).not.toContain(report);
  expect(sandbox.writeAllowed(path.join(home, "Documents", "other.md"))).toBe(false);
  await sandbox.close();
});

posixOnly("a link in temp to a folder outside still asks about where the write lands", async () => {
  const dirs = await fixture();
  const scratch = path.join(dirs.base, "scratch");
  await mkdir(scratch);
  await symlink(dirs.app, path.join(scratch, "x"));
  const terminal = host(["No"]);
  const sandbox = createSessionSandbox(terminal.value, dirs.context, { root: () => dirs.project, home: dirs.home,
    seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux", tempDirs: [scratch] } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(dirs.context.stateDirectory));
  expect(await shell.outsideWrite!(path.join(scratch, "plain.txt"))).toBeUndefined();
  expect(await shell.outsideWrite!(path.join(scratch, "x", "evil.txt"))).toBe(`Not done: ${writeDeclined(FOLDER)}`);
  expect(terminal.asked).toEqual([{ question: `The AI wants to write to ${FOLDER}. Allow it?`, options: ["No", "Yes, this once", "Yes, for this session"] }]);
  await sandbox.close();
});

posixOnly("one shell command refused for two folders asks one question about both", async () => {
  const both = `${FOLDER} and ~/apps/Other`;
  const s = await session(["Yes, for this session"], { refuse: () => [
    `deny(1) file-write-create ${path.join(s.app, "config.json")}`, `deny(1) file-write-create ${path.join(s.home, "apps", "Other", "b.json")}`] });
  await mkdir(path.join(s.home, "apps", "Other"));
  const run = await s.shell.wrap("do-both", s.project);
  expect(await s.shell.refused!(run.id!, "")).toBe(writeAllowedLine(both));
  expect(s.terminal.asked).toEqual([{ question: `A shell command wants to write to ${both}. Allow it?`, options: ["No", "Yes, this once", "Yes, for this session"] }]);
  expect(s.sandbox.allowedWriteFolders()).toEqual([s.app, path.join(s.home, "apps", "Other")]);
  await s.sandbox.close();
});

test("the AI's write tool: No and a run that can't ask refuse; temp, caches and your allowWrite never ask", async () => {
  const no = await session(["No"]);
  expect(await no.shell.outsideWrite!(path.join(no.app, "servers.json"))).toBe(`Not done: ${writeDeclined(FOLDER)}`);
  await no.sandbox.close();
  const oneShot = await session([], { canAsk: false });
  expect(await oneShot.shell.outsideWrite!(path.join(oneShot.app, "servers.json"))).toBe(`Not done: ${writeCantAsk(FOLDER)}`);
  expect(oneShot.terminal.asked).toEqual([]);
  await oneShot.sandbox.close();
  const dirs = await fixture();
  const scratch = path.join(dirs.base, "scratch");
  await mkdir(scratch);
  const terminal = host([]);
  const sandbox = createSessionSandbox(terminal.value, { ...dirs.context, sandbox: { user: { allowWrite: [FOLDER] }, project: {} } }, { root: () => dirs.project, home: dirs.home,
    seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux", tempDirs: [scratch] } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(dirs.context.stateDirectory));
  expect(await shell.outsideWrite!(path.join(scratch, "out.txt"))).toBeUndefined();
  expect(await shell.outsideWrite!(path.join(dirs.home, ".npm", "_cacache", "x"))).toBeUndefined();
  expect(await shell.outsideWrite!(path.join(dirs.app, "servers.json"))).toBeUndefined();
  expect(terminal.asked).toEqual([]);
  await sandbox.close();
});

test("parallel writes to one folder share one question", async () => {
  const s = await session(["Yes, for this session"], { delay: 30 });
  const results = await Promise.all([
    s.shell.outsideWrite!(path.join(s.app, "a.json")),
    s.shell.outsideWrite!(path.join(s.app, "b.json")),
    s.sandbox.decideWrite(s.app, "shell"),
  ]);
  expect(results).toEqual([undefined, undefined, "allowed"]);
  expect(s.terminal.asked).toHaveLength(1);
  await s.sandbox.close();
});

test("the write choices keep No first; the question names the folder", () => {
  expect(writeChoices(FOLDER).map((choice) => choice.label)).toEqual(["No", "Yes, this once", "Yes, for this session"]);
});

posixOnly("the shell route also asks from Linux's read-only-file-system line", async () => {
  const s = await session(["Yes, for this session"]);
  const run = await s.shell.wrap("touch config.json", s.project);
  expect(await s.shell.refused!(run.id!, `touch: cannot touch '${path.join(s.app, "config.json")}': Read-only file system`)).toBe(writeAllowedLine(FOLDER));
  await s.sandbox.close();
});
