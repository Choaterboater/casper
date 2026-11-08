import { afterEach, expect, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionSandbox, hostDeclined, hostQuestion, OUTSIDE_RUN_DECLINED, OUTSIDE_RUN_LINE, OUTSIDE_RUN_SETTING_LINE, OUTSIDE_RUN_UNASKED_LINE, outsideRunQuestion, outsideWritesReceipt, runtimeShell, SANDBOX_REFUSED, type PickSettings, type SandboxHost, type SshLoginSettings } from "../src/app/sandbox";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { BackgroundCommands, withBackgroundRequest } from "../src/runtime/background-commands";
import { crewShell } from "../src/crew/shell";
import { casperBashOperations } from "../src/runtime/pi";
import * as stalls from "../src/runtime/stalled-commands";
import { SandboxStore } from "../src/sandbox/store";
import { fakeEngine } from "./support/sandbox-fakes";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";
import { clearNextCommandEnv, setForNextCommand } from "../src/secrets/next-command";

/**
 * Decision 94, as Claude Code and DeepSeek Harness do: a held command that failed where the sandbox refused something
 * (its report, or its denial words in the output) asks "Run this command outside the sandbox?" with No and Yes, this
 * once. Yes runs that same command once more, outside the sandbox; No keeps today's refusal and adds that the person
 * said no. Don't ask runs it outside without the box; a run nobody can answer and an ordinary failure never ask.
 */

const roots: string[] = [];
afterEach(async () => { clearNextCommandEnv(); await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

interface HostSettings { canAsk?: boolean; outsideAsks?: boolean; planning?: boolean; stopAsking?: boolean; delayMs?: number; onPick?: () => void }

function host(answers: Array<string | undefined>, settings: HostSettings = {}) {
  const asked: Array<{ question: string; options: string[]; settings?: PickSettings }> = [];
  const value: SandboxHost = {
    canAsk: () => settings.canAsk ?? true,
    ...(settings.outsideAsks !== undefined ? { outsideAsks: () => settings.outsideAsks! } : {}),
    pick: async (question, options, _signal, picked) => {
      asked.push({ question, options: options.map((option) => option.label), ...(picked ? { settings: picked } : {}) });
      settings.onPick?.();
      if (settings.delayMs) await Bun.sleep(settings.delayMs);
      return answers.shift();
    },
    write: () => {},
    planning: () => settings.planning ?? false,
    stopAsking: () => settings.stopAsking ?? false,
  };
  return { value, asked };
}

/** A session whose fake sandbox refuses what `refuse` names for a command. The project sits next to the fake home,
 * whose ~/.ssh makes their shared folder one the write box never offers: only this box can let the command write it. */
async function session(answers: Array<string | undefined>, refuse: (command: string) => string[], settings: HostSettings = {}, platform: NodeJS.Platform = "linux",
  more: { config?: string; terminal?: SandboxHost["handOver"]; ssh?: SshLoginSettings } = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-run-outside-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(project, { recursive: true }); await mkdir(path.join(home, ".ssh"), { recursive: true });
  // Your own ~/.casper/config.yaml (sandbox.commands).
  if (more.config) { await mkdir(path.join(home, ".casper"), { recursive: true }); await writeFile(path.join(home, ".casper", "config.yaml"), more.config); }
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  const terminal = host(answers, settings);
  if (more.terminal) terminal.value.handOver = more.terminal;
  const engine = fakeEngine(refuse);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => project, home,
    seams: { engine, problem: () => undefined, platform, tempDirs: [] } });
  const shell = runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory), more.ssh);
  return { base, home, project, terminal, engine, sandbox, shell, context };
}

const outsideFile = (s: { base: string }) => path.join(s.base, "outside-file.txt");
const blockedLine = (file: string) => `[sandbox] Blocked by the sandbox (wanted to write ${file}).`;
/** The box when only the command's own words say the sandbox refused it: its claim, not the sandbox's report. */
const saidQuestion = (words: string, command: string) =>
  `The command said "${words}"; the sandbox may have blocked it. Run this command outside the sandbox?  ${command}`;

