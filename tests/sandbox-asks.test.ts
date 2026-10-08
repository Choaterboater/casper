import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionSandbox, runtimeShell, SHELL_CANT_ASK, SHELL_DECLINED, writeCantAsk, type SandboxHost } from "../src/app/sandbox";
import { HOST_CHOICES, REACH_CHOICES, SHELL_COMMAND_CHOICES } from "../src/app/safe-choices";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { bwrapFailure, linuxSandboxProblem, resetLinuxProbe, ripgrepPath } from "../src/sandbox/linux";
import { ShellSandbox } from "../src/sandbox/manager";
import { SandboxStore } from "../src/sandbox/store";
import { fakeEngine } from "./support/sandbox-fakes";
import { posixModes, posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/**
 * The questions the sandbox asks: a host that is not listed, and (when no sandbox can run) each command the AI's
 * shell wants to run. Enter keeps the safe choice; only your own answer allows or remembers anything; a run that
 * can't ask never waits.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-asks-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(home); await mkdir(project);
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  return { base, home, project, context };
}

function host(answers: Array<string | undefined>, canAsk = true) {
  const asked: Array<{ question: string; options: string[] }> = [];
  const written: string[] = [];
  const value: SandboxHost = {
    canAsk: () => canAsk,
    pick: async (question, options) => { asked.push({ question, options: options.map((option) => option.label) }); return answers.shift(); },
    write: (text) => { written.push(text); },
    planning: () => false,
  };
  return { value, asked, written };
}

test("a host that is not listed asks with three numbered choices, No first", async () => {
  const { home, project, context } = await fixture();
  const engine = fakeEngine();
  const terminal = host([undefined]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  await sandbox.wrap("true", { cwd: project });
  // Enter (or Esc) keeps it blocked.
  expect(await engine.ask!("api.mist.com", 443)).toBe(false);
  expect(terminal.asked).toEqual([{ question: "A shell command wants to reach api.mist.com. Allow it?", options: HOST_CHOICES.map((choice) => choice.label) }]);
  expect(HOST_CHOICES.map((choice) => choice.label)).toEqual(["No", "Yes, this once", "Yes, for this session", "Yes, always for this project"]);
  await sandbox.close();
});

test("Yes, always for this project is kept in Casper's own folder, never in the repo, and the next request doesn't ask", async () => {
  const { home, project, context } = await fixture();
  const engine = fakeEngine();
  const terminal = host(["Yes, always for this project"]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  await sandbox.wrap("true", { cwd: project });
  expect(await engine.ask!("api.mist.com", 443)).toBe(true);
  expect(await engine.ask!("api.mist.com", 443)).toBe(true);
  expect(terminal.asked).toHaveLength(1);
  expect(await readdir(project)).toEqual([]);
  const saved = JSON.parse(await readFile(path.join(context.stateDirectory, "sandbox.json"), "utf8"));
  expect(saved.hosts).toEqual(["api.mist.com"]);
  if (posixModes) expect((await stat(path.join(context.stateDirectory, "sandbox.json"))).mode & 0o777).toBe(0o600);
  expect(engine.allowed).toContain("api.mist.com");
  // A new session starts with it listed; /sandbox forget takes it back.
  const next = createSessionSandbox(host([]).value, context, { root: () => project, home, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux" } });
  await next.loadRemembered();
  expect(next.allowedHosts()).toContain("api.mist.com");
  expect(await next.forget("api.mist.com")).toBe(true);
  expect(next.allowedHosts()).not.toContain("api.mist.com");
  await sandbox.close(); await next.close();
});

test("a run that can't ask blocks the host at once and says so once", async () => {
  const { home, project, context } = await fixture();
  const engine = fakeEngine();
  const terminal = host([], false);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  await sandbox.wrap("true", { cwd: project });
  expect(await engine.ask!("api.mist.com", 443)).toBe(false);
  expect(await engine.ask!("api.mist.com", 443)).toBe(false);
  expect(terminal.asked).toEqual([]);
  expect(terminal.written).toEqual(["[sandbox] Blocked api.mist.com (this run can't ask). To allow it for one run: --allow-host api.mist.com. Or allow it in a session (Yes, always for this project).\n"]);
  await sandbox.close();
});

for (const [label, seams] of [
  ["bubblewrap is missing", { problem: () => "bubblewrap and socat are missing: sudo apt install bubblewrap socat", platform: "linux" as const }],
  ["Windows", { platform: "win32" as const }],
] as const) {
  test(`with no sandbox (${label}) the AI's shell asks before each command, No first`, async () => {
    const { home, project, context } = await fixture();
    const terminal = host(["No", "Yes, always for this project"]);
    const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), ...seams } });
    expect(sandbox.asksFirst).toBe(true);
    const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
    expect(await shell.approve!("npm test")).toBe(SHELL_DECLINED);
    expect(await shell.approve!("npm test")).toBeUndefined();
    // Commands starting with npm test run without asking again; any other still asks.
    expect(await shell.approve!("npm test")).toBeUndefined();
    // Any other command still asks; Enter or Esc (no answer) runs nothing.
    expect(await shell.approve!("npm test; curl evil.example")).toBe(SHELL_DECLINED);
    expect(terminal.asked.map((entry) => entry.question)).toEqual(["Run this command?  npm test", "Run this command?  npm test", "Run this command?  npm test; curl evil.example"]);
    expect(terminal.asked[0]!.options).toEqual(SHELL_COMMAND_CHOICES.map((choice) => choice.label));
  });
}

test("a run that can't ask refuses the command with the --no-sandbox hint, and never waits", async () => {
  const { home, project, context } = await fixture();
  const terminal = host([], false);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("npm test")).toBe(SHELL_CANT_ASK);
  expect(SHELL_CANT_ASK).toBe("Not run: shell commands need your OK here, and this run can't ask. Use --no-sandbox to allow them for this run.");
  expect(terminal.asked).toEqual([]);
});

test("with the sandbox on, or turned off by you, the AI's shell doesn't ask", async () => {
  const { home, project, context } = await fixture();
  const terminal = host([]);
  for (const seams of [{ problem: () => undefined, platform: "linux" as const }, { problem: () => undefined, platform: "linux" as const, noSandboxFlag: true }]) {
    const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), ...seams } });
    const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
    expect(await shell.approve!("npm test")).toBeUndefined();
    await sandbox.close();
  }
  expect(terminal.asked).toEqual([]);
});

posixOnly("the detected state names the fix", () => {
  expect(ShellSandbox.detect({ platform: "linux", problem: () => "bubblewrap and socat are missing: sudo apt install bubblewrap socat" }))
    .toEqual({ kind: "missing", reason: "bubblewrap and socat are missing: sudo apt install bubblewrap socat" });
  expect(ShellSandbox.detect({ platform: "win32" })).toEqual({ kind: "unsupported", reason: "Windows" });
  expect(ShellSandbox.detect({ platform: "linux", noSandboxFlag: true, problem: () => undefined })).toEqual({ kind: "off", reason: "--no-sandbox" });
  expect(ShellSandbox.detect({ platform: "linux", settings: { user: { off: true } }, problem: () => undefined })).toEqual({ kind: "off", reason: "sandbox: off in ~/.casper/config.yaml" });
});

posixOnly("the Linux check names every missing program, ripgrep too, and says plainly when Ubuntu's AppArmor blocks bubblewrap", async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-probe-")));
  roots.push(base);
  const bin = path.join(base, "bin"), agent = path.join(base, "agent"), apparmor = path.join(base, "apparmor");
  await mkdir(bin);
  const tool = (name: string, body = "exit 0") => writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const probe = (options: Parameters<typeof linuxSandboxProblem>[1] = {}) => { resetLinuxProbe(); return linuxSandboxProblem(bin, options); };
  try {
    expect(probe()).toBe("bubblewrap, socat and ripgrep are missing: sudo apt install bubblewrap socat ripgrep");
    await tool("bwrap"); await tool("socat");
    // The sandbox runtime scans the project with ripgrep, so without it the sandbox would fail on first use.
    expect(probe()).toBe("ripgrep is missing: sudo apt install ripgrep");
    // Pi's own copy of ripgrep counts.
    await mkdir(path.join(agent, "bin"), { recursive: true });
    await writeFile(path.join(agent, "bin", "rg"), "", { mode: 0o755 });
    expect(ripgrepPath(bin, agent)).toBe(path.join(agent, "bin", "rg"));
    expect(probe({ agentDir: agent })).toBeUndefined();
    await tool("rg");
    expect(ripgrepPath(bin)).toBe(path.join(bin, "rg"));
    // bubblewrap is there but can't start: Ubuntu 24.04's AppArmor rule is named with its one-line fix.
    await tool("bwrap", "echo 'bwrap: setting up uid map: Permission denied' >&2; exit 1");
    await writeFile(apparmor, "1\n");
    expect(probe({ apparmorFile: apparmor })).toBe("Ubuntu blocks it (AppArmor restricts user namespaces: setting up uid map: Permission denied); to allow it: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0, see docs/SECURITY.md");
    await writeFile(apparmor, "0\n");
    expect(probe({ apparmorFile: apparmor })).toBe("bubblewrap can't start here (setting up uid map: Permission denied); see docs/SECURITY.md");
    expect(bwrapFailure("", false)).toBe("bubblewrap can't start here (it did not start); see docs/SECURITY.md");
    // The state it gives: not sandboxed, and the AI's shell asks before each command.
    const sandbox = new ShellSandbox({ root: () => base, platform: "linux", engine: fakeEngine(), problem: () => probe({ apparmorFile: apparmor }) });
    expect(sandbox.state.kind).toBe("missing");
    expect(sandbox.asksFirst).toBe(true);
    await sandbox.close();
  } finally { resetLinuxProbe(); }
});

test("while planning, the AI's shell gets a read-only project", async () => {
  const { home, project, context } = await fixture();
  const engine = fakeEngine();
  let planning = true;
  const terminal = host([]);
  const value = { ...terminal.value, planning: () => planning };
  const sandbox = createSessionSandbox(value, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(value, sandbox, new SandboxStore(context.stateDirectory));
  await shell.wrap("git diff", project);
  planning = false;
  await shell.wrap("npm test", project);
  expect(engine.wrapped[0]!.policy.allowWrite).not.toContain(project);
  expect(engine.wrapped[1]!.policy.allowWrite).toContain(project);
  await sandbox.close();
});

test("a sandbox that can't start says so, and from then on the AI's shell asks and the receipt says not sandboxed", async () => {
  const { home, project, context } = await fixture();
  const engine = { ...fakeEngine(), initialize: async () => { throw new Error("bwrap: setting up uid map: Permission denied"); } };
  const terminal = host(["No"]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  expect(sandbox.on).toBe(true);
  await expect(sandbox.wrap("npm test", { cwd: project })).rejects.toThrow("the sandbox could not start (bwrap: setting up uid map: Permission denied)");
  expect(terminal.written).toEqual(["[sandbox] The sandbox could not start (bwrap: setting up uid map: Permission denied). Shell commands now ask first.\n"]);
  expect(sandbox.on).toBe(false);
  expect(sandbox.asksFirst).toBe(true);
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("npm test")).toBe(SHELL_DECLINED);
  const { sandboxReceipt } = await import("../src/app/sandbox");
  expect(sandboxReceipt(sandbox)).toEqual({ held: false, reason: "the sandbox could not start: bwrap: setting up uid map: Permission denied" });
});

test("the AI's first command after the sandbox fails to start asks too, and a one-shot run refuses it", async () => {
  const failing = () => ({ ...fakeEngine(), initialize: async () => { throw new Error("bwrap: setting up uid map: Permission denied"); } });
  for (const [answers, expected] of [[["No"], SHELL_DECLINED], [["Yes, this once"], undefined]] as const) {
    const { home, project, context } = await fixture();
    const terminal = host([...answers]);
    const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: failing(), problem: () => undefined, platform: "linux" } });
    const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
    const wrapping = shell.wrap("rm -rf build", project);
    if (expected) await expect(wrapping).rejects.toThrow(expected);
    else expect(await wrapping).toEqual({ command: "rm -rf build" });
    expect(terminal.asked).toEqual([{ question: "Run this command?  rm -rf build", options: ["No", "Yes, this once", "Yes, for this session", "Yes, always for this project"] }]);
    await sandbox.close();
  }
  const { home, project, context } = await fixture();
  const oneShot = host([], false);
  const sandbox = createSessionSandbox(oneShot.value, context, { root: () => project, home, seams: { engine: failing(), problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(oneShot.value, sandbox, new SandboxStore(context.stateDirectory));
  await expect(shell.wrap("rm -rf build", project)).rejects.toThrow(SHELL_CANT_ASK);
  expect(oneShot.asked).toEqual([]);
  await sandbox.close();
});

/** A home whose ~/.ssh/config names a host by an alias, and a system folder with ssh and scp that the AI's shell
 * finds on its PATH (the system temp folders, where the fixture lives, are not the sandbox's writable ones here). */
async function labFixture() {
  const found = await fixture();
  await mkdir(path.join(found.home, ".ssh"));
  await writeFile(path.join(found.home, ".ssh/config"), "Host build-server\n  HostName 198.51.100.20\n  User root\n");
  const bin = path.join(found.base, "system-bin");
  await mkdir(bin);
  for (const name of ["ssh", "scp"]) await writeFile(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  return { ...found, bin, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux" as const, tempDirs: [], searchPath: bin } };
}

test("ssh to a lab host asks first, naming the real address and the alias; Enter runs nothing", async () => {
  const { home, project, context } = await labFixture();
  const engine = fakeEngine();
  const terminal = host([undefined]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  const refused = await shell.approve!("ssh build-server 'cat /etc/pve/user.cfg'");
  expect(refused).toBe("Not run: the user said no to reaching 198.51.100.20 (build-server). Don't try it again another way; ask the user what to do instead.");
  expect(terminal.asked).toEqual([{ question: "Reach 198.51.100.20 (build-server)?  ssh build-server 'cat /etc/pve/user.cfg'", options: ["No", "Yes, this once", "Yes, for this session", "Yes, always for this project"] }]);
  expect(REACH_CHOICES.map((choice) => choice.label)).toEqual(["No", "Yes, this once", "Yes, for this session", "Yes, always for this project"]);
  // Nothing ran, so nothing was held or sent.
  expect(engine.wrapped).toEqual([]);
  await sandbox.close();
});

test("Yes, this once lets a plain ssh run outside the sandbox with your keys, once; the next command asks again", async () => {
  const { home, project, context, seams } = await labFixture();
  const engine = fakeEngine();
  const terminal = host(["Yes, this once", "No"]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { ...seams, engine } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory), { on: () => false });
  expect(await shell.approve!("ssh build-server uptime")).toBeUndefined();
  expect(await shell.wrap("ssh build-server uptime", project)).toEqual({ command: "ssh build-server uptime" });
  expect(engine.wrapped).toEqual([]);
  expect(terminal.written).toEqual(["[sandbox] 198.51.100.20 (build-server): plain ssh and scp you allow run outside the sandbox, with your own keys.\n"]);
  expect(await shell.approve!("ssh build-server uptime")).toContain("Not run: the user said no");
  expect(terminal.asked).toHaveLength(2);
  await sandbox.close();
});

test("Yes, for this session remembers the host until Casper exits; a command with more in it stays in the sandbox, allowed to reach only that host", async () => {
  const { home, project, context, seams } = await labFixture();
  const engine = fakeEngine();
  const terminal = host(["Yes, for this session"]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { ...seams, engine } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory), { on: () => false });
  expect(await shell.approve!("ssh build-server uptime")).toBeUndefined();
  await shell.wrap("ssh build-server uptime", project);
  const compound = "ssh build-server 'journalctl -u sampleapp' | tail -5";
  expect(await shell.approve!(compound)).toBeUndefined();
  const wrapped = await shell.wrap(compound, project);
  expect(wrapped.id).toBeDefined();
  expect(engine.wrapped.map((entry) => entry.command)).toEqual([compound]);
  // The proxy lets this command reach the host without a second question, and only while it runs.
  expect(await engine.ask!("198.51.100.20", 22)).toBe(true);
  expect(terminal.asked).toHaveLength(1);
  expect(terminal.written.at(-1)).toContain("your ~/.ssh keys and settings are hidden, so a login may fail");
  shell.finished!(wrapped.id!);
  terminal.value.pick = async () => undefined;
  expect(await engine.ask!("198.51.100.20", 22)).toBe(false);
  await sandbox.close();
});

test("Yes, always for this project keeps the machine in Casper's own folder: the next session doesn't ask; /sandbox forget undoes it", async () => {
  const { home, project, context, seams } = await labFixture();
  const terminal = host(["Yes, always for this project"]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux" } });
  const store = new SandboxStore(context.stateDirectory);
  const shell = runtimeShell(terminal.value, sandbox, store, { on: () => false });
  expect(await shell.approve!("ssh build-server uptime")).toBeUndefined();
  expect(await readdir(project)).toEqual([]);
  expect(JSON.parse(await readFile(path.join(context.stateDirectory, "sandbox.json"), "utf8")).reach).toEqual(["198.51.100.20"]);
  // A new session: no question, and a plain ssh still runs with your keys.
  const next = host([]);
  const later = createSessionSandbox(next.value, context, { root: () => project, home, seams });
  const nextShell = runtimeShell(next.value, later, new SandboxStore(context.stateDirectory), { on: () => false });
  expect(await nextShell.approve!("ssh deploy@198.51.100.20 hostname")).toBeUndefined();
  expect(await nextShell.wrap("ssh deploy@198.51.100.20 hostname", project)).toEqual({ command: "ssh deploy@198.51.100.20 hostname" });
  expect(next.asked).toEqual([]);
  expect(await later.forget("198.51.100.20")).toBe(true);
  expect(await nextShell.approve!("ssh build-server uptime")).toContain("Not run: the user said no");
  expect(next.asked).toHaveLength(1);
  await sandbox.close(); await later.close();
});

test("a machine on your lab list doesn't ask before ssh; /lab ssh off makes it ask again", async () => {
  const { home, project, context } = await labFixture();
  const terminal = host([undefined, undefined]);
  terminal.value.labHosts = () => ["build-server"];
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux" } });
  const store = new SandboxStore(context.stateDirectory);
  const shell = runtimeShell(terminal.value, sandbox, store);
  expect(await shell.approve!("ssh build-server uptime")).toBeUndefined();
  expect(await shell.approve!("scp notes.txt root@build-server:/tmp/")).toBeUndefined();
  expect(terminal.asked).toEqual([]);
  // A machine named as $HOST could be any machine: it still asks.
  expect(await shell.approve!("ssh $TARGET uptime")).toContain("Not run: the user said no");
  expect(terminal.asked).toHaveLength(1);
  // /lab ssh off writes the sandbox's own store, the one the shell reads.
  await sandbox.store!.setLabReach(false);
  expect(await shell.approve!("ssh build-server uptime")).toContain("Not run: the user said no");
  expect(terminal.asked).toHaveLength(2);
  await sandbox.close();
});

test("only the system's own ssh and scp run outside the sandbox for an allowed machine; a program of that name from the project stays inside", async () => {
  const { home, project, context, bin, seams } = await labFixture();
  const terminal = host([]);
  terminal.value.labHosts = () => ["build-server"];
  const run = async (command: string, searchPath = bin) => {
    const engine = fakeEngine();
    const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { ...seams, engine, searchPath } });
    const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
    try {
      expect(await shell.approve!(command)).toBeUndefined();
      const wrapped = await shell.wrap(command, project);
      return { alone: wrapped.id === undefined, held: engine.wrapped.map((entry) => entry.command) };
    } finally { await sandbox.close(); }
  };
  await mkdir(path.join(project, ".venv", "bin"), { recursive: true });
  for (const name of ["ssh", "scp"]) {
    await writeFile(path.join(project, name), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(path.join(project, ".venv", "bin", name), "#!/bin/sh\n", { mode: 0o755 });
  }
  expect(await run("ssh build-server uptime")).toEqual({ alone: true, held: [] });
  expect(await run("scp notes.txt build-server:/srv/")).toEqual({ alone: true, held: [] });
  // Named by its path, it is the project's program: it runs in the sandbox, whatever machine it names.
  for (const command of ["./ssh build-server uptime", `${path.join(project, "ssh")} build-server uptime`, "./scp notes.txt build-server:/srv/"]) {
    expect([command, await run(command)]).toEqual([command, { alone: false, held: [command] }]);
  }
  // A bare ssh that the PATH finds first in a folder commands may write (the project's .venv/bin or
  // the current folder) runs in the sandbox too; so does one the PATH does not find at all.
  for (const searchPath of [[path.join(project, ".venv", "bin"), bin].join(path.delimiter), ["", bin].join(path.delimiter), path.join(home, "nowhere")]) {
    expect([searchPath, await run("ssh build-server uptime", searchPath)]).toEqual([searchPath, { alone: false, held: ["ssh build-server uptime"] }]);
  }
  expect(terminal.asked).toEqual([]);
});

test("an allowed ssh or scp whose options come after the host, or whose local files reach git's files or links out, stays in the sandbox", async () => {
  const { home, project, context, bin, seams } = await labFixture();
  const terminal = host([]);
  terminal.value.labHosts = () => ["build-server"];
  const outside = path.join(home, "outside-folder");
  await mkdir(outside);
  await mkdir(path.join(project, ".git", "hooks"), { recursive: true });
  await mkdir(path.join(project, "out"));
  await mkdir(path.join(project, "linked"));
  await symlink(outside, path.join(project, "linked", "elsewhere"));
  await writeFile(path.join(project, "notes.txt"), "x");
  const run = async (command: string) => {
    const engine = fakeEngine();
    const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { ...seams, engine, searchPath: bin } });
    const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
    try {
      expect(await shell.approve!(command)).toBeUndefined();
      const wrapped = await shell.wrap(command, project);
      return wrapped.id === undefined;
    } finally { await sandbox.close(); }
  };
  for (const command of [
    "ssh build-server -o ProxyCommand=true", "ssh build-server -F notes.txt", 
    "scp build-server:/tmp/x .git/hooks/entry", "scp build-server:/tmp/x .git/config", "scp -r build-server:/tmp/x linked/", "scp -r linked build-server:/tmp/x",
    "scp build-server:/tmp/x linked/elsewhere/file",
  ]) expect([command, await run(command)]).toEqual([command, false]);
  for (const command of ["ssh build-server ls -la", "ssh -o StrictHostKeyChecking=yes build-server uptime", "scp notes.txt build-server:/tmp/x", "scp build-server:/tmp/x ./out.txt", "scp build-server:/tmp/x out/"]) {
    expect([command, await run(command)]).toEqual([command, true]);
  }
});

