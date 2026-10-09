import { afterAll, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { CasperApp } from "../src/app";
import { handlePrompt, handleSlashCommand } from "../src/app/command-loop";
import type { AgentRuntime } from "../src/runtime/types";
import { COMMAND_REGISTRY, COMMANDS, menuRunsDuringWork, runsAfterCleanupError, runsDuringWork, takesArguments } from "../src/tui/commands";
import { commandProblem, FULL_HELP_TEXT, unknownCommandMessage } from "../src/tui/help";
import { TerminalSurface } from "../src/tui/surface";
import { richApp } from "./support/app";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

/** An app that fails the moment a handler touches it: the line got past the checks and reached its handler. */
const REACHED = new Error("reached the handler");
function touchyApp(fields: Record<string, unknown> = {}, { sets = "throw" }: { sets?: "throw" | "keep" } = {}): CasperApp {
  return new Proxy({}, {
    get: (_target, key) => {
      if (key === "then") return undefined;
      if (typeof key === "string" && Object.hasOwn(fields, key)) return fields[key];
      throw REACHED;
    },
    // handlePrompt's first write comes right after the cleanup check; a handler that keeps its work promise may write.
    set: (_target, key, value) => {
      if (sets === "throw") throw REACHED;
      if (typeof key === "string") fields[key] = value;
      return true;
    },
  }) as CasperApp;
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try { await run(); return "ran"; } catch (error) { return error === REACHED ? "reached" : (error as Error).message; }
}

test("every command in the table has a handler, and a name not in the table never reaches one", async () => {
  for (const command of COMMAND_REGISTRY) {
    for (const name of [command.name, ...command.aliases ?? []]) {
      const result = await outcome(() => handleSlashCommand(touchyApp({ closing: false }, { sets: "keep" }), `/${name}`));
      expect([name, result.startsWith("Unknown command")]).toEqual([name, false]);
    }
  }
  expect(await outcome(() => handleSlashCommand(touchyApp(), "/bogus"))).toBe(unknownCommandMessage("/bogus"));
});

test("every subcommand in the table is in /help all", () => {
  const rows = FULL_HELP_TEXT.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("/"));
  const missing: string[] = [];
  for (const command of COMMAND_REGISTRY.filter((entry) => !entry.hidden)) {
    // The words of each row's usage column for this command: "/debug continue <thread>|stop" holds continue and stop.
    const words = new Set(rows.filter((row) => row.startsWith(`/${command.name} `) || row === `/${command.name}`)
      .flatMap((row) => row.split(/ {2,}/)[0]!.split(/[\s|[\]<>]+/)));
    for (const sub of command.subcommands ?? []) {
      if (!words.has(sub.name) && !FULL_HELP_TEXT.includes(`/${command.name} ${sub.name}`)) missing.push(`/${command.name} ${sub.name}`);
    }
  }
  expect(missing).toEqual([]);
});

test("a command that takes nothing after its name says so; it never asks whether you meant itself", () => {
  for (const line of ["/settings 3", "/settings extra", "/status x", "/context extra", "/usage extra", "/doctor extra", "/clear extra",
    "/exit now", "/quit now", "/tree x"]) {
    const name = line.split(" ")[0]!;
    expect(commandProblem(line)).toBe(`Usage: ${name}, with nothing after it.`);
    expect(unknownCommandMessage(name)).not.toContain(`Did you mean ${name}?`);
  }
  for (const line of ["/settings", "/status", "/quit", "/mcp detail", "/diff 3", "/plan add a flag"]) expect(commandProblem(line)).toBeUndefined();
  expect(commandProblem("/bogus")).toBe(unknownCommandMessage("/bogus"));
  expect(commandProblem("/qiut")).toContain("Did you mean /quit?");
  // No hint and no subcommands means no words after the name: the table says which.
  expect(COMMAND_REGISTRY.filter((command) => !takesArguments(command)).map((command) => command.name))
    .toEqual(["status", "context", "usage", "clear", "settings", "theme", "hotkeys", "doctor", "exit", "tree"]);
});

test("the menu dims exactly what waits during work: the same table as the check that runs the line", () => {
  for (const command of COMMAND_REGISTRY) {
    expect([command.name, menuRunsDuringWork(command.name)]).toEqual([command.name, runsDuringWork(`/${command.name}`)]);
    for (const sub of command.subcommands ?? []) {
      if (sub.args) continue;
      const line = `/${command.name} ${sub.name}`;
      expect([line, menuRunsDuringWork(command.name, sub.name)]).toEqual([line, runsDuringWork(line)]);
    }
  }
  for (const line of ["/mcp detail", "/skills diagnostics", "/model role fast fixture/fixture", "/model big clear"]) expect([line, runsDuringWork(line)]).toEqual([line, false]);
  expect(runsDuringWork("/quit")).toBe(false);
});