posixOnly("a command the sandbox kept from writing outside asks to run it outside, with only No and Yes, this once", async () => {
  const s = await session(["Yes, this once"], (command) => command.startsWith("touch") ? [`deny(1) file-write-create ${outsideFile(s)}`] : []);
  const run = await s.shell.wrap("touch ../outside-file.txt", s.project);
  expect(await s.shell.refused!(run.id!, "touch: ../outside-file.txt: Operation not permitted")).toEqual({ outside: true, line: OUTSIDE_RUN_LINE });
  expect(s.terminal.asked).toEqual([{ question: outsideRunQuestion(`The sandbox blocked it (wanted to write ${outsideFile(s)}).`, "touch ../outside-file.txt"), options: ["No", "Yes, this once"], settings: { anyAccess: true } }]);
  expect(s.terminal.asked[0]!.question).toBe(`The sandbox blocked it (wanted to write ${outsideFile(s)}). Run this command outside the sandbox?  touch ../outside-file.txt`);
  // The receipt names the folder it was allowed to write outside the project.
  expect(outsideWritesReceipt(s.sandbox)).toEqual({ outsideAllowed: [s.base] });
  // Nothing is kept: the next command is held again, with the same policy as before.
  await s.shell.wrap("touch ../outside-file.txt", s.project);
  expect(s.engine.wrapped).toHaveLength(2);
  expect(s.engine.wrapped[1]!.policy.allowWrite).not.toContain(s.base);
  expect(s.sandbox.allowedWriteFolders()).toEqual([]);
  await s.sandbox.close();
});

posixOnly("No, or no answer, keeps today's refusal, plus a note that the person said no", async () => {
  for (const answer of ["No", undefined]) {
    const s = await session([answer], () => [`deny(1) file-write-create ${outsideFile(s)}`]);
    const run = await s.shell.wrap("touch ../outside-file.txt", s.project);
    expect(await s.shell.refused!(run.id!, "")).toBe(`${blockedLine(outsideFile(s))} ${SANDBOX_REFUSED} ${OUTSIDE_RUN_DECLINED}`);
    expect(OUTSIDE_RUN_DECLINED).toBe("The user said no to running it outside the sandbox. Don't retry it or work around it.");
    expect(s.terminal.asked).toHaveLength(1);
    expect(outsideWritesReceipt(s.sandbox)).toEqual({});
    await s.sandbox.close();
  }
});

posixOnly("a run that can't ask never shows the box; Don't ask runs it outside without one; a plan turn asks", async () => {
  const cant = await session(["Yes, this once"], () => [`deny(1) file-write-create ${outsideFile(cant)}`], { canAsk: false });
  const held = await cant.shell.wrap("touch ../outside-file.txt", cant.project);
  expect(await cant.shell.refused!(held.id!, "")).toBe(`${blockedLine(outsideFile(cant))} ${SANDBOX_REFUSED}`);
  expect(cant.terminal.asked).toEqual([]);
  await cant.sandbox.close();
  // Don't ask: as Claude Code's bypass mode, the run outside needs no yes.
  const all = await session([], () => [`deny(1) file-write-create ${outsideFile(all)}`], { stopAsking: true });
  const unasked = await all.shell.wrap("touch ../outside-file.txt", all.project);
  expect(await all.shell.refused!(unasked.id!, "")).toEqual({ outside: true, line: OUTSIDE_RUN_UNASKED_LINE });
  expect(all.terminal.asked).toEqual([]);
  expect(outsideWritesReceipt(all.sandbox)).toEqual({ outsideAllowed: [all.base] });
  await all.sandbox.close();
  const plan = await session(["Yes, this once"], () => [`deny(1) file-write-create ${outsideFile(plan)}`], { planning: true });
  const planned = await plan.shell.wrap("touch ../outside-file.txt", plan.project);
  expect(await plan.shell.refused!(planned.id!, "")).toEqual({ outside: true, line: OUTSIDE_RUN_LINE });
  expect(plan.terminal.asked).toHaveLength(1);
  await plan.sandbox.close();
});

posixOnly("any refusal asks, naming it in plain words: a read, a host, a private, protected or git place, or a mix", async () => {
  let refusal: string[] = [];
  const s = await session([], () => refusal);
  const other = path.join(s.base, "other-repo");
  // Nothing refused: a command that failed for its own reasons gets no line and no box.
  const plain = await s.shell.wrap("false", s.project);
  expect(await s.shell.refused!(plain.id!, "make: *** [all] Error 1")).toBeUndefined();
  for (const [lines, shown] of [
    [[`deny(1) file-read-data ${path.join(s.home, ".ssh", "id_ed25519")}`], `wanted to read ${path.join(s.home, ".ssh", "id_ed25519")}`],
    [["network-outbound evil.example:443"], "wanted to reach evil.example"],
    [[`deny(1) file-write-create ${path.join(s.home, ".bashrc")}`], `wanted to write ${path.join(s.home, ".bashrc")}`],
    [[`deny(1) file-write-create ${path.join(other, ".git", "hooks", "pre-commit")}`], `wanted to write ${path.join(other, ".git", "hooks", "pre-commit")}`],
    [[`deny(1) file-write-create ${path.join(s.project, ".mcp.json")}`], `wanted to write ${path.join(s.project, ".mcp.json")}`],
    [[`deny(1) file-write-create ${outsideFile(s)}`, "network-outbound evil.example:443"], `wanted to write ${outsideFile(s)}; wanted to reach evil.example`],
  ] as const) {
    refusal = [...lines];
    const run = await s.shell.wrap("do-it", s.project);
    expect(await s.shell.refused!(run.id!, "")).toEndWith(`${SANDBOX_REFUSED} ${OUTSIDE_RUN_DECLINED}`);
    expect(s.terminal.asked.at(-1)!.question).toBe(`The sandbox blocked it (${shown}). Run this command outside the sandbox?  do-it`);
  }
  expect(s.terminal.asked).toHaveLength(6);
  await s.sandbox.close();
});

