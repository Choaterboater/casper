import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeStatus } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { effortChoices, nextEffort } from "../src/tui/effort";
import { InteractiveTerminal } from "../src/tui/terminal";
import { removeTempDir } from "./support/temp-dir";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const WAIT_MS = process.platform === "win32" ? 15_000 : 4_000;
const INTERACTIVE_MS = process.platform === "win32" ? 90_000 : 30_000;

// Runtime callbacks can change state without writing another frame. Poll the expectation,
// not just output events (the "building" frame can arrive before prompt() is called).
async function waitFor(check: () => boolean, details: () => string = () => check.toString()): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting: ${details()}`);
    await Bun.sleep(20);
  }
}

test("effort ring always offers auto and wraps from the highest supported level", () => {
  expect(effortChoices(["high", "off", "low"])).toEqual(["auto", "off", "low", "high"]);
  expect(effortChoices(["off", "minimal", "low", "medium", "high", "xhigh", "max", "custom"]))
    .toEqual(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max", "custom"]);
  expect(nextEffort("high", ["off", "low", "medium", "high"])).toBe("auto");
  expect(nextEffort("auto", ["off", "low", "medium", "high"])).toBe("off");
  expect(nextEffort("low", ["off", "low", "medium", "high"])).toBe("medium");
  expect(nextEffort("xhigh", ["off", "high", "xhigh", "max"])).toBe("max");
  expect(nextEffort("max", ["high", "max"])).toBe("auto");
  // One level: auto could only pick it, so there is nothing to cycle (no "[effort] automatic classification unavailable").
  expect(nextEffort(undefined, ["high"])).toBeUndefined();
  expect(nextEffort("off", ["off"])).toBeUndefined();
  expect(nextEffort("missing", ["low", "high"])).toBe("auto");
  expect(nextEffort("auto", [])).toBeUndefined();
  expect(nextEffort("off", undefined)).toBeUndefined();
});

test("Shift+Tab cycles effort without inserting the key into the draft", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  const cycled: number[] = [];
  const terminal = new InteractiveTerminal(input, { isTTY: true, columns: 80, rows: 24, write: text => { output += text; } }, () => {}, () => {});
  terminal.setEffortCycle(() => { cycled.push(1); });
  try {
    terminal.setStatus("fixture"); terminal.start();
    const reading = terminal.readCommand();
    input.write("keep");
    await waitFor(() => Bun.stripANSI(output).includes("keep"));
    input.write("\x1b[Z");
    await waitFor(() => cycled.length === 1);
    input.write("draft\r");
    expect(await reading).toBe("keepdraft");
    expect(cycled).toEqual([1]);
    expect(Bun.stripANSI(output)).not.toContain("effort unchanged");
  } finally { terminal.close(); input.destroy(); }
});

test("Shift+Tab while a command is in flight cycles (the next step uses it), but never during an approval", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  let cycles = 0;
  const terminal = new InteractiveTerminal(input, { isTTY: true, columns: 80, rows: 24, write: text => { output += text; } }, () => {}, () => {});
  terminal.setEffortCycle(() => { cycles++; });
  try {
    terminal.setStatus("fixture"); terminal.start();
    const pending = terminal.readCommand();
    input.write("work\r");
    expect(await pending).toBe("work");
    input.write("\x1b[Z");
    await waitFor(() => cycles === 1);
    const approval = terminal.approve("preview\n", "Do it?", ["No", "Yes"]);
    input.write("\x1b[Z");
    await waitFor(() => Bun.stripANSI(output).includes("effort unchanged · answer first"));
    expect(cycles).toBe(1);
    input.write("2");
    expect(await approval).toBe("Yes");
  } finally { terminal.close(); input.destroy(); }
});

test("Enter while a command is in flight: a command the app runs now clears the box; anything else keeps the draft and says why", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  const asked: string[] = [];
  const terminal = new InteractiveTerminal(input, { isTTY: true, columns: 80, rows: 24, write: text => { output += text; } }, () => {}, () => {});
  terminal.setBusySubmit((line) => { asked.push(line); return line === "/status" ? true : `${line.split(" ")[0]} waits until this task ends · draft kept`; });
  try {
    terminal.setStatus("fixture"); terminal.start();
    const pending = terminal.readCommand();
    input.write("work\r");
    expect(await pending).toBe("work");
    input.write("/status\r");
    await waitFor(() => asked.length === 1);
    input.write("/undo\r");
    await waitFor(() => Bun.stripANSI(output).includes("/undo waits until this task ends · draft kept"));
    expect(asked).toEqual(["/status", "/undo"]);
    const screen = Bun.stripANSI(output);
    expect(screen).toContain("❯ /status");
    expect(screen).toContain("/undo waits until this task ends · draft kept");
    // The kept draft is sent once Casper is idle again.
    const next = terminal.readCommand();
    input.write("\r");
    expect(await next).toBe("/undo");
  } finally { terminal.close(); input.destroy(); }
});

test("Ctrl+C cancels the effort picker instead of arming exit behind it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-effort-cancel-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true }); await writeFile(path.join(project, "notes.txt"), "An empty folder would ask about a new project.\n");
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: (): RuntimeStatus => ({ provider: "fixture", model: "demo", auth: "configured", thinkingLevel: "high", configuredEffort: "high", availableThinkingLevels: ["off", "low", "medium", "high"] }),
        setEffort: async (level: string, _persist: boolean) => ({ provider: "fixture", model: "demo", auth: "configured", thinkingLevel: level === "auto" ? "high" : level, configuredEffort: level, availableThinkingLevels: ["off", "low", "medium", "high"] }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async () => {},
      };
    },
    async dispose() {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  let pending: { test: (output: string) => boolean; resolve: () => void } | undefined;
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30, write(text: string) {
    output += text;
    if (pending?.test(output)) { pending.resolve(); pending = undefined; }
  } });
  const until = (test: (output: string) => boolean) => {
    if (test(output)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    pending = { test, resolve };
    return promise;
  };
  const app = new CasperApp({
    input, output: writer, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  void app.runInteractive(project);
  try {
    await until(text => Bun.stripANSI(text).includes("idle"));
    const beforePicker = output.length;
    input.write("/effort\r");
    await until(text => Bun.stripANSI(text).includes("Reasoning effort"));
    input.write("\x03");
    await until((text) => Bun.stripANSI(text).slice(beforePicker).includes("idle"));
    // The picker dismissed without the exit-arming note and without ending the session.
    expect(Bun.stripANSI(output).slice(beforePicker)).not.toContain("Ctrl+C again to exit");
    // Prove input is still live rather than sleeping and checking that it has not exited.
    const beforeHelp = output.length;
    input.write("/help\r");
    await until(text => Bun.stripANSI(text.slice(beforeHelp)).includes("/effort"));
  } finally {
    await app.close();
    input.destroy();
    await removeTempDir(root);
  }
}, INTERACTIVE_MS);

test("interactive Shift+Tab steps through levels and saves the one it settles on, once, like /effort", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-effort-cycle-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true }); await writeFile(path.join(project, "notes.txt"), "An empty folder would ask about a new project.\n");
  const changes: { level: string; persist: boolean }[] = [];
  let status: RuntimeStatus = {
    provider: "fixture", model: "demo", auth: "configured", thinkingLevel: "high", configuredEffort: "high",
    availableThinkingLevels: ["off", "low", "medium", "high"],
  };
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => status,
        setEffort: async (level: string, persist: boolean) => {
          changes.push({ level, persist });
          status = { ...status, configuredEffort: level, thinkingLevel: level === "auto" ? "high" : level,
            autoEffort: level === "auto" ? { state: "pending" } : undefined };
          return status;
        },
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async () => {},
      };
    },
    async dispose() {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  let pending: { test: (output: string) => boolean; resolve: () => void } | undefined;
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30, write(text: string) {
    output += text;
    if (pending?.test(output)) { pending.resolve(); pending = undefined; }
  } });
  const until = (test: (output: string) => boolean) => {
    if (test(output)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    pending = { test, resolve };
    return promise;
  };
  const app = new CasperApp({
    input, output: writer, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  try {
    await until(text => Bun.stripANSI(text).includes("idle"));
    input.write("\x1b[Z");
    await until(text => Bun.stripANSI(text).includes("effort auto → high for now; your next request picks the level · saved"));
    input.write("\x1b[Z");
    await until(text => Bun.stripANSI(text).includes("effort off · saved"));
    expect(changes).toEqual([{ level: "auto", persist: false }, { level: "auto", persist: true }, { level: "off", persist: false }, { level: "off", persist: true }]);
    // Presses in quick succession step through levels and save only where they stop.
    changes.length = 0;
    input.write("\x1b[Z\x1b[Z");
    await until(text => Bun.stripANSI(text).includes("effort medium · saved"));
    expect(changes).toEqual([{ level: "low", persist: false }, { level: "medium", persist: false }, { level: "medium", persist: true }]);
    // Separately polled presses may rest long enough to save intermediate levels on a busy host.
    changes.length = 0;
    const before = Bun.stripANSI(output).split("effort off · saved").length;
    for (const level of ["high", "auto", "off"]) {
      input.write("\x1b[Z");
      await waitFor(() => changes.some(change => change.level === level && !change.persist));
    }
    await until(text => Bun.stripANSI(text).split("effort off · saved").length > before);
    expect(changes.filter(change => !change.persist)).toEqual([{ level: "high", persist: false }, { level: "auto", persist: false }, { level: "off", persist: false }]);
    expect(changes.at(-1)).toEqual({ level: "off", persist: true });
    input.write("\x04");
    let ended = false;
    void interactive.then(() => { ended = true; });
    await waitFor(() => ended);
  } finally {
    await app.close();
    input.destroy();
    await removeTempDir(root);
  }
}, INTERACTIVE_MS);

test("during a running task: /usage runs, Shift+Tab and /effort apply from the next step, /undo waits, and input still works after", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-during-work-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true }); await writeFile(path.join(project, "notes.txt"), "An empty folder would ask about a new project.\n");
  const changes: { level: string; persist: boolean }[] = [];
  let status: RuntimeStatus = { provider: "fixture", model: "demo", auth: "configured", thinkingLevel: "high", configuredEffort: "high",
    availableThinkingLevels: ["off", "low", "medium", "high"] };
  const gate = Promise.withResolvers<void>();
  const prompts: string[] = [];
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => status,
        setEffort: async (level: string, persist: boolean) => {
          changes.push({ level, persist });
          status = { ...status, configuredEffort: level, thinkingLevel: level };
          return status;
        },
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: () => () => {},
        abort: async () => {},
        setTools: () => {},
        prompt: async (text: string) => { prompts.push(text); if (prompts.length === 1) await gate.promise; },
      };
    },
    async dispose() {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 30, write(text: string) { output += text; } });
  const until = (test: (output: string) => boolean) => waitFor(() => test(output),
    () => `${test.toString().slice(0, 120)}; prompts ${prompts.length}; screen: ${Bun.stripANSI(output).slice(-600)}`);
  const app = new CasperApp({
    input, output: writer, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  const screen = () => Bun.stripANSI(output);
  try {
    await until(text => Bun.stripANSI(text).includes("idle"));
    input.write("write a poem\r");
    await until(() => prompts.length === 1 && screen().includes("working"));
    input.write("/usage\r");
    await until(() => screen().includes("Usage:"));
    input.write("\x1b[Z");
    await until(() => /\[effort\] .+ from the model's next step; saved/.test(screen()));
    expect(changes).toEqual([{ level: "auto", persist: false }, { level: "auto", persist: true }]);
    // One short line; the footer keeps the short form too ("auto → high", never the "for now" note).
    expect(screen()).toMatch(/\[effort\] auto → \S+ from the model's next step; saved/);
    expect(screen()).not.toContain("for now; your");
    input.write("/effort low --session\r");
    await until(() => screen().includes("[effort] low from the model's next step (this conversation)"));
    input.write("/undo\r");
    await until(() => screen().includes("/undo waits until this task ends · draft kept"));
    expect(prompts).toHaveLength(1);
    expect(changes.at(-1)).toEqual({ level: "low", persist: false });
    gate.resolve();
    await until(() => screen().lastIndexOf("idle") > screen().lastIndexOf("draft kept"));
    // The session still takes input once the task ends: the next line starts the next task.
    input.write("\x15say ok\r");
    await until(() => prompts.length === 2 && prompts[1]!.includes("say ok"));
    await until(() => screen().lastIndexOf("idle") > screen().lastIndexOf("❯ say ok"));
    input.write("\x04");
    let ended = false;
    void interactive.then(() => { ended = true; });
    await waitFor(() => ended);
  } finally {
    await app.close();
    input.destroy();
    await removeTempDir(root);
  }
}, INTERACTIVE_MS);

test("while Casper is still opening the project, Enter keeps the draft and says so (no task is running)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-opening-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true }); await writeFile(path.join(project, "notes.txt"), "An empty folder would ask about a new project.\n");
  const loading = Promise.withResolvers<void>();
  let loadingStarted = false;
  const runtime: AgentRuntime = { async start() { throw new Error("no model in this test"); }, async dispose() {} };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 30, write(text: string) { output += text; } });
  const until = (test: (output: string) => boolean) => waitFor(() => test(output),
    () => `screen: ${Bun.stripANSI(output).slice(-600)}`);
  const app = new CasperApp({
    input, output: writer, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: async info => { loadingStarted = true; await loading.promise; return loadProjectContext(info, { homeDir: home }); },
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  try {
    await waitFor(() => loadingStarted);
    input.write("hello\r");
    await until(text => Bun.stripANSI(text).includes("draft kept · Enter again once Casper has opened the project"));
    expect(Bun.stripANSI(output)).not.toContain("this task ends");
    loading.resolve();
    await until(text => Bun.stripANSI(text).includes("idle"));
    input.write("\x15\x04");
    let ended = false;
    void interactive.then(() => { ended = true; });
    await waitFor(() => ended);
  } finally {
    await app.close();
    input.destroy();
    await removeTempDir(root);
  }
}, INTERACTIVE_MS);
