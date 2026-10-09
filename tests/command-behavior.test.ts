import { afterAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRuntime, RuntimeModelSelectionOptions, RuntimeStatus } from "../src/runtime/types";
import { canonicalLine, COMMAND_REGISTRY, menuRunsDuringWork, runsDuringWork, sessionFlag } from "../src/tui/commands";
import { effortProblem } from "../src/tui/effort";
import { FULL_HELP_TEXT } from "../src/tui/help";
import { richApp } from "./support/app";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

/** A model that works until `gate` opens, with the effort levels of a typical reasoning model. */
function fixtureRuntime(gate: Promise<void>, seen: { started: boolean; efforts: { level: string; persist: boolean }[]; models: RuntimeModelSelectionOptions[] }): AgentRuntime {
  let status: RuntimeStatus = { provider: "fixture", model: "demo", auth: "configured", thinkingLevel: "high", configuredEffort: "high",
    availableThinkingLevels: ["off", "low", "medium", "high"] };
  const stopped = Promise.withResolvers<void>();
  return {
    async start() {
      return {
        setTools: () => {},
        getStatus: () => status,
        setEffort: async (level: string, persist: boolean) => { seen.efforts.push({ level, persist }); status = { ...status, configuredEffort: level, thinkingLevel: level }; return status; },
        selectModel: async (options) => {
          seen.models.push({ ...(options.query ? { query: options.query } : {}), persist: options.persist });
          status = { ...status, model: options.query?.split("/")[1] ?? status.model };
          return { status, selected: true, savedDefault: options.persist !== false };
        },
        getState: () => ({ cwd: "", isStreaming: true }),
        subscribe: () => () => {},
        // Stopping the task ends its request, as Pi's abort does.
        abort: async () => { stopped.resolve(); },
        prompt: async () => { seen.started = true; await Promise.race([gate, stopped.promise]); },
      };
    },
    async dispose() {},
  };
}

function seen() { return { started: false, efforts: [] as { level: string; persist: boolean }[], models: [] as RuntimeModelSelectionOptions[] }; }

/** The screen's words with its line wrapping and spacing undone. */
const flat = (text: string) => text.replace(/\s+/g, " ");

/** Types a line and waits for `expected` to show after it (wrapping ignored); returns what showed, unwrapped. */
async function typed(app: Awaited<ReturnType<typeof richApp>>, line: string, expected: string): Promise<string> {
  const from = app.screen().length;
  app.input.write(`${line}\r`);
  await app.until(text => flat(text.slice(from)).includes(flat(expected)));
  return flat(app.screen().slice(from));
}

test("/login takes the short names /help uses; another word is an [error] Usage line", () => {
  expect(canonicalLine("/login openai-codex")).toBe("/login codex");
  expect(canonicalLine("/login github-copilot")).toBe("/login copilot");
  expect(FULL_HELP_TEXT).toContain("/login [codex|copilot|anthropic|openrouter]");
});

test("one verb takes things back: forget, with remove as the same word; list is the command alone", () => {
  expect(canonicalLine("/memory remove abc")).toBe("/memory forget abc");
  expect(canonicalLine("/allowed remove 2")).toBe("/allowed forget 2");
  expect(canonicalLine("/sandbox remove example.com")).toBe("/sandbox forget example.com");
  expect(canonicalLine("/permissions remove ../shared")).toBe("/permissions forget ../shared");
  expect(canonicalLine("/mcp remove nope")).toBe("/mcp forget nope");
  expect(canonicalLine("/pack forget tools")).toBe("/pack remove tools");
  for (const name of ["memory", "allowed", "sandbox", "mcp"]) {
    expect(canonicalLine(`/${name} list`)).toBe(`/${name}`);
    expect(runsDuringWork(`/${name} list`)).toBe(true);
  }
  // A word after list is no list: the command's own usage error says so.
  expect(canonicalLine("/memory list x")).toBe("/memory list x");
  // Taking something back runs during a task too, whichever word is typed.
  for (const line of ["/memory remove abc", "/allowed remove 2", "/mcp remove nope"]) expect([line, runsDuringWork(line)]).toEqual([line, true]);
});

test("--session goes before or after the value", () => {
  expect(sessionFlag("high --session")).toEqual({ rest: "high", session: true });
  expect(sessionFlag("--session high")).toEqual({ rest: "high", session: true });
  expect(sessionFlag("high")).toEqual({ rest: "high", session: false });
  expect(sessionFlag("--session --session")).toEqual({ rest: "--session --session", session: false });
  for (const line of ["/effort --session low", "/effort low --session", "/model fixture/x --session", "/model --session fixture/x",
    "/details --session quiet", "/details quiet --session"]) expect([line, runsDuringWork(line)]).toEqual([line, true]);
});