posixOnly("No in the host box keeps the host blocked: no box to run it outside, and commands: outside doesn't run it outside either", async () => {
  for (const config of [undefined, "sandbox:\n  commands: outside\n"]) {
    const s = await session(["No", "No"], () => ["network-outbound api.example.com:443"], {}, "linux", config ? { config } : {});
    const run = await s.shell.wrap("curl https://api.example.com", s.project);
    // The person answers No to the host box while the command runs; the proxy then logs the host as refused for it.
    expect(await s.engine.ask!("api.example.com", 443)).toBe(false);
    const line = await s.shell.refused!(run.id!, "curl: (56) CONNECT tunnel failed, response 403");
    expect(line).toBe(`[sandbox] Blocked by the sandbox (wanted to reach api.example.com). ${hostDeclined("api.example.com")}`);
    expect(hostDeclined("api.example.com")).toBe("The user said no to reaching api.example.com. Don't retry it or work around it.");
    expect(s.terminal.asked.map((entry) => entry.question)).toEqual([hostQuestion("api.example.com")]);
    s.shell.finished!(run.id!);
    // A host this command was never asked about (another command's No, a one-shot run) keeps the box to run it outside.
    const next = await s.shell.wrap("curl https://api.example.com", s.project);
    const again = await s.shell.refused!(next.id!, "");
    if (config) expect(again).toEqual({ outside: true, line: OUTSIDE_RUN_SETTING_LINE });
    else {
      expect(again).toBe(`[sandbox] Blocked by the sandbox (wanted to reach api.example.com). ${SANDBOX_REFUSED} ${OUTSIDE_RUN_DECLINED}`);
      expect(s.terminal.asked.at(-1)!.question).toBe(`The sandbox blocked it (wanted to reach api.example.com). Run this command outside the sandbox?  curl https://api.example.com`);
    }
    await s.sandbox.close();
  }
  // No, then a yes to the same host while the command still runs (a retrying tool): the last answer counts.
  const changed = await session(["No", "Yes, this once", "No"], () => ["network-outbound api.example.com:443"]);
  const retried = await changed.shell.wrap("curl --retry 1 https://api.example.com", changed.project);
  expect(await changed.engine.ask!("api.example.com", 443)).toBe(false);
  expect(await changed.engine.ask!("api.example.com", 443)).toBe(true);
  expect(await changed.shell.refused!(retried.id!, "")).toEndWith(`${SANDBOX_REFUSED} ${OUTSIDE_RUN_DECLINED}`);
  expect(changed.terminal.asked).toHaveLength(3);
  await changed.sandbox.close();
  // Something else refused as well (a write): the box to run it outside still asks, naming both.
  const mixed = await session(["No", "No"], () => [`deny(1) file-write-create ${outsideFile(mixed)}`, "network-outbound api.example.com:443"]);
  const run = await mixed.shell.wrap("do-it", mixed.project);
  expect(await mixed.engine.ask!("api.example.com", 443)).toBe(false);
  expect(await mixed.shell.refused!(run.id!, "")).toEndWith(`${SANDBOX_REFUSED} ${OUTSIDE_RUN_DECLINED}`);
  expect(mixed.terminal.asked).toHaveLength(2);
  await mixed.sandbox.close();
});

