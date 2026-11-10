import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUNDLE_ELSEWHERE, createSessionSandbox, OUTSIDE_RUN_DECLINED, outsideWritesReceipt, runtimeShell, SANDBOX_REFUSED, writeAllowedLine, writeCantAsk, writeDeclined, writeOnceLine, type SandboxHost } from "../src/app/sandbox";
import { writeChoices } from "../src/app/safe-choices";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import type { ShellSandboxOptions } from "../src/sandbox/manager";
import { SandboxStore } from "../src/sandbox/store";
import { formatReceipt, formatTaskResult } from "../src/task/result";
import { privateFilePlace } from "../src/platform/project-paths";
import { fakeEngine } from "./support/sandbox-fakes";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/**
 * Writes outside the project, by the AI's shell or its edit and write tools: one question per folder (1 No · 2 Yes,
 * this once · 3 Yes, for this session), never remembered past the session. A run that can't ask refuses at once;
 * private, protected, system and git places are refused without a question.
 */

// The shell sandbox runs only on macOS and Linux, and its refusal lines name POSIX paths, so the shell route
// (posixOnly below) can't ask on Windows. The write and edit tool route asks there too and runs everywhere.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

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
  expect(formatReceipt({ execution: "completed", ...receipt })).toContain(`– Allowed writes outside the project: ${FOLDER} (no undo copy)`);
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

test("the AI's write into ~/.aws after a yes in the private box asks nothing more, and the receipt still names the file (decision 95)", async () => {
  for (const options of [{ seams: { platform: "win32" as const } }, { noSandbox: true }, {}]) {
    const s = await session([], options);
    const file = path.join(s.home, ".aws", "config");
    // Without the private box's yes, ~/.aws is not a place the write box offers (--no-sandbox asks no write box at all).
    if (!("noSandbox" in options)) expect(await s.shell.outsideWrite!(file)).toMatch(/^Not done: /);
    expect(await s.shell.outsideWrite!(file, { asked: true })).toBeUndefined();
    expect(s.terminal.asked).toEqual([]);
    s.shell.wroteOutside!(file);
    const receipt = outsideWritesReceipt(s.sandbox);
    expect(receipt).toEqual({ outsideWrites: ["~/.aws/config"] });
    expect(formatReceipt({ execution: "completed", ...receipt })).toContain("– Wrote outside the project: ~/.aws/config (you allowed it; no undo copy)");
    // It allowed that one write, nothing more: a second write there is not on the next receipt unless asked again.
    s.shell.wroteOutside!(file);
    expect(outsideWritesReceipt(s.sandbox)).toEqual({});
    expect(s.sandbox.writeAllowed(file)).toBe(false);
    await s.sandbox.close();
  }
});

test("a write the private box's yes would still refuse is refused with no box: a system folder or the project's denyWrite (decision 95)", async () => {
  const dirs = await fixture();
  const system = path.resolve("/etc/casper-placeholder.conf");
  const denied = path.join(dirs.home, "notes", "plan.txt"), onlyPrivate = path.join(dirs.home, "notes", "draft.txt");
  // A project's sandbox.denyRead makes its entries private places, so each of these is one the private box names.
  const context = { ...dirs.context, sandbox: { user: dirs.context.sandbox?.user ?? {}, project: { denyRead: [system, denied, onlyPrivate], denyWrite: [denied] } } };
  for (const platform of ["win32", "linux"] as const) {
    const terminal = host(["Yes, this once"]);
    const sandbox = createSessionSandbox(terminal.value, context, { root: () => dirs.project, home: dirs.home,
      seams: { engine: fakeEngine(), problem: () => undefined, platform, tempDirs: [] } });
    const shell = runtimeShell({ ...terminal.value, privateCommands: () => true }, sandbox, new SandboxStore(context.stateDirectory));
    const pathContext = { root: dirs.project, home: dirs.home, denyRead: sandbox.policy().denyRead };
    for (const file of [system, denied, onlyPrivate]) expect(privateFilePlace("write", { path: file }, pathContext)?.question).toStartWith("Change ");
    // Checked before the private box asks: as without it, a system folder and a place the project denies writing are refused.
    expect(shell.privateWriteRefused!(system)).toBe(`Not done: ${system} is outside this project, and Casper doesn't let the AI write there.`);
    expect(shell.privateWriteRefused!(denied)).toBe("Not done: ~/notes/plan.txt is outside this project, and Casper doesn't let the AI write there.");
    expect(terminal.asked).toEqual([]);
    // After a yes too, should one get there.
    expect(await shell.outsideWrite!(system, { asked: true })).toBe(`Not done: ${system} is outside this project, and Casper doesn't let the AI write there.`);
    // A place that is only private: the private box is the one box.
    expect(shell.privateWriteRefused!(onlyPrivate)).toBeUndefined();
    const place = privateFilePlace("write", { path: onlyPrivate }, pathContext)!;
    expect(await shell.askPrivate!(place.key!, place)).toBeUndefined();
    expect(await shell.outsideWrite!(onlyPrivate, { asked: true })).toBeUndefined();
    expect(terminal.asked).toHaveLength(1);
    await sandbox.close();
  }
});

