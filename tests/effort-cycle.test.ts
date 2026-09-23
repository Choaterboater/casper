import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

test("Shift+Tab while a command is in flight does not cycle and does not answer an approval", async () => {
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
    expect(cycles).toBe(0);
    expect(Bun.stripANSI(output)).toContain("effort unchanged · wait until idle");
    const approval = terminal.confirm("preview\n", "Type yes: ", undefined);
    input.write("\x1b[Z"); await tick();
    expect(cycles).toBe(0);
    input.write("yes\r");
    expect(await approval).toBe(true);
  } finally { terminal.close(); input.destroy(); }
});

test("interactive Shift+Tab selects auto then the next fixed level without saving", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-effort-cycle-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
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
    await until(text => Bun.stripANSI(text).includes("effort auto → high (pending) · session"));
    input.write("\x1b[Z");
    await until(text => Bun.stripANSI(text).includes("effort off · session"));
    expect(changes).toEqual([{ level: "auto", persist: false }, { level: "off", persist: false }]);
    input.write("\x04");
    expect(await Promise.race([interactive.then(() => "ended"), Bun.sleep(1000).then(() => "stuck")])).toBe("ended");
  } finally {
    await app.close();
    input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
