import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import { removeTempDir } from "./support/temp-dir";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { BackgroundCommands, DETACH_NOTE, withBackgroundRequest } from "../src/runtime/background-commands";
import { casperBashOperations } from "../src/runtime/pi";
import type { RuntimeShell } from "../src/runtime/types";
import { serviceTool } from "../src/services/tool";
import type { ServiceManager } from "../src/services/manager";

const unix = process.platform !== "win32";

function setup(options: { max?: number } = {}) {
  const notes: string[] = [];
  const commands = new BackgroundCommands({ notify: (note) => { notes.push(note); }, limitSeconds: 6, ...options });
  const shell: RuntimeShell = { wrap: async (command) => ({ command }), background: () => commands };
  const bash = createBashToolDefinition(process.cwd(), { operations: casperBashOperations(shell) });
  const run = async (command: string, timeout?: number) => {
    try {
      const result = await bash.execute("call", { command, ...(timeout ? { timeout } : {}) }, new AbortController().signal, undefined, undefined as never);
      return result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
    } catch (error) { return `error: ${(error as Error).message}`; }
  };
  return { notes, commands, run };
}

const until = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(50);
  return check();
};

/** The sleep processes running now (only their own command lines, not a shell that mentions them). */
function processes(): string {
  return execFileSync("ps", ["-A", "-o", "command"], { encoding: "utf8" }).split("\n").filter((line) => line.startsWith("sleep ")).join("\n");
}

test.skipIf(!unix)("a slow command without its own timeout moves to the background, and a note with its exit code and output comes when it ends", async () => {
  const { notes, commands, run } = setup();
  const text = await run("echo started; sleep 10; echo done");
  // It came back before the command finished: what it printed so far, not its last line.
  expect(text).toContain("started");
  expect(text).not.toContain("done");
  expect(text).toContain("moved to the background as cmd-1");
  expect(text).toContain("service cmd-1");
  expect(commands.list().map((entry) => entry.id)).toEqual(["cmd-1"]);
  expect(await until(() => notes.length > 0)).toBe(true);
  expect(notes[0]).toContain("[Background command cmd-1 ended with exit code 0");
  expect(notes[0]).toContain("done");
  expect(commands.list()).toEqual([]);
}, 30_000);

test.skipIf(!unix)("background: true starts a long job at once: listed, never stopped at the limit or for being quiet, a note when it ends", async () => {
  const { notes, commands, run } = setup();
  const began = Date.now();
  // Its own timeout is ignored: a job meant to outlive the call has none.
  const text = await withBackgroundRequest(true, () => run("echo started; sleep 9; echo done", 2));
  expect(Date.now() - began).toBeLessThan(5_500);
  expect(text).toContain("started");
  expect(text).toContain("As asked (background: true), after 3 s it moved to the background as cmd-1");
  expect(commands.list().map((entry) => entry.id)).toEqual(["cmd-1"]);
  // Past the 6 s limit a slow command gets, and silent all along: still running.
  await Bun.sleep(4_000);
  expect(commands.list().map((entry) => entry.id)).toEqual(["cmd-1"]);
  expect(await until(() => notes.length > 0, 10_000)).toBe(true);
  expect(notes[0]).toContain("[Background command cmd-1 ended with exit code 0");
  expect(notes[0]).toContain("done");
}, 30_000);

test.skipIf(!unix)("background: true still shows a quick failure in the call itself, and is refused when the background is full", async () => {
  const { commands, run } = setup({ max: 1 });
  expect(await withBackgroundRequest(true, () => run("echo oops >&2; exit 3"))).toContain("Command exited with code 3");
  expect(commands.list()).toEqual([]);
  await withBackgroundRequest(true, () => run("sleep 20"));
  expect(await withBackgroundRequest(true, () => run("sleep 20"))).toContain("Not started: 1 commands already run in the background");
  await commands.close();
}, 30_000);

test.skipIf(!unix)("a command that sends its own job to the background (nohup, &, setsid) is told about background: true; others are not", async () => {
  const { commands, run } = setup();
  // The smoke session's launch: nohup … & then a short wait. Casper ends the job with the call.
  expect(await run('nohup sleep 0.3 > /dev/null 2>&1 &\necho "pid $!"; sleep 0.1')).toContain(DETACH_NOTE);
  for (const command of ["echo plain 2>&1 | cat", "true && echo ok", "echo 'a&b'"]) expect(await run(command)).not.toContain("background: true");
  expect(commands.list()).toEqual([]);
}, 30_000);

test.skipIf(!unix)("a command with its own timeout is still stopped at it, and a quick one is untouched", async () => {
  const { notes, commands, run } = setup();
  expect(await run("echo quick")).toBe("quick\n");
  const text = await run("sleep 3; echo never", 1);
  expect(text).toContain("Command timed out after 1 seconds");
  expect(commands.list()).toEqual([]);
  // A command waiting for input gets end-of-file at once, so it ends instead of waiting in the background.
  expect(await run("read line || echo no input")).toContain("no input");
  await Bun.sleep(100);
  expect(notes).toEqual([]);
}, 30_000);

