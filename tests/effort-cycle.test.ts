import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeStatus } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { effortChoices, nextEffort } from "../src/tui/effort";
import { InteractiveTerminal } from "../src/tui/terminal";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const tick = () => new Promise(resolve => setTimeout(resolve, 90));

test("effort ring always offers auto and wraps from the highest supported level", () => {
  expect(effortChoices(["high", "off", "low"])).toEqual(["auto", "off", "low", "high"]);
  expect(effortChoices(["off", "minimal", "low", "medium", "high", "xhigh", "max", "custom"]))
    .toEqual(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max", "custom"]);
  expect(nextEffort("high", ["off", "low", "medium", "high"])).toBe("auto");
  expect(nextEffort("auto", ["off", "low", "medium", "high"])).toBe("off");
  expect(nextEffort("low", ["off", "low", "medium", "high"])).toBe("medium");
  expect(nextEffort("xhigh", ["off", "high", "xhigh", "max"])).toBe("max");
  expect(nextEffort("max", ["high", "max"])).toBe("auto");
  expect(nextEffort(undefined, ["high"])).toBe("auto");
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
    await tick();
    input.write("keep"); await tick();
    input.write("\x1b[Z"); await tick();
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
    input.write("\x1b[Z"); await tick();
    expect(cycles).toBe(1);
    const approval = terminal.confirm("preview\n", "Type yes: ", undefined);
    input.write("\x1b[Z"); await tick();
    expect(cycles).toBe(1);
    expect(Bun.stripANSI(output)).toContain("effort unchanged · answer first");
    input.write("yes\r");
    expect(await approval).toBe(true);
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
    input.write("/status\r"); await tick();
    input.write("/undo\r"); await tick();
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
        setEffort: async (level: string, persist: boolean) => ({ provider: "fixture", model: "demo", auth: "configured", thinkingLevel: level === "auto" ? "high" : level, configuredEffort: level, availableThinkingLevels: ["off", "low", "medium", "high"] }),
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
    const beforePicker = output.length;
    input.write("/effort\r");
    await until(text => Bun.stripANSI(text).includes("Reasoning effort"));
    input.write("\x03");
    await until((text) => Bun.stripANSI(text).slice(beforePicker).includes("idle"));
    // The picker dismissed without the exit-arming note and without ending the session.
    expect(Bun.stripANSI(output).slice(beforePicker)).not.toContain("Ctrl-C again to exit");
    // Liveness race: no deterministic signal exists for "still interactive", so a short real
    // wait guards that the session did not end (same pattern as the Shift+Tab test below).
    expect(await Promise.race([interactive.then(() => "ended"), Bun.sleep(500).then(() => "alive")])).toBe("alive");
  } finally {
    await app.close();
    input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

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
    await until(text => Bun.stripANSI(text).includes("effort auto → high for now; your first request picks the level · saved"));
    input.write("\x1b[Z");
    await until(text => Bun.stripANSI(text).includes("effort off · saved"));
    expect(changes).toEqual([{ level: "auto", persist: false }, { level: "auto", persist: true }, { level: "off", persist: false }, { level: "off", persist: true }]);
    // Presses in quick succession step through levels and save only where they stop.
    changes.length = 0;
    input.write("\x1b[Z\x1b[Z");
    await until(text => Bun.stripANSI(text).includes("effort medium · saved"));
    expect(changes).toEqual([{ level: "low", persist: false }, { level: "medium", persist: false }, { level: "medium", persist: true }]);
    input.write("\x04");
    expect(await Promise.race([interactive.then(() => "ended"), Bun.sleep(1000).then(() => "stuck")])).toBe("ended");
  } finally {
    await app.close();
    input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

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
        prompt: async (text: string) => { prompts.push(text); if (prompts.length === 1) await gate.promise; },
      };
    },
    async dispose() {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  let pending: { test: (output: string) => boolean; resolve: () => void } | undefined;
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 30, write(text: string) {
    output += text;
    if (pending?.test(output)) { pending.resolve(); pending = undefined; }
  } });
  const until = (test: (output: string) => boolean) => {
    if (test(output)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    pending = { test, resolve };
    const seen = ["Usage:", "from the next step", "[effort]", "draft kept", "waits until"].filter(text => Bun.stripANSI(output).includes(text));
    return Promise.race([promise, Bun.sleep(4000).then(() => { throw new Error(`timed out waiting for ${test.toString().slice(0, 120)}; seen: ${seen.join(", ")}; prompts ${prompts.length}`); })]);
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
    await until(() => screen().includes("❯ say ok"));
    input.write("\x04");
    expect(await Promise.race([interactive.then(() => "ended"), Bun.sleep(3000).then(() => "stuck")])).toBe("ended");
  } finally {
    await app.close();
    input.destroy();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