posixOnly("a stopped command never asks; a folder the write box offers keeps that box", async () => {
  const s = await session(["Yes, this once"], (command) => command === "slow" ? [`deny(1) file-write-create ${outsideFile(s)}`] : []);
  const run = await s.shell.wrap("slow", s.project);
  expect(await s.shell.refused!(run.id!, "", { rerun: false })).toBe(`${blockedLine(outsideFile(s))} ${SANDBOX_REFUSED}`);
  expect(s.terminal.asked).toEqual([]);
  await s.sandbox.close();
  // A folder the write box may offer (~/apps/SomeApp) asks that box, not this one.
  const t = await session(["No"], () => [`deny(1) file-write-create ${path.join(t.home, "apps", "SomeApp", "config.json")}`]);
  await mkdir(path.join(t.home, "apps", "SomeApp"), { recursive: true });
  const write = await t.shell.wrap("touch config.json", t.project);
  expect(await t.shell.refused!(write.id!, "")).toContain("The user said no to writing ~/apps/SomeApp.");
  expect(t.terminal.asked.map((box) => box.question)).toEqual(["A shell command wants to write to ~/apps/SomeApp. Allow it?"]);
  await t.sandbox.close();
});

posixOnly("where the sandbox names nothing, its denial words in the output ask: macOS 'Operation not permitted', Linux 'Read-only file system' or 'Operation not permitted'", async () => {
  for (const [platform, output, words] of [
    ["darwin", "touch: ../outside-file.txt: Operation not permitted", "Operation not permitted"],
    // A reader's too, from any program, on any line.
    ["darwin", "ok\nls: /Users/me/Desktop: Operation not permitted", "Operation not permitted"],
    ["darwin", "Error: EPERM: operation not permitted, scandir '../notes'", "Operation not permitted"],
    ["linux", "touch: cannot touch '../outside-file.txt': Read-only file system", "Read-only file system"],
    // Linux's sandbox blocks Unix sockets (docker, ssh-agent): "Operation not permitted" there too.
    ["linux", "socket: Operation not permitted", "Operation not permitted"],
  ] as const) {
    for (const answer of ["Yes, this once", "No"]) {
      const s = await session([answer], () => [], {}, platform);
      const run = await s.shell.wrap("do-it", s.project);
      expect(await s.shell.refused!(run.id!, output)).toEqual(answer === "No" ? `[sandbox] ${OUTSIDE_RUN_DECLINED}` : { outside: true, line: OUTSIDE_RUN_LINE });
      expect(s.terminal.asked.map((box) => box.question)).toEqual([saidQuestion(words, "do-it")]);
      await s.sandbox.close();
    }
  }
  // Other words, or the other system's words, are an ordinary failure.
  for (const [platform, output] of [["darwin", "make: *** [all] Error 1"], ["darwin", "touch: x: Read-only file system"], ["linux", "make: *** [all] Error 1"]] as const) {
    const s = await session(["Yes, this once"], () => [], {}, platform);
    const run = await s.shell.wrap("do-it", s.project);
    expect(await s.shell.refused!(run.id!, output)).toBeUndefined();
    expect(s.terminal.asked).toEqual([]);
    await s.sandbox.close();
  }
  // An absolute file in Linux's words is the refusal line's too, kept on No.
  const t = await session(["No"], () => [], {}, "linux");
  const run = await t.shell.wrap("touch ../outside-file.txt", t.project);
  expect(await t.shell.refused!(run.id!, `touch: cannot touch '${outsideFile(t)}': Read-only file system`)).toBe(`${blockedLine(outsideFile(t))} ${SANDBOX_REFUSED} ${OUTSIDE_RUN_DECLINED}`);
  expect(t.terminal.asked.map((box) => box.question)).toEqual([`The sandbox blocked it (wanted to write ${outsideFile(t)}). Run this command outside the sandbox?  touch ../outside-file.txt`]);
  await t.sandbox.close();
});

/** The AI's bash with this shell around it: the held run shows it was held and fails; outside it, it writes. */
const COMMAND = `if [ -n "$CASPER_FAKE_HELD" ]; then echo "touch: ../outside-file.txt: Operation not permitted" >&2; exit 1; fi; touch ../outside-file.txt && pwd && echo "var=$RUN_VAR"`;

