import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { loadConfiguration } from "../src/config/load";
import { BackgroundCommands } from "../src/runtime/background-commands";
import { casperBashOperations } from "../src/runtime/pi";
import { busyBetween, cpuSeconds, stalledMessage, watchStall } from "../src/runtime/stalled-commands";
import type { RuntimeShell } from "../src/runtime/types";
import { removeTempDir } from "./support/temp-dir";

const unix = process.platform !== "win32";

/** Bash as the AI runs it, with a 2 s stall window (45 s in Casper). */
function setup(options: { limitSeconds?: number } = {}) {
  const notes: string[] = [];
  const commands = new BackgroundCommands({ notify: (note) => { notes.push(note); }, limitSeconds: options.limitSeconds ?? 60 });
  const shell: RuntimeShell = { wrap: async (command) => ({ command }), background: () => commands, stallSeconds: () => 2 };
  const bash = createBashToolDefinition(process.cwd(), { operations: casperBashOperations(shell, createLocalBashOperations()) });
  const run = async (command: string, timeout?: number) => {
    const began = Date.now();
    let text: string;
    try {
      const result = await bash.execute("call", { command, ...(timeout ? { timeout } : {}) }, new AbortController().signal, undefined, undefined as never);
      text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
    } catch (error) { text = `error: ${(error as Error).message}`; }
    return { text, seconds: (Date.now() - began) / 1000 };
  };
  return { notes, commands, run };
}

const until = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(50);
  return check();
};

const sleeping = () => execFileSync("ps", ["-A", "-o", "command"], { encoding: "utf8" }).split("\n").filter((line) => line.startsWith("sleep ")).join("\n");

test.skipIf(!unix)("a silent idle command is ended, with what it started, after the window, and says after which line", async () => {
  const { run } = setup();
  const { text, seconds } = await run("echo getting ready; sleep 46.1 & sleep 46.2; wait");
  expect(seconds).toBeLessThan(12);
  expect(text).toContain("[stalled: no output and no CPU for 2 s after: getting ready.");
  expect(text).toContain("give it a timeout");
  expect(text).toContain("Command exited with code 124");
  expect(await until(() => !sleeping().includes("sleep 46.1") && !sleeping().includes("sleep 46.2"), 3000)).toBe(true);
}, 30_000);

test.skipIf(!unix)("a silent command busy on the CPU, and one printing every second, run to the end", async () => {
  const { run } = setup();
  const busy = await run("while [ $SECONDS -lt 6 ]; do :; done; echo busy done");
  expect(busy.text).toBe("busy done\n");
  const chatty = await run("for i in 1 2 3 4 5 6; do echo tick $i; sleep 1; done");
  expect(chatty.text).toContain("tick 6");
  expect(chatty.text).not.toContain("stalled");
}, 40_000);

test.skipIf(!unix)("tests that finished but kept something open get the teardown hint; a browser download gets the browser hint", async () => {
  const { run } = setup();
  const tests = await run("printf 'ok 1 - adds\\n# tests 1\\n# pass 1\\n# fail 0\\n'; sleep 47.1");
  expect(tests.text).toContain("after: # fail 0");
  expect(tests.text).toContain("The tests finished but something is still open (a server, timer or connection): close it in the test teardown.");
  // The hint is text keyed on the command's words; this one only pretends to be a download.
  const download = await run("true npx playwright install chromium; echo Downloading Chromium; sleep 47.2");
  expect(download.text).toContain("Casper already has a browser: use the browser tool instead of installing one.");
  expect(download.text).not.toContain("teardown");
}, 40_000);

test.skipIf(!unix)("a command with its own timeout is never ended for being quiet", async () => {
  const { run } = setup();
  const { text, seconds } = await run("sleep 5; echo waited", 20);
  expect(seconds).toBeGreaterThan(4.5);
  expect(text).toBe("waited\n");
}, 30_000);

