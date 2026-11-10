import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionSandbox, planCommandDeclined, runtimeShell, SHELL_CANT_ASK, SHELL_DECLINED, type PickSettings, type SandboxHost } from "../src/app/sandbox";
import { posixOnly } from "./support/platform";
import { isOutside } from "../src/platform/inside";
import { PLANNING_BLOCKED, planToolGate, READ_ONLY_BLOCKED } from "../src/flows/plan";
import { loadConfiguration } from "../src/config/load";
import { settingRows } from "../src/app/settings";
import { fileToolGate, privateCommandPlace, privateDeclined, privateFilePlace, privatePlaces } from "../src/platform/project-paths";
import { CasperApp } from "../src/app";
import { sandboxHost } from "../src/app/wiring";
import { crewShell } from "../src/crew/shell";
import { crewBuilderHost } from "../src/app/commands";
import { currentShell } from "../src/app/runtime-start";
import { modeState, setAccessMode, type AccessHost } from "../src/acp/modes";
import { READ_ONLY_TYPED } from "../src/task/classify";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { SandboxStore } from "../src/sandbox/store";
import { fakeEngine } from "./support/sandbox-fakes";
import { removeTempDir } from "./support/temp-dir";

/**
 * Decision 95: while planning or Read only, a bash command that is not a look command asks "Run this command?" instead
 * of being refused (plan_commands); with the sandbox off, a command that names a private place asks too
 * (private_commands). Both on by default; off, or a run that can't ask, keeps today's refusal word for word.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-plan-private-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(home); await mkdir(project);
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  return { home, project, context };
}

type Blocked = ReturnType<NonNullable<SandboxHost["changesBlocked"]>>;

function host(answers: Array<string | undefined>, blocked: Blocked = undefined, extra: Partial<SandboxHost> = {}) {
  const asked: Array<{ question: string; options: string[]; settings?: PickSettings }> = [];
  const value: SandboxHost = {
    canAsk: () => true,
    pick: async (question, options, _signal, settings) => { asked.push({ question, options: options.map((option) => option.label), ...(settings ? { settings } : {}) }); return answers.shift(); },
    write: () => {},
    planning: () => blocked !== undefined,
    changesBlocked: () => blocked,
    routineCommands: () => true,
    ...extra,
  };
  return { value, asked };
}

/** No sandbox here (Windows' seam): the AI's shell asks before each command that is not a read or routine work. */
async function offShell(terminal: ReturnType<typeof host>) {
  const { home, project, context } = await fixture();
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  expect(sandbox.asksFirst).toBe(true);
  return { shell: runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory)), home, project, sandbox };
}

const PLAN = { reason: PLANNING_BLOCKED, readOnly: false, asks: true };
const READ_ONLY = { reason: READ_ONLY_BLOCKED, readOnly: true, asks: true };

test("while planning, a command that is not a look command asks first, No first and Enter is No; look commands don't ask", async () => {
  const terminal = host([undefined, "No"], PLAN);
  const { shell } = await offShell(terminal);
  expect(await shell.approve!("ls src")).toBeUndefined();
  // Routine work (npm test) asks too while planning: it would not in Build.
  expect(await shell.approve!("npm test")).toBe(planCommandDeclined(false));
  expect(await shell.approve!("npm test")).toBe("Not run: the user said no to this command while planning. Don't run it again; plan without it or ask the user.");
  expect(terminal.asked).toHaveLength(2);
  expect(terminal.asked[0]!.question).toBe("Run this command? You're planning, and it may change files before you choose Build.  npm test");
  expect(terminal.asked[0]!.options).toEqual(["No", "Yes, this once", "Yes, for this session"]);
});

test("while planning, Yes runs the command with no second box; Yes, for this session is not asked again", async () => {
  const terminal = host(["Yes, this once", "Yes, for this session"], PLAN);
  const { shell } = await offShell(terminal);
  expect(await shell.approve!("touch notes.txt")).toBeUndefined();
  expect(await shell.approve!("npm install left-pad")).toBeUndefined();
  expect(await shell.approve!("npm install left-pad")).toBeUndefined();
  expect(terminal.asked.map((entry) => entry.question)).toEqual([
    "Run this command? You're planning, and it may change files before you choose Build.  touch notes.txt",
    "Run this command? You're planning, and it may change files before you choose Build.  npm install left-pad",
  ]);
  // "Yes, this once" again for the first: it asks again.
  terminal.asked.length = 0;
  expect(await shell.approve!("touch notes.txt")).toBe(planCommandDeclined(false));
  expect(terminal.asked).toHaveLength(1);
});