posixOnly("Yes, this once runs that same command again outside the sandbox, in the same folder with the same variables; the next one is held", async () => {
  const s = await session(["Yes, this once", "No"], (command) => command === COMMAND ? [`deny(1) file-write-create ${outsideFile(s)}`] : []);
  let output = "";
  const bash = casperBashOperations(s.shell);
  const env = { PATH: process.env.PATH ?? "", RUN_VAR: "kept" };
  const result = await bash.exec(COMMAND, s.project, { onData: (data) => { output += data.toString(); }, env });
  expect(result.exitCode).toBe(0);
  expect(existsSync(outsideFile(s))).toBe(true);
  // The held run's failure, the line, then the run outside it.
  const line = output.indexOf(OUTSIDE_RUN_LINE);
  expect(output.indexOf("Operation not permitted")).toBeGreaterThanOrEqual(0);
  expect(output.indexOf("Operation not permitted")).toBeLessThan(line);
  expect(output.slice(line)).toContain(`${s.project}\nvar=kept\n`);
  expect(s.engine.wrapped.map((entry) => entry.command)).toEqual([COMMAND]);
  // The same words later are held again and ask again; No leaves them failed.
  output = "";
  const again = await bash.exec(COMMAND, s.project, { onData: (data) => { output += data.toString(); }, env });
  expect(again.exitCode).toBe(1);
  expect(s.engine.wrapped).toHaveLength(2);
  expect(s.terminal.asked).toHaveLength(2);
  expect(output).toContain(OUTSIDE_RUN_DECLINED);
  expect(output).not.toContain(OUTSIDE_RUN_LINE);
  expect(output).not.toContain("var=kept");
  await s.sandbox.close();
});

posixOnly("an open box is not moved to the background at the command's time limit, and the run outside it gets that limit afresh", async () => {
  // The person takes longer to answer than the 2 s limit after which a slow command moves to the background; the run
  // outside then gets the command's limit afresh.
  const s = await session(["Yes, this once"], (command) => command === COMMAND ? [`deny(1) file-write-create ${outsideFile(s)}`] : [], { delayMs: 2_600 });
  const commands = new BackgroundCommands({ notify: () => {}, limitSeconds: 2 });
  let output = "";
  const result = await casperBashOperations({ ...s.shell, background: () => commands })
    .exec(COMMAND, s.project, { onData: (data) => { output += data.toString(); }, env: { PATH: process.env.PATH ?? "", RUN_VAR: "kept" } });
  expect(result.exitCode).toBe(0);
  expect(output).not.toContain("moved to the background");
  expect(output).toContain(`${OUTSIDE_RUN_LINE}\n${s.project}\nvar=kept\n`);
  expect(commands.list()).toEqual([]);
  await s.sandbox.close();
});

posixOnly("a command the AI asked to run in the background, allowed outside the sandbox, moves to the background as its first run would", async () => {
  const slow = `if [ -n "$CASPER_FAKE_HELD" ]; then echo "touch: ../outside-file.txt: Operation not permitted" >&2; exit 1; fi; touch ../outside-file.txt; echo started; sleep 30; echo finished`;
  const s = await session(["Yes, this once"], (command) => command === slow ? [`deny(1) file-write-create ${outsideFile(s)}`] : []);
  const commands = new BackgroundCommands({ notify: () => {} });
  let output = "";
  const result = await withBackgroundRequest(true, () => casperBashOperations({ ...s.shell, background: () => commands })
    .exec(slow, s.project, { onData: (data) => { output += data.toString(); }, env: { PATH: process.env.PATH ?? "" } }));
  // Not killed at the 3 s grace: the run outside moved to the background and runs on there.
  expect(result.exitCode).toBe(0);
  expect(output).toContain(`${OUTSIDE_RUN_LINE}\nstarted\n`);
  expect(output).toContain("moved to the background");
  expect(existsSync(outsideFile(s))).toBe(true);
  const jobs = commands.list();
  expect(jobs).toHaveLength(1);
  for (const job of jobs) await commands.stop(job.id);
  await s.sandbox.close();
}, 20_000);

posixOnly("a command already moved to the background asks when it ends, and its run outside writes to its job", async () => {
  const slow = `if [ -n "$CASPER_FAKE_HELD" ]; then sleep 2; echo "touch: ../outside-file.txt: Operation not permitted" >&2; exit 1; fi; touch ../outside-file.txt; echo ran-outside`;
  const s = await session(["Yes, this once"], (command) => command === slow ? [`deny(1) file-write-create ${outsideFile(s)}`] : []);
  const notes: string[] = [];
  const commands = new BackgroundCommands({ notify: (text) => { notes.push(text); }, limitSeconds: 1 });
  let output = "";
  const result = await casperBashOperations({ ...s.shell, background: () => commands })
    .exec(slow, s.project, { onData: (data) => { output += data.toString(); }, env: { PATH: process.env.PATH ?? "" } });
  expect(result.exitCode).toBe(0);
  expect(output).toContain("moved to the background");
  expect(s.terminal.asked).toEqual([]);
  for (let waited = 0; waited < 10_000 && !notes.length; waited += 50) await Bun.sleep(50);
  expect(s.terminal.asked).toHaveLength(1);
  expect(existsSync(outsideFile(s))).toBe(true);
  expect(notes.join("\n")).toContain(`${OUTSIDE_RUN_LINE}\nran-outside`);
  await s.sandbox.close();
}, 20_000);