test.skipIf(!unix)("a stalled command in the background is ended the same way, and its note says so", async () => {
  const { run, notes, commands } = setup({ limitSeconds: 1 });
  const { text } = await run("echo started; sleep 1.5; echo still going; sleep 48.1");
  expect(text).toContain("moved to the background as cmd-1");
  expect(await until(() => notes.length > 0, 20_000)).toBe(true);
  expect(notes[0]).toContain("cmd-1 ended with exit code 124");
  expect(notes[0]).toContain("[stalled: no output and no CPU for 2 s after: still going.");
  expect(commands.list()).toEqual([]);
  expect(await until(() => !sleeping().includes("sleep 48.1"), 3000)).toBe(true);
}, 30_000);

test("CPU times as ps prints them, and what counts as busy", () => {
  expect(cpuSeconds("0:00.03")).toBeCloseTo(0.03);
  expect(cpuSeconds("190:56.96")).toBeCloseTo(11_456.96);
  expect(cpuSeconds("01:02:03")).toBe(3723);
  expect(cpuSeconds("2-00:00:01")).toBe(172_801);
  const sample = (cpu: [number, number][], io?: number) => ({ cpu: new Map(cpu), ...(io === undefined ? {} : { io }) });
  expect(busyBetween(sample([[1, 1]]), sample([[1, 1.1]]), 45)).toBe(false);
  expect(busyBetween(sample([[1, 1]]), sample([[1, 2]]), 45)).toBe(true);
  expect(busyBetween(sample([[1, 1]]), sample([[1, 1], [2, 0]]), 45)).toBe(true);
  expect(busyBetween(sample([[1, 1], [2, 0]]), sample([[1, 1]]), 45)).toBe(true);
  expect(busyBetween(sample([[1, 1]], 10), sample([[1, 1]], 900), 45)).toBe(true);
  expect(busyBetween({ cpu: new Map([[1, 1]]), io: "unknown" }, { cpu: new Map([[1, 1]]), io: "unknown" }, 45)).toBe(true);
  expect(stalledMessage("node --test", "ℹ tests 4\nℹ pass 4\n", 45)).toContain("close it in the test teardown");
  expect(stalledMessage("npm run build", "building\n", 45)).toBe("\n[stalled: no output and no CPU for 45 s after: building. Casper ended it and what it started; to wait on purpose, give it a timeout.]\n");
});

test("where the command's processes can't be read, silence alone never ends it", async () => {
  let stalled = false;
  const watch = watchStall({ seconds: 0.4, root: async () => 1, onStall: () => { stalled = true; }, sample: async () => undefined });
  await Bun.sleep(1500);
  watch.stop();
  expect(stalled).toBe(false);
});

test.skipIf(!unix)("a quiet download that is still moving bytes, at almost no CPU, runs to the end", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(new ReadableStream({
    async pull(controller) {
      for (let i = 0; i < 20; i++) { controller.enqueue(new Uint8Array(512)); await Bun.sleep(300); }
      controller.close();
    },
  })) });
  try {
    const { run } = setup();
    const { text } = await run(`curl -s -o /dev/null http://127.0.0.1:${server.port}/; echo fetched`);
    expect(text).toBe("fetched\n");
  } finally { server.stop(true); }
}, 30_000);

test("stalled_commands is your own setting: on unless your config turns it off, never in a project file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-stalled-commands-"));
  try {
    const home = path.join(root, "home"), project = path.join(root, "project");
    await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
    const load = () => loadConfiguration({ projectRoot: project, homeDir: home });
    expect((await load()).stalledCommands).toBeUndefined();
    await writeFile(path.join(home, ".casper", "config.yaml"), "stalled_commands: off\n");
    expect(await load()).toMatchObject({ stalledCommands: false });
    await writeFile(path.join(project, ".casper", "project.yaml"), "stalled_commands: on\n");
    await expect(load()).rejects.toThrow("stalled_commands is a user setting");
  } finally { await removeTempDir(root); }
});