test("while planning, /permissions all and the judge don't answer the box: plan and bypass are separate modes", async () => {
  let judged = 0;
  const terminal = host(["No"], PLAN, { stopAsking: () => true, judge: async () => { judged++; return { verdict: "allow", reason: "build work" }; } });
  const { shell } = await offShell(terminal);
  expect(await shell.approve!("rm -rf dist")).toBe(planCommandDeclined(false));
  expect(terminal.asked).toHaveLength(1);
  expect(judged).toBe(0);
});

test("plan_commands off, or nobody to answer: today's refusal, word for word, and no box", async () => {
  const terminal = host([], { ...PLAN, asks: false });
  const { shell } = await offShell(terminal);
  expect(await shell.approve!("npm test")).toBe(planToolGate("bash", { command: "npm test" })!);
  expect(await shell.approve!("npm test")).toBe("Not run: Planning only: Casper blocks file changes until you choose Build. While planning it runs only look commands such as ls, cat, grep and git log. npm is not one.");
  const readOnly = host([], { ...READ_ONLY, asks: false });
  const second = await offShell(readOnly);
  expect(await second.shell.approve!("touch x")).toBe(planToolGate("bash", { command: "touch x" }, undefined, READ_ONLY_BLOCKED)!);
  expect(terminal.asked).toEqual([]);
  expect(readOnly.asked).toEqual([]);
});

test("Read only: the box is let through while Read only, with No and Yes, this once only", async () => {
  const terminal = host(["Yes, this once", undefined], READ_ONLY);
  const { shell } = await offShell(terminal);
  expect(await shell.approve!("touch x")).toBeUndefined();
  expect(await shell.approve!("touch x")).toBe("Not run: the user said no to this command while Read only. Don't run it again; answer without it or ask the user.");
  expect(terminal.asked[0]!.question).toBe("Run this command? The app set Read only, and it may change files.  touch x");
  expect(terminal.asked[0]!.options).toEqual(["No", "Yes, this once"]);
  expect(terminal.asked[0]!.settings?.whileReadOnly).toBe(true);
});

/** A CasperApp's parts the shell's host reads, for sandboxHost. */
function appFor(parts: Record<string, unknown>) {
  const picked: Array<{ question: string; settings: unknown }> = [];
  const app = Object.assign(Object.create(CasperApp.prototype), {
    readOnlyAccess: false, planning: false, interactive: false, remoteApprovals: true, closing: false, approvalQueue: Promise.resolve(),
    output: { write() {} }, projectContext: {}, shell: { approve: async () => undefined },
    terminal: { canAsk: true, pick: async (question: string, _options: unknown, _signal: unknown, settings: unknown) => { picked.push({ question, settings }); return "Yes, this once"; } },
    ...parts,
  }) as CasperApp;
  return { app, picked };
}