test("/effort names the model's own levels, and a level the model lacks is not set", () => {
  const status = { provider: "fixture", model: "fixture", availableThinkingLevels: ["off"] };
  expect(effortProblem("bogus", status)).toBe("Unknown effort bogus. Choose: auto, off");
  expect(effortProblem("high", status)).toBe("fixture/fixture doesn't support effort high. Choose: auto, off");
  expect(effortProblem("auto", status)).toBeUndefined();
  expect(effortProblem("off", status)).toBeUndefined();
  // Levels unknown (a runtime that does not say): only a word that is no level at all is refused.
  expect(effortProblem("high", undefined)).toBeUndefined();
  expect(effortProblem("bogus", undefined)).toContain("Unknown effort bogus");
});

test("the help says what /branch and /switch do: only /switch main apply|discard asks", () => {
  const branch = COMMAND_REGISTRY.find((command) => command.name === "branch")!;
  const switching = COMMAND_REGISTRY.find((command) => command.name === "switch")!;
  expect(branch.description).not.toContain("asks first");
  expect(switching.description).not.toContain("requires approval");
  const row = (start: string) => FULL_HELP_TEXT.split("\n").find((line) => line.trimStart().startsWith(start))!;
  expect(row("/branch <name>")).not.toContain("(asks first)");
  expect(row("/switch <branch>")).not.toContain("(asks first)");
  expect(row("/switch main apply")).toContain("asks first");
  expect(FULL_HELP_TEXT).not.toContain("/branch, /switch and making or removing a workspace ask you first.");
});

test("during a task, the bare forms that only show something run now and the menu does not dim them", async () => {
  for (const name of ["browser", "services", "debug", "lab", "memory", "references", "visualize", "doctor", "exit", "quit"]) {
    expect([name, runsDuringWork(`/${name}`), menuRunsDuringWork(name)]).toEqual([name, true, true]);
  }
  // What they change runs now too.
  for (const line of ["/browser open https://example.com", "/services start web", "/debug start app", "/lab import hosts.txt",
    "/memory remember x", "/references add", "/visualize repo"]) expect([line, runsDuringWork(line)]).toEqual([line, true]);
  const gate = Promise.withResolvers<void>();
  const state = seen();
  const app = await richApp(() => fixtureRuntime(gate.promise, state));
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("write a poem\r");
    await app.until(() => state.started);
    for (const [line, expected] of [["/browser", '"state"'], ["/services", "[services] No services declared"], ["/lab", "Lab devices: none"],
      ["/memory", "[memory] No remembered facts"], ["/references", "[references] None yet"], ["/visualize", "providers:"],
      ["/debug", '"targets"'], ["/doctor", "Casper doctor · no model, no tokens"]] as const) {
      const shown = await typed(app, line, expected);
      expect([line, shown]).not.toEqual([line, expect.stringContaining("waits until this task ends")]);
    }
    gate.resolve();
  } finally { gate.resolve(); await app.close(); }
}, 60_000);

test("/exit during a task stops it and leaves, as Ctrl+C twice does", async () => {
  for (const word of ["exit", "quit"]) {
    const gate = Promise.withResolvers<void>();
    const state = seen();
    const app = await richApp(() => fixtureRuntime(gate.promise, state));
    try {
      await app.until(text => text.includes("idle"));
      app.input.write("write a poem\r");
      await app.until(() => state.started);
      await typed(app, `/${word}`, "[exit] Stopping this task and leaving Casper.");
      // The session ends without the task finishing: the gate never opened.
      await app.interactive;
      expect(app.app.closing).toBe(true);
      expect(app.screen()).not.toContain(`/${word} waits until this task ends`);
    } finally { gate.resolve(); await app.close(); }
  }
}, 60_000);

test("idle: usage errors say [error] Usage: …, the same way for every command", async () => {
  const gate = Promise.withResolvers<void>();
  const app = await richApp(() => fixtureRuntime(gate.promise, seen()));
  try {
    await app.until(text => text.includes("idle"));
    for (const [line, usage] of [["/login bogus", "Usage: /login [codex|copilot|anthropic|openrouter]"], ["/suggestions bogus", "Usage: /suggestions [on|off]"],
      ["/skills bogus", "Usage: /skills | /skills diagnostics"], ["/pack bogus", "Usage: /pack add"], ["/diff bogus", "Usage: /diff [task number | list]"],
      ["/undo bogus", "Usage: /undo [task number]"], ["/receipt bogus", "Usage: /receipt [task number | list]"], ["/tasks bogus", "Usage: /tasks | /tasks stop <n>"],
      ["/lab bogus", "Usage: /lab | /lab import <file>"], ["/allowed bogus", "Usage: /allowed | /allowed forget"],
      ["/permissions bogus", "Usage: /permissions [details] | /permissions all|ask"], ["/sandbox bogus", "Usage: /sandbox | /sandbox forget <host>"],
      ["/memory bogus", "Usage: /memory |"], ["/preview bogus", "Usage: /preview | /preview stop"]] as const) {
      const shown = await typed(app, line, usage);
      expect([line, shown]).toEqual([line, expect.stringContaining(`[error] ${usage}`)]);
      expect([line, shown]).not.toEqual([line, expect.stringContaining("[tasks] Nothing is running")]);
    }
  } finally { gate.resolve(); await app.close(); }
}, 60_000);