test("a project's sandbox.denyRead naming a place Casper denies writing for another reason opens no write there: a moved agent store, ~/.claude/debug (decision 95)", async () => {
  const dirs = await fixture();
  // CASPER_AGENT_DIR outside home: denied whole, as ~/.casper is.
  const agentDir = path.join(dirs.base, "agent-store"), debug = path.join(dirs.home, ".claude", "debug"), onlyPrivate = path.join(dirs.home, "notes");
  const context = { ...dirs.context, sandbox: { user: dirs.context.sandbox?.user ?? {}, project: { denyRead: [agentDir, "~/.claude/debug", onlyPrivate] } } };
  for (const platform of ["win32", "linux", "darwin"] as const) {
    const terminal = host([]);
    const sandbox = createSessionSandbox(terminal.value, context, { root: () => dirs.project, home: dirs.home,
      seams: { engine: fakeEngine(), problem: () => undefined, platform, tempDirs: [], agentDir } });
    const shell = runtimeShell({ ...terminal.value, privateCommands: () => true }, sandbox, new SandboxStore(context.stateDirectory));
    const never = (shown: string) => `Not done: ${shown} is outside this project, and Casper doesn't let the AI write there.`;
    const settings = path.join(agentDir, "settings.json"), log = path.join(debug, "log.txt");
    // As without the project's denyRead: no write box offers them.
    expect(await shell.outsideWrite!(settings)).toBe(never(settings));
    expect(await shell.outsideWrite!(log)).toBe(never("~/.claude/debug/log.txt"));
    // The private box's yes doesn't open them either.
    expect(await shell.outsideWrite!(settings, { asked: true })).toBe(never(settings));
    expect(await shell.outsideWrite!(log, { asked: true })).toBe(never("~/.claude/debug/log.txt"));
    // Refused before the private box asks.
    expect(shell.privateWriteRefused!(settings)).toBe(never(settings));
    expect(shell.privateWriteRefused!(log)).toBe(never("~/.claude/debug/log.txt"));
    // A built-in private place (~/.ssh too, which commands may never write), and one only the project's denyRead names:
    // its yes was the one box.
    for (const file of [path.join(dirs.home, ".aws", "config"), path.join(dirs.home, ".ssh", "config")]) {
      expect(shell.privateWriteRefused!(file)).toBeUndefined();
      expect(await shell.outsideWrite!(file, { asked: true })).toBeUndefined();
    }
    expect(shell.privateWriteRefused!(path.join(onlyPrivate, "draft.txt"))).toBeUndefined();
    expect(await shell.outsideWrite!(path.join(onlyPrivate, "draft.txt"), { asked: true })).toBeUndefined();
    expect(terminal.asked).toEqual([]);
    await sandbox.close();
  }
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

posixOnly("private, protected, system and git places, ~ itself, reads and hosts never get the write box: the shell asks only to run the command outside (decision 94)", async () => {
  let refusal: string[] = [];
  const s = await session([], { refuse: () => refusal });
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
    expect(await s.shell.refused!(run.id!, "")).toEndWith(`${SANDBOX_REFUSED} ${OUTSIDE_RUN_DECLINED}`);
  }
  expect(s.terminal.asked).toHaveLength(6);
  expect(s.terminal.asked.every((box) => /^The sandbox blocked it \(wanted to .*\)\. Run this command outside the sandbox\?/.test(box.question))).toBe(true);
  s.terminal.asked.length = 0;
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
  expect(formatReceipt({ execution: "completed", ...receipt })).toContain(`– Wrote outside the project: ${FOLDER} (you allowed it; no undo copy)`);
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

test("a write inside an app bundle asks first, also when Casper started in the bundle and it is the project, and says it breaks the signature", async () => {
  // From a real v0.4.12 session: Casper started in /Applications/Iris.app, so the AI wrote a wrapper script into the
  // app as "the project", which broke its code signature.
  const s = await session(["No", "Yes, for this session"]);
  const app = path.join(s.project, "Iris.app");
  await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
  const script = path.join(app, "rea-hopper-wrapper.sh");
  const refused = await s.shell.bundleWrite!(script);
  expect(refused).toBe(`Not done: Iris.app/rea-hopper-wrapper.sh is inside Iris.app, and the user said no. ${BUNDLE_ELSEWHERE}`);
  expect(s.terminal.asked).toEqual([{
    question: "Write Iris.app/rea-hopper-wrapper.sh? Iris.app is an app bundle: adding or changing a file in it breaks the app's code signature, so macOS may refuse to open it.",
    options: ["No", "Yes, this once", "Yes, for this session"],
  }]);
  // Yes, for this session covers that app until you quit; another app asks again.
  expect(await s.shell.bundleWrite!(path.join(app, "Contents", "Info.plist"))).toBeUndefined();
  expect(await s.shell.bundleWrite!(script)).toBeUndefined();
  expect(s.terminal.asked).toHaveLength(2);
  // A folder that is only named like one (no Contents inside) is no bundle; neither is the rest of the project.
  await mkdir(path.join(s.project, "site.app"), { recursive: true });
  expect(await s.shell.bundleWrite!(path.join(s.project, "site.app", "index.html"))).toBeUndefined();
  expect(await s.shell.bundleWrite!(path.join(s.project, "notes.md"))).toBeUndefined();
  expect(s.terminal.asked).toHaveLength(2);
  await s.sandbox.close();
});

test("a run that can't ask never writes in an app bundle; /permissions all doesn't answer that box", async () => {
  const s = await session([], { canAsk: false });
  const app = path.join(s.home, "Applications", "Hopper Disassembler.app");
  await mkdir(path.join(app, "Contents"), { recursive: true });
  expect(await s.shell.bundleWrite!(path.join(app, "Contents", "x.sh"))).toBe(`Not done: ~/Applications/Hopper Disassembler.app/Contents/x.sh is inside Hopper Disassembler.app. ${BUNDLE_ELSEWHERE}`);
  await s.sandbox.close();
  const all = await session(["No"]);
  all.terminal.value.stopAsking = () => true;
  const own = path.join(all.project, "Tool.app");
  await mkdir(path.join(own, "Contents"), { recursive: true });
  expect(await all.shell.bundleWrite!(path.join(own, "x"))).toMatch(/^Not done: /);
  expect(all.terminal.asked).toHaveLength(1);
  await all.sandbox.close();
});