posixOnly("the receipt lists only folders outside the project, on Linux from the output's 'Read-only file system' lines too", async () => {
  // Linux's bubblewrap reports nothing: the files are named only in the output.
  const s = await session(["Yes, this once"], () => [], {}, "linux");
  const run = await s.shell.wrap("do-it", s.project);
  const output = `touch: cannot touch '${outsideFile(s)}': Read-only file system\ntouch: cannot touch '${path.join(s.project, ".mcp.json")}': Read-only file system`;
  expect(await s.shell.refused!(run.id!, output)).toEqual({ outside: true, line: OUTSIDE_RUN_LINE });
  expect(outsideWritesReceipt(s.sandbox)).toEqual({ outsideAllowed: [s.base] });
  await s.sandbox.close();
  // The sandbox's own report: a refused write inside the project (.vscode, a plan turn's project) is not "outside".
  const t = await session(["Yes, this once"], () => [`deny(1) file-write-create ${path.join(t.project, ".vscode", "settings.json")}`], {}, "darwin");
  const inside = await t.shell.wrap("do-it", t.project);
  expect(await t.shell.refused!(inside.id!, "")).toEqual({ outside: true, line: OUTSIDE_RUN_LINE });
  expect(outsideWritesReceipt(t.sandbox)).toEqual({});
  await t.sandbox.close();
});

posixOnly("sandbox.commands in your config: outside runs it outside without the box, even where nobody answers; inside keeps it blocked and asks nothing, Don't ask too", async () => {
  const out = await session([], () => [`deny(1) file-write-create ${outsideFile(out)}`], { canAsk: false }, "linux", { config: "sandbox:\n  commands: outside\n" });
  expect(out.context.sandbox?.user.commands).toBe("outside");
  const run = await out.shell.wrap("touch ../outside-file.txt", out.project);
  expect(await out.shell.refused!(run.id!, "")).toEqual({ outside: true, line: OUTSIDE_RUN_SETTING_LINE });
  expect(out.terminal.asked).toEqual([]);
  // A stopped command still never runs outside.
  const stopped = await out.shell.wrap("touch ../outside-file.txt", out.project);
  expect(await out.shell.refused!(stopped.id!, "", { rerun: false })).toBe(`${blockedLine(outsideFile(out))} ${SANDBOX_REFUSED}`);
  await out.sandbox.close();
  for (const stopAsking of [false, true]) {
    const kept = await session(["Yes, this once"], (command) => command.startsWith("touch") ? [`deny(1) file-write-create ${outsideFile(kept)}`] : [], { stopAsking }, "linux", { config: "sandbox:\n  commands: inside\n" });
    const held = await kept.shell.wrap("touch ../outside-file.txt", kept.project);
    expect(await kept.shell.refused!(held.id!, "")).toBe(`${blockedLine(outsideFile(kept))} ${SANDBOX_REFUSED}`);
    const said = await kept.shell.wrap("do-it", kept.project);
    expect(await kept.shell.refused!(said.id!, "touch: x: Read-only file system")).toBeUndefined();
    expect(kept.terminal.asked).toEqual([]);
    await kept.sandbox.close();
  }
});

posixOnly("a write the write box could offer: commands: outside runs it outside without that box, even where nobody answers; inside keeps the write box", async () => {
  for (const canAsk of [false, true]) {
    const out = await session(["Yes, this once"], () => [`deny(1) file-write-create ${path.join(out.home, "apps", "SomeApp", "config.json")}`], { canAsk }, "linux", { config: "sandbox:\n  commands: outside\n" });
    await mkdir(path.join(out.home, "apps", "SomeApp"), { recursive: true });
    const run = await out.shell.wrap("touch ~/apps/SomeApp/config.json", out.project);
    expect(await out.shell.refused!(run.id!, "")).toEqual({ outside: true, line: OUTSIDE_RUN_SETTING_LINE });
    expect(out.terminal.asked).toEqual([]);
    await out.sandbox.close();
  }
  const kept = await session(["No"], () => [`deny(1) file-write-create ${path.join(kept.home, "apps", "SomeApp", "config.json")}`], {}, "linux", { config: "sandbox:\n  commands: inside\n" });
  await mkdir(path.join(kept.home, "apps", "SomeApp"), { recursive: true });
  const held = await kept.shell.wrap("touch ~/apps/SomeApp/config.json", kept.project);
  expect(await kept.shell.refused!(held.id!, "")).toContain("The user said no to writing ~/apps/SomeApp.");
  expect(kept.terminal.asked.map((box) => box.question)).toEqual(["A shell command wants to write to ~/apps/SomeApp. Allow it?"]);
  await kept.sandbox.close();
});