test("when the sandbox cannot start, a program named by its path that is not the system's ssh is asked about, not run", async () => {
  const failing = () => ({ ...fakeEngine(), initialize: async () => { throw new Error("bwrap: setting up uid map: Permission denied"); } });
  for (const [answer, expected] of [["No", SHELL_DECLINED], ["Yes, this once", undefined]] as const) {
    const { home, project, context, seams } = await labFixture();
    const terminal = host([answer]);
    terminal.value.labHosts = () => ["build-server"];
    await writeFile(path.join(project, "ssh"), "#!/bin/sh\n", { mode: 0o755 });
    const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { ...seams, engine: failing() } });
    const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
    const command = "./ssh build-server uptime";
    expect(await shell.approve!(command)).toBeUndefined();
    const wrapping = shell.wrap(command, project);
    if (expected) await expect(wrapping).rejects.toThrow(expected);
    else expect(await wrapping).toEqual({ command });
    expect(terminal.asked).toEqual([{ question: `Run this command?  ${command}`, options: ["No", "Yes, this once", "Yes, for this session", "Yes, always for this project"] }]);
    await sandbox.close();
  }
});

test("a lab-listed alias does not let ssh -o HostName= reach another machine without a question", async () => {
  const { home, project, context } = await labFixture();
  const terminal = host([undefined, undefined]);
  terminal.value.labHosts = () => ["build-server"];
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("ssh -o Hostname=203.0.113.9 build-server uptime")).toContain("Not run: the user said no");
  expect(await shell.approve!("scp -oHostName=203.0.113.9 build-server:/etc/hosts ./hosts")).toContain("Not run: the user said no");
  expect(terminal.asked).toHaveLength(2);
  expect(terminal.asked[0]!.question).toContain("203.0.113.9");
  await sandbox.close();
});