test("idle: remove and list work as forget and the bare command", async () => {
  const gate = Promise.withResolvers<void>();
  const app = await richApp(() => fixtureRuntime(gate.promise, seen()));
  try {
    await app.until(text => text.includes("idle"));
    await typed(app, "/memory remember the build needs node 22", "[memory] Remembered: the build needs node 22.");
    const id = /\/memory forget (\S+) removes it/.exec(flat(app.screen()))![1]!;
    await typed(app, "/memory list", "[memory] 1 remembered fact");
    await typed(app, `/memory remove ${id}`, `[memory] Forgot ${id}.`);
    await typed(app, "/memory list", "[memory] No remembered facts");
    // Forget ran (no such server here), not the usage line.
    expect(await typed(app, "/mcp remove nope", "[error] Unknown MCP server")).not.toContain("Usage:");
    await typed(app, "/allowed list", "Nothing is allowed yet.");
  } finally { gate.resolve(); await app.close(); }
}, 60_000);

test("idle: /details alone shows the level and saves nothing; --session goes before or after", async () => {
  const gate = Promise.withResolvers<void>();
  const state = seen();
  const app = await richApp(() => fixtureRuntime(gate.promise, state));
  const config = path.join(app.home, ".casper", "config.yaml");
  try {
    await app.until(text => text.includes("idle"));
    let shown = await typed(app, "/details", "[details] normal: steps fold into one summary line");
    expect(shown).toContain("/details quiet or detailed changes it");
    expect(await readFile(config, "utf8").catch(() => "")).not.toContain("display");
    shown = await typed(app, "/details --session quiet", "[details] quiet:");
    expect(shown).toContain("For this session only.");
    await typed(app, "/details", "[details] quiet:");
    expect(await readFile(config, "utf8").catch(() => "")).not.toContain("display");
    await typed(app, "/details --session", "[error] Usage: /details [quiet|normal|detailed] [--session]");
    await typed(app, "/effort --session low", "effort low");
    await typed(app, "/effort medium --session", "effort medium");
    expect(state.efforts).toEqual([{ level: "low", persist: false }, { level: "medium", persist: false }]);
    await typed(app, "/model fixture/other --session", "[model] Selected for this conversation only");
    expect(state.models.at(-1)).toEqual({ query: "fixture/other", persist: false });
  } finally { gate.resolve(); await app.close(); }
}, 60_000);

test("idle and during a task: /effort refuses a word that is no level, and a level the model lacks", async () => {
  const gate = Promise.withResolvers<void>();
  const state = seen();
  const app = await richApp(() => fixtureRuntime(gate.promise, state));
  try {
    await app.until(text => text.includes("idle"));
    await typed(app, "/effort bogus", "[error] Unknown effort bogus. Choose: auto, off, low, medium, high");
    await typed(app, "/effort xhigh", "[error] fixture/demo doesn't support effort xhigh. Choose: auto, off, low, medium, high");
    app.input.write("write a poem\r");
    await app.until(() => state.started);
    await typed(app, "/effort max --session", "[error] fixture/demo doesn't support effort max.");
    expect(state.efforts).toEqual([]);
    gate.resolve();
  } finally { gate.resolve(); await app.close(); }
}, 60_000);

test("/project alone is /status: one summary", async () => {
  const gate = Promise.withResolvers<void>();
  const app = await richApp(() => fixtureRuntime(gate.promise, seen()));
  try {
    await app.until(text => text.includes("idle"));
    const end = "(a copy is made before each task; /undo, /diff)";
    const status = await typed(app, "/status", end);
    const project = await typed(app, "/project", end);
    for (const row of [" project project ", " skills ", " mcp 0 configured", " checks ", " undo no copies yet"]) {
      expect([row, project.includes(row), status.includes(row)]).toEqual([row, true, true]);
    }
  } finally { gate.resolve(); await app.close(); }
}, 60_000);