posixOnly("a write the write box could offer where that box can't ask: the box to run it outside asks where it can, else the --allow-write line", async () => {
  const s = await session(["Yes, this once"], () => [`deny(1) file-write-create ${path.join(s.home, "apps", "SomeApp", "config.json")}`], { canAsk: false, outsideAsks: true });
  await mkdir(path.join(s.home, "apps", "SomeApp"), { recursive: true });
  const run = await s.shell.wrap("touch ~/apps/SomeApp/config.json", s.project);
  expect(await s.shell.refused!(run.id!, "")).toEqual({ outside: true, line: OUTSIDE_RUN_LINE });
  expect(s.terminal.asked.map((box) => box.question)).toEqual([outsideRunQuestion(`The sandbox blocked it (wanted to write ${path.join(s.home, "apps", "SomeApp", "config.json")}).`, "touch ~/apps/SomeApp/config.json")]);
  await s.sandbox.close();
  const t = await session([], () => [`deny(1) file-write-create ${path.join(t.home, "apps", "SomeApp", "config.json")}`], { canAsk: false });
  await mkdir(path.join(t.home, "apps", "SomeApp"), { recursive: true });
  const held = await t.shell.wrap("touch ~/apps/SomeApp/config.json", t.project);
  expect(await t.shell.refused!(held.id!, "")).toContain("this run can't ask. To allow it for one run: --allow-write");
  expect(t.terminal.asked).toEqual([]);
  await t.sandbox.close();
});

posixOnly("Read only asks too, as DeepSeek Harness's read-only card does: the box is shown although other boxes are not", async () => {
  const s = await session(["Yes, this once"], () => [`deny(1) file-read-data ${path.join(s.home, "notes.txt")}`], { canAsk: false, outsideAsks: true });
  const run = await s.shell.wrap("cat ~/notes.txt", s.project);
  expect(await s.shell.refused!(run.id!, "")).toEqual({ outside: true, line: OUTSIDE_RUN_LINE });
  expect(s.terminal.asked).toHaveLength(1);
  expect(s.terminal.asked[0]!.settings).toEqual({ anyAccess: true });
  await s.sandbox.close();
});

posixOnly("a builder's blocked command asks in the session's box under the builder's name; Don't ask runs it outside without one; with no box it never asks", async () => {
  const refuse = (s: { base: string }) => (command: string) => command.startsWith("touch") ? [`deny(1) file-write-create ${outsideFile(s)}`] : [];
  const builder = async (s: Awaited<ReturnType<typeof session>>, ask: boolean) => {
    const copy = path.join(s.base, "copy");
    await mkdir(copy, { recursive: true });
    const notes: string[] = [];
    const shell = crewShell(s.sandbox, copy, (line) => notes.push(line), ask ? { host: s.terminal.value, label: "Builder 2" } : undefined)!;
    const run = await shell.wrap("touch ../outside-file.txt", copy);
    return { shell, copy, notes, answer: await shell.refused!(run.id!, "") };
  };
  // Ask first: the session's box, named for the builder, as Claude Code's subagents ask in the main session.
  const s = await session(["Yes, this once"], (command) => refuse(s)(command));
  const asked = await builder(s, true);
  expect(asked.answer).toEqual({ outside: true, line: OUTSIDE_RUN_LINE });
  expect(s.terminal.asked).toEqual([{ question: `Builder 2: ${outsideRunQuestion(`The sandbox blocked it (wanted to write ${outsideFile(s)}).`, "touch ../outside-file.txt")}`, options: ["No", "Yes, this once"], settings: { anyAccess: true } }]);
  await asked.shell.close(); await s.sandbox.close();
  // Don't ask: the builder's command runs outside without a box, as the main session's does.
  const all = await session([], (command) => refuse(all)(command), { stopAsking: true });
  const unasked = await builder(all, true);
  expect(unasked.answer).toEqual({ outside: true, line: OUTSIDE_RUN_UNASKED_LINE });
  expect(all.terminal.asked).toEqual([]);
  await unasked.shell.close(); await all.sandbox.close();
  // A builder with no box to ask in (a one-shot run) keeps today's refusal and runs nothing outside.
  const none = await session(["Yes, this once"], (command) => refuse(none)(command), { canAsk: false });
  const kept = await builder(none, false);
  expect(kept.answer).toBe(`${blockedLine(outsideFile(none))} ${SANDBOX_REFUSED}`);
  expect(none.terminal.asked).toEqual([]);
  await kept.shell.close(); await none.sandbox.close();
});