test("a run that can't ask takes --allow-host, --allow-write and --allow-reach for this run, and its refusals name them", async () => {
  const { home, project, context } = await labFixture();
  const engine = fakeEngine();
  const terminal = host([], false);
  const shared = path.join(home, "shared");
  await mkdir(shared);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home,
    allow: { hosts: ["api.mist.com"], writes: [shared], reach: ["build-server"] }, seams: { engine, problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  await sandbox.wrap("true", { cwd: project });
  expect(await engine.ask!("api.mist.com", 443)).toBe(true);
  expect(sandbox.writeAllowed(path.join(shared, "notes.txt"))).toBe(true);
  expect(await shell.approve!("ssh build-server uptime")).toBeUndefined();
  expect(await shell.approve!("ssh deploy@198.51.100.20 uptime")).toBeUndefined();
  expect(terminal.asked).toEqual([]);
  // Anything else is refused, and the refusal says which flag allows it.
  expect(await engine.ask!("collector.example", 443)).toBe(false);
  expect(terminal.written.join("")).toContain("--allow-host collector.example");
  expect(await shell.approve!("ssh 10.9.9.9 uptime")).toContain("--allow-reach 10.9.9.9");
  expect(writeCantAsk("~/other")).toContain("--allow-write ~/other");
  await sandbox.close();
});

test("a run that can't ask refuses ssh with a plain line and never waits, with the sandbox on, off or unable to run", async () => {
  for (const seams of [{ problem: () => undefined, platform: "linux" as const }, { problem: () => undefined, platform: "linux" as const, noSandboxFlag: true }, { platform: "win32" as const }]) {
    const { home, project, context } = await labFixture();
    const terminal = host([], false);
    const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), ...seams } });
    const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
    expect(await shell.approve!("ssh root@build-server 'pveum user token add root@pam sampleapp'")).toBe("Not run: this command reaches 198.51.100.20 (build-server), another machine, and this run can't ask you first. Casper doesn't let the AI reach other machines without your OK. Tell the user; they can run it themselves, in a Casper session, or with --allow-reach build-server for one run.");
    expect(terminal.written).toEqual(["[shell] Not run: the AI's command reaches 198.51.100.20 (build-server), and this run can't ask you. Nothing was sent.\n"]);
    expect(terminal.asked).toEqual([]);
    await sandbox.close();
  }
});