test.skipIf(!unix)("ending the session stops the whole process tree, with no note and no orphans", async () => {
  const { notes, commands, run } = setup();
  const text = await run("sleep 41.7 & sleep 41.8; wait");
  expect(text).toContain("cmd-1");
  expect(processes()).toContain("sleep 41.7");
  await commands.close();
  expect(await until(() => !processes().includes("sleep 41.7") && !processes().includes("sleep 41.8"), 3000)).toBe(true);
  expect(notes).toEqual([]);
  // After the session ends nothing more moves to the background: it is stopped at the limit.
  expect(await run("sleep 10")).toContain("Command timed out after 6 seconds");
}, 30_000);

test.skipIf(!unix)("Casper ending without closing the session (a crash, process.exit, the terminal closing) still kills every background tree", async () => {
  const script = `
    import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
    import { BackgroundCommands } from ${JSON.stringify(path.resolve("src/runtime/background-commands"))};
    import { casperBashOperations } from ${JSON.stringify(path.resolve("src/runtime/pi"))};
    const commands = new BackgroundCommands({ notify: () => {}, limitSeconds: 1 });
    const bash = createBashToolDefinition(process.cwd(), { operations: casperBashOperations({ wrap: async (command) => ({ command }), background: () => commands }) });
    const result = await bash.execute("call", { command: "sleep 44.6 & sleep 44.7; wait" }, new AbortController().signal, undefined, undefined);
    console.log(commands.list().length);
    if (process.argv.includes("hangup")) process.kill(process.pid, "SIGHUP"); else process.exit(0);`;
  const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", cwd: process.cwd() });
  expect(out.trim()).toBe("1");
  expect(await until(() => !processes().includes("sleep 44.6") && !processes().includes("sleep 44.7"), 3000)).toBe(true);
  // The terminal closing (a hang-up) too: the commands sit in their own process group, out of the hang-up's reach.
  let ended: string | undefined;
  try { execFileSync(process.execPath, ["-e", `${script}\nawait new Promise((resolve) => setTimeout(resolve, 5000));`, "hangup"], { encoding: "utf8", cwd: process.cwd() }); ended = "on its own"; }
  catch (error) { ended = (error as { signal?: string }).signal ?? `status ${(error as { status?: number }).status}`; }
  expect(ended).toBe("SIGHUP");
  expect(await until(() => !processes().includes("sleep 44.6") && !processes().includes("sleep 44.7"), 3000)).toBe(true);
}, 30_000);

test.skipIf(!unix)("beyond the most at once a slow command is stopped as before; /tasks' stop says so in the note", async () => {
  const { notes, commands, run } = setup({ max: 1 });
  expect(await run("sleep 42.3")).toContain("cmd-1");
  const second = await run("sleep 42.4");
  expect(second).toContain("1 slow commands already run in the background");
  expect(second).toContain("Command timed out after 6 seconds");
  expect(await commands.stop("cmd-1")).toBe(true);
  expect(notes[0]).toContain("cmd-1 was stopped from /tasks");
  expect(await until(() => !processes().includes("sleep 42.3"), 3000)).toBe(true);
}, 30_000);

test.skipIf(!unix)("the service tool lists a background command, shows its output and stops it without a note", async () => {
  const { notes, commands, run } = setup();
  await run("echo first line; sleep 43.1");
  const manager = { status: () => [], takeCrashes: () => [], takeMoves: () => [], takeBlocked: () => [], casperOnly: () => false } as unknown as ServiceManager;
  const tool = serviceTool(() => manager, undefined, undefined, undefined, () => commands);
  const signal = new AbortController().signal;
  expect((await tool.execute({ action: "status" }, signal)).text).toContain("cmd-1");
  expect((await tool.execute({ action: "logs", service: "cmd-1" }, signal)).text).toContain("first line");
  expect((await tool.execute({ action: "stop", service: "cmd-1" }, signal)).text).toContain("\"stopped\":true");
  expect(commands.list()).toEqual([]);
  expect(notes).toEqual([]);
  expect((await tool.execute({ action: "logs", service: "cmd-1" }, signal)).isError).toBe(true);
}, 30_000);

test("slow_commands is your own setting: on unless your config turns it off, never in a project file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-slow-commands-"));
  try {
    const home = path.join(root, "home"), project = path.join(root, "project");
    await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
    const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
    expect((await load()).slowCommands).toBeUndefined();
    await writeFile(path.join(home, ".casper", "config.yaml"), "slow_commands: off\n");
    expect(await load()).toMatchObject({ slowCommands: false });
    await writeFile(path.join(project, ".casper", "project.yaml"), "slow_commands: on\n");
    await expect(load()).rejects.toThrow("slow_commands is a user setting");
  } finally { await removeTempDir(root); }
});