test("an app's Read only with its plan option on: the Read only box is shown, not a No nobody gave", async () => {
  const { app, picked } = appFor({ readOnlyAccess: true, planning: true });
  const wired = sandboxHost(app);
  expect(wired.changesBlocked!()).toEqual({ reason: PLANNING_BLOCKED, readOnly: true, asks: true });
  const { home, project, context } = await fixture();
  const sandbox = createSessionSandbox(wired, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(wired, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("npm test")).toBeUndefined();
  expect(picked.map((entry) => entry.question)).toEqual(["Run this command? The app set Read only, and it may change files.  npm test"]);
  // Read only alone, and planning alone.
  expect(sandboxHost(appFor({ readOnlyAccess: true }).app).changesBlocked!()).toEqual({ reason: READ_ONLY_BLOCKED, readOnly: true, asks: true });
  expect(sandboxHost(appFor({ planning: true }).app).changesBlocked!()).toEqual({ reason: PLANNING_BLOCKED, readOnly: false, asks: true });
  // Read only: canAsk is false, the boxes decision 95 lets through can still be asked.
  expect([wired.canAsk(), wired.canAskWhileReadOnly!()]).toEqual([false, true]);
});

test("blockedCommandsAsk: only while someone can answer and the AI's shell asks, and plan_commands is not off", () => {
  const asks = (parts: Record<string, unknown>) => appFor({ planning: true, ...parts }).app.blockedCommandsAsk();
  expect(asks({})).toBe(true);
  expect(asks({ interactive: true, remoteApprovals: false })).toBe(true);
  // A one-shot or --json run: nobody answers.
  expect(asks({ interactive: false, remoteApprovals: false })).toBe(false);
  expect(asks({ terminal: { canAsk: false } })).toBe(false);
  expect(asks({ closing: true })).toBe(false);
  expect(asks({ shell: {} })).toBe(false);
  expect(asks({ shell: undefined })).toBe(false);
  expect(asks({ projectContext: { planCommands: false } })).toBe(false);
});

test("the conversation's shell and a builder's shell forward the private box: the session asks, under the builder's name", async () => {
  const { home, project, context } = await fixture();
  const terminal = host(["No"], undefined, { privateCommands: () => true });
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const main = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  const forwarded = currentShell({ shell: main, projectContext: {} } as unknown as CasperApp);
  expect(forwarded.asksPrivate!()).toBe(true);
  const place = privateCommandPlace("cat ~/.ssh/config", { root: project, home })!;
  expect(await forwarded.askPrivate!("cat ~/.ssh/config", place)).toBe(privateDeclined("~/.ssh", home));
  expect(terminal.asked).toHaveLength(1);
  // No shell: refused as before.
  const none = currentShell({ projectContext: {} } as unknown as CasperApp);
  expect(none.asksPrivate!()).toBe(false);
  expect(await none.askPrivate!("cat ~/.ssh/config", place)).toBe(place.refusal);
  // A builder: the same box, named for it.
  const builder = crewShell(sandbox, project, () => {}, { host: terminal.value, label: "Builder 2" })!;
  expect(builder.asksPrivate!()).toBe(true);
  terminal.asked.length = 0;
  expect(await builder.askPrivate!("cat ~/.ssh/config", place)).toBe(privateDeclined("~/.ssh", home));
  expect(terminal.asked[0]!.question).toBe("Builder 2: Run this command? It uses ~/.ssh, which is private (keys and logins).  cat ~/.ssh/config");
  await builder.close();
  await sandbox.close();
});

test("/crew's builder asks the private box in your box under its name; private_commands off keeps the refusal", async () => {
  const { home, project, context } = await fixture();
  const picked: string[] = [];
  const commandHost = (privateCommands?: boolean, app: { interactive: boolean; remoteApprovals?: boolean } = { interactive: true }) => crewBuilderHost({ ...app, closing: false, stopAsking: false, output: { write() {} },
    projectContext: { ...context, ...(privateCommands === undefined ? {} : { privateCommands }) },
    terminal: { canAsk: true, pick: async (question: string) => { picked.push(question); return "No"; } } } as unknown as Parameters<typeof crewBuilderHost>[0]);
  const session = host([]);
  const sandbox = createSessionSandbox(session.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const builder = crewShell(sandbox, project, () => {}, { host: commandHost(), label: "Builder 1" })!;
  expect(builder.asksPrivate!()).toBe(true);
  const place = privateCommandPlace("cat ~/.ssh/config", { root: project, home })!;
  expect(await builder.askPrivate!("cat ~/.ssh/config", place)).toBe(privateDeclined("~/.ssh", home));
  expect(picked).toEqual(["Builder 1: Run this command? It uses ~/.ssh, which is private (keys and logins).  cat ~/.ssh/config"]);
  // Over casper acp the app answers (remoteApprovals), as the delegate tool's builders ask there (sandboxHost).
  const acp = crewShell(sandbox, project, () => {}, { host: commandHost(undefined, { interactive: false, remoteApprovals: true }), label: "Builder 1" })!;
  expect([acp.asksPrivate!(), acp.asksPrivateFile!()]).toEqual([true, true]);
  expect(await acp.askPrivate!("cat ~/.ssh/config", place)).toBe(privateDeclined("~/.ssh", home));
  expect(picked).toHaveLength(2);
  // Nobody to answer (a plain run without a terminal): refused as before.
  const nobody = crewShell(sandbox, project, () => {}, { host: commandHost(undefined, { interactive: false }), label: "Builder 1" })!;
  expect(nobody.asksPrivate!()).toBe(false);
  const off = crewShell(sandbox, project, () => {}, { host: commandHost(false), label: "Builder 1" })!;
  expect(off.asksPrivate!()).toBe(false);
  expect(await off.askPrivate!("cat ~/.ssh/config", place)).toBe(place.refusal);
  expect(picked).toHaveLength(2);
  await builder.close(); await off.close(); await acp.close(); await nobody.close();
  await sandbox.close();
});

test("/crew's builder under an app's Read only: its command box isn't shown and the command is refused, as before decision 95", async () => {
  const { home, project, context } = await fixture();
  const picked: string[] = [];
  const builderHost = crewBuilderHost({ interactive: false, remoteApprovals: true, readOnlyAccess: true, closing: false, stopAsking: false, output: { write() {} },
    projectContext: context, terminal: { canAsk: true, pick: async (question: string) => { picked.push(question); return "Yes, this once"; } } } as unknown as Parameters<typeof crewBuilderHost>[0]);
  const session = host([]);
  const sandbox = createSessionSandbox(session.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  expect(sandbox.asksFirst).toBe(true);
  const builder = crewShell(sandbox, project, () => {}, { host: builderHost, label: "Builder 1" })!;
  expect(await builder.approve!("npm install left-pad")).toBe(SHELL_CANT_ASK);
  // Its private-place box is refused too, and a box that isn't one Read only lets through never reaches the app.
  const place = privateCommandPlace("cat ~/.ssh/config", { root: project, home })!;
  expect(await builder.askPrivate!("cat ~/.ssh/config", place)).toBe(place.refusal);
  expect(await builderHost.pick("Write ~/elsewhere/file.txt?", [{ label: "No" }, { label: "Yes, this once" }])).toBeUndefined();
  expect(picked).toEqual([]);
  // The boxes Read only lets through (decision 95), and the one to run a blocked command outside (decision 94), still ask.
  expect(await builderHost.pick("Run this command outside the sandbox?", [{ label: "No" }, { label: "Yes, this once" }], undefined, { anyAccess: true })).toBe("Yes, this once");
  expect(await builderHost.pick("Run this command? The app set Read only.", [{ label: "No" }, { label: "Yes, this once" }], undefined, { whileReadOnly: true })).toBe("Yes, this once");
  expect(picked).toHaveLength(2);
  await builder.close();
  await sandbox.close();
});

test("with the sandbox on, a command you said yes to while planning gets the project as Build does; look commands keep it read-only", async () => {
  const { home, project, context } = await fixture();
  const engine = fakeEngine();
  const terminal = host(["Yes, this once"], PLAN);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(sandbox.on).toBe(true);
  expect(await shell.approve!("git diff")).toBeUndefined();
  await shell.wrap("git diff", project);
  expect(await shell.approve!("npm run build")).toBeUndefined();
  await shell.wrap("npm run build", project);
  // The yes is for that one run: the same command again, unasked, is read-only.
  await shell.wrap("npm run build", project);
  expect(terminal.asked).toHaveLength(1);
  expect(engine.wrapped.map((entry) => entry.policy.allowWrite.includes(project))).toEqual([false, true, false]);
  await sandbox.close();
});

test("Read only, sandbox on: a command you said yes to asks its new host as Build would, in a box Read only lets through", async () => {
  const { home, project, context } = await fixture();
  const engine = fakeEngine();
  // Read only: canAsk is false (decision 82); only the boxes decision 95 names are asked.
  const terminal = host(["Yes, this once", "Yes, this once"], READ_ONLY, { canAsk: () => false, canAskWhileReadOnly: () => true });
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("npm install left-pad")).toBeUndefined();
  const run = await shell.wrap("npm install left-pad", project);
  expect(await engine.ask!("registry.npmjs.org", 443)).toBe(true);
  expect(terminal.asked.map((entry) => [entry.question.split("  ")[0], entry.settings?.whileReadOnly])).toEqual([
    ["Run this command? The app set Read only, and it may change files.", true], ["A shell command wants to reach registry.npmjs.org. Allow it?", true]]);
  shell.finished!(run.id!);
  // Once it ended, a look command's host is not asked: Read only asks nothing else.
  await shell.wrap("git log", project);
  expect(await engine.ask!("example.com", 443)).toBe(false);
  expect(terminal.asked).toHaveLength(2);
  await sandbox.close();
});

posixOnly("Read only, sandbox on: a write outside the project by a command you said yes to asks as Build would", async () => {
  const { home, project, context } = await fixture();
  const cache = path.join(home, "cache");
  await mkdir(cache);
  const engine = fakeEngine((command) => command.startsWith("npm") ? [`deny(1) file-write-create ${path.join(cache, "index.json")}`] : []);
  const terminal = host(["Yes, this once", "No"], READ_ONLY, { canAsk: () => false, canAskWhileReadOnly: () => true });
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("npm install left-pad")).toBeUndefined();
  const run = await shell.wrap("npm install left-pad", project);
  expect(await shell.refused!(run.id!, "")).toContain("The user said no to writing ~/cache");
  expect(terminal.asked.map((entry) => entry.settings?.whileReadOnly)).toEqual([true, true]);
  expect(terminal.asked[1]!.question).toContain("~/cache");
  await sandbox.close();
});

test("Read only, sandbox off: a look command that reads outside the project asks in a box Read only lets through, not 'this run can't ask'", async () => {
  const terminal = host(["Yes, this once", "No"], READ_ONLY, { canAsk: () => false, canAskWhileReadOnly: () => true, homeReads: () => true });
  const { shell } = await offShell(terminal);
  expect(await shell.approve!("cat /etc/hosts")).toBeUndefined();
  expect(await shell.approve!("grep -r foo /usr/share")).toBe(SHELL_DECLINED);
  expect(terminal.asked.map((entry) => [entry.question, entry.settings?.whileReadOnly])).toEqual([
    ["Run this command?  cat /etc/hosts", true], ["Run this command?  grep -r foo /usr/share", true]]);
  // Read only is not Don't ask: Yes to everything is not offered.
  expect(terminal.asked[0]!.options).toEqual(["No", "Yes, this once", "Yes, for this session"]);
  // Nobody to answer at all: refused for want of a box, as before.
  const quiet = host([], READ_ONLY, { canAsk: () => false, canAskWhileReadOnly: () => false });
  const off = await offShell(quiet);
  expect(await off.shell.approve!("cat /etc/hosts")).toBe(SHELL_CANT_ASK);
});

test("while planning, a command that names a private place and is not a look command asks once: the private box's yes counts", async () => {
  const terminal = host(["Yes, this once"], PLAN, { privateCommands: () => true, routineCommands: () => false });
  const { shell, home, project } = await offShell(terminal);
  const command = "tar czf /tmp/aws.tgz ~/.aws";
  expect(await shell.askPrivate!(command, privateCommandPlace(command, { root: project, home })!)).toBeUndefined();
  expect(await shell.approve!(command)).toBeUndefined();
  expect(terminal.asked.map((entry) => entry.question)).toEqual(["Run this command? It uses ~/.aws, which is private (keys and logins).  tar czf /tmp/aws.tgz ~/.aws"]);
  // Without that yes the planning box asks.
  expect(await shell.approve!(command)).toBe(planCommandDeclined(false));
  expect(terminal.asked).toHaveLength(2);
});

test("with the sandbox off, a command that names a private place asks first, naming it; No gives the machines for ~/.ssh", async () => {
  const terminal = host([undefined, "No"], undefined, { privateCommands: () => true });
  const { shell, home, project } = await offShell(terminal);
  expect(shell.asksPrivate!()).toBe(true);
  const place = privateCommandPlace("cat ~/.ssh/config", { root: project, home })!;
  expect(place.shown).toBe("~/.ssh");
  expect(await shell.askPrivate!("cat ~/.ssh/config", place)).toBe(privateDeclined("~/.ssh", home));
  expect(await shell.askPrivate!("cat ~/.ssh/config", place)).toStartWith("Not run: the user said no to reading ~/.ssh.");
  expect(privateDeclined("~/.aws", home)).toBe("Not run: the user said no to reading ~/.aws. Don't try it another way; ask the user instead.");
  expect(terminal.asked[0]!.question).toBe("Run this command? It uses ~/.ssh, which is private (keys and logins).  cat ~/.ssh/config");
  expect(terminal.asked[0]!.options).toEqual(["No", "Yes, this once", "Yes, for this session"]);
});

test("a yes to a private place runs it with no second Run this command? box; for this session it is not asked again", async () => {
  // No /permissions all, no judge and no routine commands: the shell box would ask, were the private yes not counted.
  const terminal = host(["Yes, this once", "Yes, for this session"], undefined, { privateCommands: () => true, routineCommands: () => false });
  const { shell, home, project } = await offShell(terminal);
  const command = "tar czf /tmp/aws.tgz ~/.aws";
  const place = privateCommandPlace(command, { root: project, home })!;
  expect(await shell.askPrivate!(command, place)).toBeUndefined();
  expect(terminal.asked).toHaveLength(1);
  expect(await shell.approve!(command)).toBeUndefined();
  expect(terminal.asked).toHaveLength(1);
  expect(await shell.askPrivate!(command, place)).toBeUndefined();
  expect(await shell.approve!(command)).toBeUndefined();
  expect(await shell.askPrivate!(command, place)).toBeUndefined();
  expect(terminal.asked).toHaveLength(2);
  // Without the private box's yes the same command gets the shell's own box.
  const other = host(["No"], undefined, { privateCommands: () => true, routineCommands: () => false });
  const plain = await offShell(other);
  expect(await plain.shell.approve!(command)).toBe("Not run: the user said no to this command. Don't run it again; ask the user what to do instead.");
  expect(other.asked[0]!.question).toStartWith("Run this command?  tar czf");
});

test("/permissions all and the judge don't answer the private box", async () => {
  let judged = 0;
  const terminal = host(["No"], undefined,
    { privateCommands: () => true, stopAsking: () => true, judge: async () => { judged++; return { verdict: "allow", reason: "a read" }; } });
  const { shell, home, project } = await offShell(terminal);
  const command = "grep -i hostname ~/.aws/config";
  expect(await shell.askPrivate!(command, privateCommandPlace(command, { root: project, home })!)).toBe(privateDeclined("~/.aws", home));
  expect(terminal.asked).toHaveLength(1);
  expect(judged).toBe(0);
});

test("the AI's read, grep, find, ls, lsp, edit or write into a private place asks in its own words; No says so; off or nobody to answer keeps fileToolGate's refusal", async () => {
  const terminal = host([undefined, "Yes, for this session"], undefined, { privateCommands: () => true });
  const { shell, home, project } = await offShell(terminal);
  const context = { root: project, home };
  const place = privateFilePlace("read", { path: "~/.ssh/config" }, context)!;
  expect(place.refusal).toBe(fileToolGate("read", { path: "~/.ssh/config" }, context)!);
  expect(place.question).toBe("Read ~/.ssh/config? ~/.ssh is private (keys and logins).");
  expect(await shell.askPrivate!(place.key!, place)).toBe("Not read: the user said no to reading ~/.ssh/config. Don't try it another way; ask the user instead.");
  expect(terminal.asked[0]!.question).toBe("Read ~/.ssh/config? ~/.ssh is private (keys and logins).");
  expect(terminal.asked[0]!.options).toEqual(["No", "Yes, this once", "Yes, for this session"]);
  expect(await shell.askPrivate!(place.key!, place)).toBeUndefined();
  expect(await shell.askPrivate!(place.key!, place)).toBeUndefined();
  expect(terminal.asked).toHaveLength(2);
  // grep over home holds ~/.ssh and every other private place: the box names them all, since a yes opens them all;
  // ls and find name what they do.
  const below = privateFilePlace("grep", { path: "~", pattern: "x" }, context)!;
  // Counted from the list: a login file elsewhere (the run's GitHub CLI folder) is not under this home.
  const others = privatePlaces(context).filter((entry) => entry.below && !isOutside(path.relative(home, entry.paths[0]!))).length - 3;
  expect(others).toBeGreaterThan(10);
  expect(below.question).toBe(`Search ~? It holds ~/.ssh, ~/.aws, ~/.gnupg and ${others} other private places (keys and logins; Casper's own records).`);
  expect(below.declined).toBe(`Not searched: the user said no to searching ~, which holds ~/.ssh, ~/.aws, ~/.gnupg and ${others} other private places. Search a narrower folder or ask the user.`);
  expect(below.refusal).toBe(fileToolGate("grep", { path: "~", pattern: "x" }, context)!);
  const config = privateFilePlace("find", { path: "~/.config", pattern: "*" }, context)!;
  expect(config.question).toBe("Search ~/.config? It holds ~/.config/gh, ~/.config/gcloud and ~/.config/hub, which are private (keys and logins).");
  expect(config.declined).toBe("Not searched: the user said no to searching ~/.config, which holds ~/.config/gh, ~/.config/gcloud and ~/.config/hub. Search a narrower folder or ask the user.");
  expect(privateFilePlace("grep", { path: "~/.casper/agent", pattern: "x" }, context)!.question).toMatch(/^Search ~\/\.casper\/agent\? It holds ~\/\.casper\/agent\/auth\.json, ~\/\.casper\/agent\/sessions and ~\/\.casper\/agent\/models\.json, which are private \(keys and logins; Casper's own records\)\.$/);
  expect(privateFilePlace("ls", { path: "~/.aws" }, context)!.question).toBe("List ~/.aws? ~/.aws is private (keys and logins).");
  // An edit or write asks to change the file (one session yes covers both); lsp asks to read it.
  const change = privateFilePlace("write", { path: "~/.aws/config", content: "x" }, context)!;
  expect([change.question, change.key, change.refusal]).toEqual(["Change ~/.aws/config? ~/.aws is private (keys and logins).", "change ~/.aws/config",
    fileToolGate("write", { path: "~/.aws/config", content: "x" }, context)]);
  expect(privateFilePlace("edit", { path: "~/.aws/config" }, context)!.key).toBe("change ~/.aws/config");
  expect(privateFilePlace("edit", { path: "~/.aws/config" }, context)!.declined).toBe("Not done: the user said no to changing ~/.aws/config. Don't try it another way; ask the user instead.");
  // lsp asks only inside the project: outside it the LSP layer refuses the call anyway, so only the refusal.
  const denied = { ...context, denyRead: [path.join(project, "secret")] };
  expect(privateFilePlace("lsp", { path: "secret/a.ts" }, denied)!.question).toBe("Read secret/a.ts? secret is private (this project's sandbox.denyRead).");
  expect(privateFilePlace("lsp", { path: "~/.ssh/config" }, context)).toBeUndefined();
  expect(fileToolGate("lsp", { path: "~/.ssh/config" }, context)).toBe("Not read: ~/.ssh is private (keys and logins). Casper keeps it from the AI.");
  // ~/.ssh asks for an edit or write too, as the shell's write there does; ~/.casper's records and git's own files stay
  // refused, in today's words.
  const ssh = privateFilePlace("write", { path: "~/.ssh/config", content: "x" }, context)!;
  expect([ssh.question, ssh.key, ssh.refusal]).toEqual(["Change ~/.ssh/config? ~/.ssh is private (keys and logins).", "change ~/.ssh/config",
    "Not done: ~/.ssh is private (keys and logins). Casper keeps it from the AI."]);
  expect(privateFilePlace("edit", { path: "~/.ssh/authorized_keys" }, context)!.question).toBe("Change ~/.ssh/authorized_keys? ~/.ssh is private (keys and logins).");
  expect(privateFilePlace("edit", { path: "~/.casper/projects/x" }, context)).toBeUndefined();
  expect(fileToolGate("edit", { path: "~/.casper/projects/x" }, context)).toBe("Not done: ~/.casper/projects is private (Casper's own records). Casper keeps it from the AI.");
  // Off, or nobody to answer: the refusal, word for word.
  for (const extra of [{ privateCommands: () => false }, { privateCommands: () => true, canAsk: () => false }] as Array<Partial<SandboxHost>>) {
    const quiet = host([], undefined, extra);
    const off = await offShell(quiet);
    const again = privateFilePlace("read", { path: "~/.aws/credentials" }, { root: off.project, home: off.home })!;
    expect(await off.shell.askPrivate!(again.key!, again)).toBe(again.refusal);
    expect(quiet.asked).toEqual([]);
  }
});

test("Read only: a command or read naming a private place asks in the box Read only lets through, and a machine a yes reaches asks too", async () => {
  // Read only: canAsk is false (decision 82), only the boxes decision 95 names are asked, with whileReadOnly.
  const terminal = host([undefined, "Yes, this once", "Yes, this once", "Yes, this once"], READ_ONLY,
    { canAsk: () => false, canAskWhileReadOnly: () => true, privateCommands: () => true });
  const { shell, home, project } = await offShell(terminal);
  expect(shell.asksPrivate!()).toBe(true);
  const command = "grep Host ~/.ssh/config";
  expect(await shell.askPrivate!(command, privateCommandPlace(command, { root: project, home })!)).toBe(privateDeclined("~/.ssh", home));
  expect(terminal.asked[0]!.settings?.whileReadOnly).toBe(true);
  const read = privateFilePlace("read", { path: "~/.aws/config" }, { root: project, home })!;
  expect(await shell.askPrivate!(read.key!, read)).toBeUndefined();
  expect(terminal.asked[1]!.settings?.whileReadOnly).toBe(true);
  // A command that is not a look command and reaches another machine: the Read only box, then its Reach box.
  expect(await shell.approve!("ssh router 'show version'")).toBeUndefined();
  expect(terminal.asked.slice(2).map((entry) => [entry.question.split("  ")[0]!.split("\n")[0], entry.settings?.whileReadOnly])).toEqual([
    ["Run this command? The app set Read only, and it may change files.", true], ["Reach router?", true]]);
  // Nobody to answer at all: refused as before, no box.
  const quiet = host([], READ_ONLY, { canAsk: () => false, canAskWhileReadOnly: () => false, privateCommands: () => true });
  const off = await offShell(quiet);
  expect(off.shell.asksPrivate!()).toBe(false);
  expect(quiet.asked).toEqual([]);
});

test("private_commands off, nobody to answer, or the sandbox on: today's refusal, and no box", async () => {
  for (const extra of [{ privateCommands: () => false }, { privateCommands: () => true, canAsk: () => false }, {}] as Array<Partial<SandboxHost>>) {
    const terminal = host([], undefined, extra);
    const { shell, home, project } = await offShell(terminal);
    const place = privateCommandPlace("cat ~/.netrc", { root: project, home })!;
    expect(shell.asksPrivate!()).toBe(false);
    expect(await shell.askPrivate!("cat ~/.netrc", place)).toBe(place.refusal);
    expect(place.refusal).toBe("Not run: this command reads ~/.netrc, which is private (keys and logins). Casper keeps it from the AI. Ask the user instead.");
    expect(terminal.asked).toEqual([]);
  }
  const { home, project, context } = await fixture();
  const terminal = host([], undefined, { privateCommands: () => true });
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(sandbox.on).toBe(true);
  expect(shell.asksPrivate!()).toBe(false);
  await sandbox.close();
});

test("with the sandbox on, the AI's file tools still ask in the private box: they run in Casper's own process, not the sandbox", async () => {
  const { home, project, context } = await fixture();
  const terminal = host(["No", "Yes, this once"], undefined, { privateCommands: () => true });
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(sandbox.on).toBe(true);
  expect([shell.asksPrivate!(), shell.asksPrivateFile!()]).toEqual([false, true]);
  const read = privateFilePlace("read", { path: "~/.ssh/config" }, { root: project, home })!;
  expect(await shell.askPrivate!(read.key!, read)).toBe("Not read: the user said no to reading ~/.ssh/config. Don't try it another way; ask the user instead.");
  expect(await shell.askPrivate!(read.key!, read)).toBeUndefined();
  expect(terminal.asked.map((entry) => entry.question)).toEqual(["Read ~/.ssh/config? ~/.ssh is private (keys and logins).", "Read ~/.ssh/config? ~/.ssh is private (keys and logins)."]);
  // A command naming one is still the sandbox's: refused, no box.
  const command = privateCommandPlace("cat ~/.ssh/config", { root: project, home })!;
  expect(await shell.askPrivate!("cat ~/.ssh/config", command)).toBe(command.refusal);
  expect(terminal.asked).toHaveLength(2);
  // Off, or nobody to answer: fileToolGate's refusal.
  for (const extra of [{ privateCommands: () => false }, { privateCommands: () => true, canAsk: () => false }] as Array<Partial<SandboxHost>>) {
    const quiet = host([], undefined, extra);
    const off = runtimeShell(quiet.value, sandbox, new SandboxStore(context.stateDirectory));
    expect(off.asksPrivateFile!()).toBe(false);
    expect(await off.askPrivate!(read.key!, read)).toBe(read.refusal);
    expect(quiet.asked).toEqual([]);
  }
  await sandbox.close();
});

test("while planning, only the bash reading makes a look command: PowerShell-only reads (gc, gci, sls, dir --color) ask the planning box", async () => {
  const terminal = host(["No", "No", "No", "No", "No", "No"], PLAN, { stopAsking: () => true });
  const { shell } = await offShell(terminal);
  for (const command of ["gc -am wip", "gci", "sls foo", "dir --color", "test-path x", "get-item x"]) {
    expect(await shell.approve!(command)).toBe(planCommandDeclined(false));
  }
  expect(terminal.asked.map((entry) => entry.question.split("  ")[0])).toEqual(Array(6).fill("Run this command? You're planning, and it may change files before you choose Build."));
});

test("plan_commands and private_commands are your own settings: on unless your config turns them off, never in a project file", async () => {
  const { home, project } = await fixture();
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
  expect(await load()).not.toHaveProperty("planCommands");
  expect(await load()).not.toHaveProperty("privateCommands");
  await writeFile(path.join(home, ".casper", "config.yaml"), "plan_commands: off\nprivate_commands: false\n");
  expect(await load()).toMatchObject({ planCommands: false, privateCommands: false });
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  expect(context).toMatchObject({ planCommands: false, privateCommands: false });
  const rows = settingRows(context);
  for (const [label, key] of [["Commands while planning", "plan_commands"], ["Commands that read private places", "private_commands"]] as const) {
    const row = rows.find((entry) => entry.label === label)!;
    expect([row.value, row.choices.map((choice) => [choice.label, choice.keys, choice.value])]).toEqual(["off", [["Turn them on", [key], true]]]);
  }
  await writeFile(path.join(project, ".casper", "project.yaml"), "plan_commands: on\n");
  await expect(load()).rejects.toThrow("plan_commands is a user setting (~/.casper/config.yaml); a project cannot change which commands run while planning");
  await writeFile(path.join(project, ".casper", "project.yaml"), "private_commands: on\n");
  await expect(load()).rejects.toThrow("private_commands is a user setting (~/.casper/config.yaml); a project cannot let commands read your private places");
});

test("Read only's words follow plan_commands: a command asks while it is on, and is refused with it off", () => {
  const words = (planCommands?: boolean) => {
    const lines: string[] = [];
    const app = { readOnlyAccess: false, stopAsking: false, projectContext: planCommands === undefined ? {} : { planCommands } } as unknown as AccessHost;
    setAccessMode(app, "read", (line) => lines.push(line));
    const read = (modeState(app, (text) => text) as { availableModes: Array<{ id: string; description: string }> }).availableModes.find((mode) => mode.id === "read")!;
    return [read.description, lines.join("")];
  };
  expect(words()).toEqual(["Casper looks and answers. It blocks edits and other changes it can see; reads, look commands and MCP reads run, and another command asks first.",
    "[permissions] The app set Read only: Casper looks and answers, blocks edits, and asks before a command that may change files.\n"]);
  expect(words(false)).toEqual(["Casper looks and answers. It blocks every change it can see: only reads, look commands and MCP reads run.",
    "[permissions] The app set Read only: Casper looks and answers, and blocks every change it can see.\n"]);
  // What the model reads in Read only holds either way.
  expect(READ_ONLY_TYPED).toBe("Read only (the person's app set it): Casper refuses every edit and write, and asks first or refuses a changing command. Look and answer; say what you would change.");
});