test("with the sandbox off (--no-sandbox) ssh still asks; with no sandbox the host question replaces the command question", async () => {
  const { home, project, context } = await labFixture();
  const off = host(["No"]);
  const offSandbox = createSessionSandbox(off.value, context, { root: () => project, home, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux", noSandboxFlag: true } });
  expect(await runtimeShell(off.value, offSandbox, new SandboxStore(context.stateDirectory)).approve!("scp app.py build-server:/opt/sampleapp/")).toContain("said no to reaching 198.51.100.20 (build-server)");
  expect(off.asked.map((entry) => entry.question)).toEqual(["Reach 198.51.100.20 (build-server)?  scp app.py build-server:/opt/sampleapp/"]);

  const windows = host(["Yes, this once", undefined]);
  const askOnly = createSessionSandbox(windows.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(windows.value, askOnly, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("ssh build-server uptime")).toBeUndefined();
  expect(windows.asked.map((entry) => entry.question)).toEqual(["Reach 198.51.100.20 (build-server)?  ssh build-server uptime"]);
  // Any other command still asks the usual question.
  expect(await shell.approve!("npm test")).toBe(SHELL_DECLINED);
  expect(windows.asked.map((entry) => entry.question)).toEqual(["Reach 198.51.100.20 (build-server)?  ssh build-server uptime", "Run this command?  npm test"]);
});

test("a secret the AI typed into a command is hidden in the question", async () => {
  const { home, project, context } = await labFixture();
  const terminal = host([undefined]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  await shell.approve!("curl -k -H 'Authorization: PVEAPIToken=root@pam!sampleapp=0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b' https://build-server:8006/api2/json");
  expect(terminal.asked[0]!.question).not.toContain("0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b");
  expect(terminal.asked[0]!.question).toContain("<secret hidden>");
});

test("nc, telnet or socat you allow stay in the sandbox, which blocks direct connections, and Casper says so plainly", async () => {
  const { home, project, context } = await labFixture();
  const terminal = host(["Yes, this once"]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("nc -zv 10.0.0.1 22")).toBeUndefined();
  expect((await shell.wrap("nc -zv 10.0.0.1 22", project)).id).toBeDefined();
  expect(terminal.written).toEqual(["[sandbox] 10.0.0.1: direct connections like this are blocked in the sandbox, so this command can't reach it. A plain ssh or scp command of its own runs outside the sandbox with your keys.\n"]);
  await sandbox.close();
});

test("ssh with the host in a variable or wrapped in bash -c still asks, even with --no-sandbox; a yes for $H is never remembered", async () => {
  const { home, project, context } = await labFixture();
  const terminal = host(["Yes, for this session", undefined, "No"]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux", noSandboxFlag: true } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  const variable = "H=198.51.100.20; ssh root@$H 'systemctl enable --now sampleapp'";
  expect(await shell.approve!(variable)).toBeUndefined();
  // "For this session" to $H counts for that command only: $H could be any machine next time.
  expect(await shell.approve!(variable)).toBe("Not run: the user said no to reaching another machine ($H). Don't try it again another way; ask the user what to do instead.");
  expect(await shell.approve!(`bash -c "ssh build-server 'pvecm updatecerts --force'"`)).toContain("said no to reaching 198.51.100.20 (build-server)");
  expect(terminal.asked.map((entry) => entry.question)).toEqual([
    `Reach another machine ($H)?  ${variable}`, `Reach another machine ($H)?  ${variable}`,
    `Reach 198.51.100.20 (build-server)?  bash -c "ssh build-server 'pvecm updatecerts --force'"`]);
  await sandbox.close();

  const oneShot = host([], false);
  const offSandbox = createSessionSandbox(oneShot.value, context, { root: () => project, home, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux", noSandboxFlag: true } });
  expect(await runtimeShell(oneShot.value, offSandbox, new SandboxStore(context.stateDirectory)).approve!(variable))
    .toBe("Not run: this command reaches another machine ($H) and this run can't ask you first. Casper doesn't let the AI reach other machines without your OK. Tell the user; they can run it themselves or in a Casper session.");
  expect(oneShot.asked).toEqual([]);
  await offSandbox.close();
});

test("a password the AI typed into sshpass is hidden in the question", async () => {
  const { home, project, context } = await labFixture();
  const terminal = host([undefined]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  await shell.approve!("sshpass -p 'Example2024!' ssh root@198.51.100.20 id");
  expect(terminal.asked[0]!.question).toBe("Reach 198.51.100.20?  sshpass -p '<secret hidden>' ssh root@198.51.100.20 id");
  await sandbox.close();
});

test("an ad-hoc service that reaches another machine asks Reach once, even when the sandbox then fails to start on it", async () => {
  const { serviceTool } = await import("../src/services/tool");
  const { home, project, context } = await labFixture();
  const failing = { ...fakeEngine(), initialize: async () => { throw new Error("bwrap: setting up uid map: Permission denied"); } };
  const terminal = host(["Yes, this once", "No"]);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home, seams: { engine: failing, problem: () => undefined, platform: "linux" } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory));
  let second: string | undefined = "not asked";
  // The manager's start: the sandbox fails on this command, so it asks before running it not sandboxed.
  const manager = { root: project, takeCrashes: () => [],
    startCommand: async (command: string, options: { approve?: (signal: AbortSignal) => Promise<string | undefined> }, signal: AbortSignal) => {
      await sandbox.wrap(command, { cwd: project }).catch(() => {});
      second = await options.approve!(signal);
      throw new Error("stopped here");
    } };
  const tool = serviceTool(() => manager as never, undefined, undefined, (command, signal, options) => shell.approve!(command, signal, options));
  await tool.execute({ action: "start", command: "ssh -N -L 8080:localhost:80 build-server" }, new AbortController().signal);
  expect(second).toBeUndefined();
  expect(terminal.asked.map((entry) => entry.question)).toEqual(["Reach 198.51.100.20 (build-server)?  ssh -N -L 8080:localhost:80 build-server"]);
  await sandbox.close();
});

test("a closed sandbox refuses to wrap instead of handing the command back unheld", async () => {
  const { home, project, context } = await fixture();
  const sandbox = createSessionSandbox(host([]).value, context, { root: () => project, home, seams: { engine: fakeEngine(), problem: () => undefined, platform: "linux" } });
  expect((await sandbox.wrap("true", { cwd: project })).held).toBe(true);
  await sandbox.close();
  await expect(sandbox.wrap("true", { cwd: project })).rejects.toThrow("The sandbox is closed; start a new session or switch folders.");
});