posixOnly("a held command handed the terminal asks too, and Yes hands it the terminal again for the same words outside the sandbox", async () => {
  const ran: string[] = [];
  const lender: NonNullable<SandboxHost["handOver"]> = { can: () => true, lend: async (_note, run) => await run() };
  const envs: Array<Record<string, string | undefined>> = [];
  const attach: SshLoginSettings["attach"] = async (run, _cwd, env) => {
    ran.push(run); envs.push(env);
    return run.includes("CASPER_FAKE_HELD") ? { exitCode: 1, tail: "npm error EPERM: operation not permitted, open '/x/.npmrc'" } : { exitCode: 0, tail: "logged in" };
  };
  const s = await session(["Yes, this once"], () => [], {}, "darwin", { terminal: lender, ssh: { attach } });
  // It needed a terminal last time: sent again, it is handed one.
  s.shell.neededTerminal!("npm login");
  // A value typed in casper_secret's box for this command reaches its run outside the sandbox too.
  setForNextCommand("NPM_TOKEN", "typed-value");
  let output = "";
  const result = await casperBashOperations(s.shell).exec("npm login", s.project, { onData: (data) => { output += data.toString(); }, env: { PATH: process.env.PATH ?? "" } });
  expect(result.exitCode).toBe(0);
  expect(s.terminal.asked.map((box) => box.question)).toEqual([saidQuestion("Operation not permitted", "npm login")]);
  expect(ran).toHaveLength(2);
  expect(ran[1]).toBe("npm login");
  expect(envs.map((env) => env.NPM_TOKEN)).toEqual(["typed-value", "typed-value"]);
  expect(output.indexOf(OUTSIDE_RUN_LINE)).toBeGreaterThan(output.indexOf("operation not permitted"));
  expect(output.slice(output.indexOf(OUTSIDE_RUN_LINE))).toContain("logged in");
  await s.sandbox.close();
});

posixOnly("a line the person sends while the box is open waits: after Yes the run outside finishes in the call, not moved or stopped", async () => {
  let steer: (() => void) | undefined;
  const s = await session(["Yes, this once"], (command) => command === COMMAND ? [`deny(1) file-write-create ${outsideFile(s)}`] : [],
    { delayMs: 300, onPick: () => steer?.() });
  const commands = new BackgroundCommands({ notify: () => {} });
  let output = "";
  const result = await casperBashOperations({ ...s.shell, background: () => commands, whenSteered: (end) => { steer = end; return () => { steer = undefined; }; } })
    .exec(COMMAND, s.project, { onData: (data) => { output += data.toString(); }, env: { PATH: process.env.PATH ?? "", RUN_VAR: "kept" } });
  expect(result.exitCode).toBe(0);
  expect(output).toContain(`${OUTSIDE_RUN_LINE}\n${s.project}\nvar=kept\n`);
  expect(output).not.toContain("moved to the background");
  expect(commands.list()).toEqual([]);
  await s.sandbox.close();
});

posixOnly("the run outside the sandbox gets its own stall check", async () => {
  const s = await session(["Yes, this once"], (command) => command === COMMAND ? [`deny(1) file-write-create ${outsideFile(s)}`] : []);
  const watched: string[] = [];
  // The second watch is the run outside's: it says that run stalled.
  const watching = spyOn(stalls, "watchStall").mockImplementation(({ onStall }) => {
    watched.push("watch");
    if (watched.length === 2) setTimeout(onStall, 50);
    return { output() {}, stop() {} };
  });
  try {
    const slow = `if [ -n "$CASPER_FAKE_HELD" ]; then echo "touch: x: Operation not permitted" >&2; exit 1; fi; sleep 30`;
    const t = await session(["Yes, this once"], (command) => command === slow ? [`deny(1) file-write-create ${outsideFile(t)}`] : []);
    let output = "";
    const result = await casperBashOperations({ ...t.shell, stallSeconds: () => 1 })
      .exec(slow, t.project, { onData: (data) => { output += data.toString(); }, env: { PATH: process.env.PATH ?? "" } });
    expect(watched).toHaveLength(2);
    expect(result.exitCode).toBe(stalls.STALLED_EXIT_CODE);
    expect(output).toContain(OUTSIDE_RUN_LINE);
    expect(output).toContain("[stalled:");
    await t.sandbox.close();
  } finally { watching.mockRestore(); await s.sandbox.close(); }
}, 20_000);