test("after a failed cleanup, /doctor and what only shows something still run; requests and changes wait for it", async () => {
  const cleanupError = new Error("A process Casper started may still be running.");
  const allowed = ["/doctor", "/status", "/help", "/help mcp", "/context", "/usage", "/secrets", "/skills", "/tree", "/receipt", "/output",
    "/sandbox", "/allowed", "/permissions", "/mcp", "/lsp", "/browser", "/browser close", "/debug stop", "/tasks", "/tasks stop 1",
    "/services logs web", "/services stop web", "/mcp disconnect a", "/exit", "/quit"];
  const blocked = ["fix the bug", "/undo", "/clear", "/mcp connect a", "/browser open https://example.com", "/services start web", "/verify",
    "/sandbox forget example.com", "/allowed forget 1", "/secrets files off", "/bogus"];
  for (const line of allowed) expect([line, runsAfterCleanupError(line)]).toEqual([line, true]);
  for (const line of blocked) expect([line, runsAfterCleanupError(line)]).toEqual([line, false]);
  for (const line of [...allowed, ...blocked]) {
    const result = await outcome(() => handlePrompt(touchyApp({ closing: false, commandActive: false, cleanupError }), line));
    expect([line, result]).toEqual([line, allowed.includes(line) ? "reached" : cleanupError.message]);
  }
});

function surface() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  const s = new TerminalSurface({ input, output: { write: (text: string) => { output += text; }, columns: 100, rows: 30 }, color: false, onEOF: () => {} }, () => {}, () => {});
  return { s, input, screen: () => Bun.stripANSI(output), mark: () => output.length, since: (from: number) => Bun.stripANSI(output.slice(from)) };
}

test("the menu lists /quit, completes a command's subcommands, and shows what follows a name", async () => {
  expect(COMMANDS.find((command) => command.name === "quit")?.description).toBe("Leave Casper (same as /exit)");
  const { s, input, mark, since } = surface();
  try {
    s.start();
    s.setStatus("project │ idle", process.cwd());
    const submitted = s.readCommand();
    let from = mark();
    input.write("/q");
    await Bun.sleep(150);
    expect(since(from)).toContain("quit");
    input.write("\x7fmcp ");
    from = mark();
    await Bun.sleep(150);
    for (const entry of ["detail [name]", "connect <name>", "writes <name>|off", "reload"]) expect(since(from)).toContain(entry);
    input.write("de");
    await Bun.sleep(150);
    input.write("\t");
    await Bun.sleep(50);
    input.write("\r");
    expect((await submitted)?.trim()).toBe("/mcp detail");
  } finally { s.close(); input.destroy(); }
});

test("while working, the subcommands that wait are dimmed in the menu, the same as the commands", async () => {
  const { s, input, mark, since } = surface();
  try {
    s.start();
    s.setStatus("project │ working", process.cwd());
    const command = s.readCommand();
    input.write("go\r");
    await command;
    let from = mark();
    input.write("/pane ");
    await Bun.sleep(150);
    expect(since(from)).toContain("on");
    expect(since(from)).not.toContain("waits for this task");
    input.write("\x15/mcp ");
    from = mark();
    await Bun.sleep(150);
    expect(since(from)).toMatch(/detail \[name\]\s+waits for this task/);
  } finally { s.close(); input.destroy(); }
});

function slowRuntime(gate: Promise<void>, started: () => void): AgentRuntime {
  return {
    async start() {
      return {
        setTools: () => {},
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: "", isStreaming: true }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async () => { started(); await gate; },
      };
    },
    async dispose() {},
  };
}

test("idle and during work, /settings 3 is a usage error and an unknown command is rejected at once", async () => {
  const gate = Promise.withResolvers<void>();
  let started = false;
  const app = await richApp(() => slowRuntime(gate.promise, () => { started = true; }));
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("/settings 3\r");
    await app.until(text => text.includes("Usage: /settings, with nothing after it."));
    expect(app.screen()).not.toContain("Did you mean /settings?");
    app.input.write("write a poem\r");
    await app.until(() => started);
    let from = app.screen().length;
    app.input.write("/bogus\r");
    await app.until(text => text.slice(from).includes('Unknown command "/bogus".'));
    expect(app.screen().slice(from)).not.toContain("waits until this task ends");
    from = app.screen().length;
    app.input.write("/status x\r");
    await app.until(text => text.slice(from).includes("Usage: /status, with nothing after it."));
    gate.resolve();
  } finally { gate.resolve(); await app.close(); }
}, 30_000);

test("only /exit and /quit leave: the word exit typed without the / goes to the AI", async () => {
  const gate = Promise.withResolvers<void>();
  let started = false;
  const app = await richApp(() => slowRuntime(gate.promise, () => { started = true; }));
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("exit\r");
    await app.until(() => started);
    gate.resolve();
  } finally { gate.resolve(); await app.close(); }
}, 30_000);
