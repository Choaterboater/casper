import { afterAll, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { AgentRuntime, RuntimeStatus } from "../src/runtime/types";
import { runsDuringWork } from "../src/tui/commands";
import { TerminalSurface } from "../src/tui/surface";
import { richApp } from "./support/app";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

test("commands that only show something run during a task; ones that change things wait", () => {
  for (const line of ["/help", "/help all", "/status", "/usage", "/context", "/permissions", "/diff", "/diff 12", "/diff list",
    "/tasks", "/tasks stop 2", "/tasks stop all", "/details", "/details quiet", "/receipt", "/receipt 3", "/receipt list",
    "/output", "/output 2", "/output all", "/mcp", "/tree", "/project", "/sandbox", "/allowed", "/secrets", "/skills", "/lsp",
    "/effort", "/effort low", "/effort high --session", "/thinking low", "/cost", "/branch", "/hotkeys", "/pane", "/pane off",
    "/model", "/model --session", "/model fixture/other", "/model --session fixture/other", "/model @reason", "/model roles"]) expect([line, runsDuringWork(line)]).toEqual([line, true]);
  for (const line of ["/undo", "/redo", "/clear", "/new", "/branch x", "/copy", "/export", "/rename x", "/logout", "/theme", "/config", "/resume", "/model role fast x", "/model big x", "/model a b", "/mcp connect x", "/mcp writes on", "/sandbox forget h", "/allowed forget 1", "/allowed forget all",
    "/secrets files off", "/skills trust a b", "/lsp connect x", "/project other", "/compact", "/verify", "/details loud"])
    expect([line, runsDuringWork(line)]).toEqual([line, false]);
});

const prompts = { count: 0, started: false };
function workingRuntime(gate: Promise<void>, changes: { level: string; persist: boolean }[]): AgentRuntime {
  let status: RuntimeStatus = { provider: "fixture", model: "demo", auth: "configured", thinkingLevel: "high", configuredEffort: "high",
    availableThinkingLevels: ["off", "low", "medium", "high"] };
  return {
    async start() {
      return {
        setTools: () => {},
        getStatus: () => status,
        setEffort: async (level: string, persist: boolean) => { changes.push({ level, persist }); status = { ...status, configuredEffort: level, thinkingLevel: level }; return status; },
        getState: () => ({ cwd: "", isStreaming: false }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async () => { if (++prompts.count === 1) { prompts.started = true; await gate; } },
      };
    },
    async dispose() {},
  };
}

test("during a task: /project and /tasks run, a bare /effort opens its picker, /undo waits", async () => {
  const gate = Promise.withResolvers<void>();
  const changes: { level: string; persist: boolean }[] = [];
  const app = await richApp(() => workingRuntime(gate.promise, changes));
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("write a poem\r");
    await app.until(() => prompts.started);
    app.input.write("/tasks\r");
    await app.until(text => text.includes("Nothing is running in the background"));
    app.input.write("/details detailed\r");
    await app.until(text => text.includes("[details] detailed"));
    app.input.write("/effort\r");
    await app.until(text => text.includes("Reasoning effort"));
    app.input.write("\x1b[A\r"); // Up from high picks medium.
    await app.until(() => changes.length > 0);
    expect(changes).toEqual([{ level: "medium", persist: true }]);
    // /thinking is the peers' name for /effort: it runs now, as /effort does.
    app.input.write("/thinking low --session\r");
    await app.until(text => text.includes("[effort] low from the model's next step (this conversation)"));
    expect(changes.at(-1)).toEqual({ level: "low", persist: false });
    app.input.write("/undo\r");
    await app.until(text => text.includes("/undo waits until this task ends"));
    gate.resolve();
  } finally { gate.resolve(); await app.close(); }
}, 30_000);

test("during a task: /model <id> and the /model picker apply from the model's next step, and say so", async () => {
  const gate = Promise.withResolvers<void>();
  const selections: Array<{ query?: string; persist?: boolean; picker: boolean }> = [];
  let status: RuntimeStatus = { provider: "fixture", model: "demo", auth: "configured" };
  let started = false;
  const runtime: AgentRuntime = {
    async start() {
      return {
        setTools: () => {},
        getStatus: () => status,
        selectModel: async (options) => {
          selections.push({ query: options.query, persist: options.persist, picker: Boolean(options.picker) });
          // The picker: the person picks "picked" in it.
          const [provider, id] = options.picker ? ["fixture", await options.picker.mount(async () => "picked")] : options.query!.split("/");
          status = { ...status, provider: provider!, model: id! };
          return { status, selected: true, savedDefault: options.persist !== false };
        },
        getState: () => ({ cwd: "", isStreaming: true }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async () => { started = true; await gate.promise; },
      };
    },
    async dispose() {},
  };
  const app = await richApp(() => runtime);
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("write a poem\r");
    await app.until(() => started);
    app.input.write("/model fixture/other\r");
    // One line; the same provider gets the context as before, so it says nothing about where the context goes.
    await app.until(text => text.includes("[model] fixture/other from the model's next step; saved"));
    expect(app.screen()).not.toMatch(/context (?:goes|to fixture)/);
    app.input.write("/model cloud/big\r");
    await app.until(text => text.includes("[model] cloud/big from the model's next step; saved · this conversation's context goes to cloud"));
    app.input.write("/model --session fixture/third\r");
    await app.until(text => text.includes("[model] fixture/third from the model's next step (this conversation)"));
    app.input.write("/model\r");
    await app.until(text => text.includes("[model] fixture/picked from the model's next step; saved"));
    expect(selections).toEqual([{ query: "fixture/other", persist: true, picker: false }, { query: "cloud/big", persist: true, picker: false }, { query: "fixture/third", persist: false, picker: false },
      { query: undefined, persist: true, picker: true }]);
    app.input.write("/model role fast fixture/x\r");
    await app.until(text => text.includes("/model waits until this task ends"));
    gate.resolve();
  } finally { gate.resolve(); await app.close(); }
}, 30_000);

function surface() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  const s = new TerminalSurface({ input, output: { write: (text: string) => { output += text; }, columns: 100, rows: 30 }, color: false, onEOF: () => {} }, () => {}, () => {});
  return { s, input, screen: () => Bun.stripANSI(output) };
}

test("an approval that arrives while a picker is open closes the picker and asks", async () => {
  const { s, input } = surface();
  try {
    s.start();
    const yielded = new AbortController();
    const host = s.exclusiveHost({ onYield: () => yielded.abort() })!;
    const picked = host.mount(view => new Promise<string>(resolve => {
      view.show({ render: () => ["PICKER"], invalidate() {} });
      yielded.signal.addEventListener("abort", () => resolve("yielded"));
    }));
    await Bun.sleep(20);
    const answer = s.approve("Reach example.com?\n", "Allow it?", [{ label: "No" }, { label: "Yes, this once" }]);
    expect(await picked).toBe("yielded");
    await Bun.sleep(20);
    input.write("2");
    expect(await answer).toBe("Yes, this once");
  } finally { s.close(); input.destroy(); }
});

test("while working, typing / still shows the commands, and the ones that wait say so", async () => {
  const { s, input, screen } = surface();
  try {
    s.start();
    s.setStatus("project │ working", process.cwd());
    const command = s.readCommand();
    input.write("go\r");
    await command;
    input.write("/un");
    await Bun.sleep(150);
    expect(screen()).toContain("undo");
    expect(screen()).toContain("waits for this task");
  } finally { s.close(); input.destroy(); }
});

test("a command description too long for the menu ends at a word with …, never mid-word", async () => {
  const { fitDescriptions } = await import("../src/tui/commands");
  const items = [{ value: "model", label: "model", description: "Change model (remembered globally; --session for temporary)" }, { value: "exit", label: "exit", description: "Leave Casper" }];
  // 60 columns: the label column is 12 wide, so 60 - 2 - 12 - 2 = 44 columns are left for the description.
  const [model, exit] = fitDescriptions(items, 60);
  expect(model!.description).toBe("Change model (remembered globally; …");
  expect(model!.description!.length).toBeLessThanOrEqual(44);
  expect(exit!.description).toBe("Leave Casper");
  expect(fitDescriptions(items, 200)).toEqual(items);
});

test("a subcommand label too wide for the menu's column ends with …, never cut mid-bracket with no mark", async () => {
  const { findCommand, fitDescriptions, subcommandItems } = await import("../src/tui/commands");
  const items = subcommandItems(findCommand("model")!, "")!;
  // The column is at most 32 wide with 2 of margin: 30 columns for a label.
  const labels = fitDescriptions(items, 100).map((item) => item.label);
  expect(labels).toContain("role <fast|build|reason|…");
  expect(labels).toContain("big <selector|clear>");
  for (const label of labels) expect(label!.length).toBeLessThanOrEqual(30);
  // A dimmed label (during a task) is cut by columns with its colour kept.
  const [dim] = fitDescriptions([{ value: "role ", label: `\x1b[2m${"role <fast|build|reason|review> <selector|clear>"}\x1b[22m`, description: "x" }], 100);
  expect(Bun.stripANSI(dim!.label!)).toEndWith("…");
  expect(Bun.stripANSI(dim!.label!).length).toBeLessThanOrEqual(30);
});

test("/diff list during a task prints the list with no picker, so nothing sits in the way of a box the task opens", async () => {
  const gate = Promise.withResolvers<void>();
  let turns = 0, second = false;
  const app = await richApp(project => ({
    async start() {
      return {
        setTools: () => {},
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async () => {
          if (++turns === 1) { await Bun.write(`${project}/notes.txt`, "changed\n"); return; }
          second = true; await gate.promise;
        },
      };
    },
    async dispose() {},
  }));
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("change the notes\r");
    // The first task ends in about a second here; a loaded Windows CI runner was still on it ("working · 3s") when
    // the 4 s default ran out, so the waits that span a task get more time.
    await app.until(text => text.includes("Show diff"), 15_000);
    app.input.write("tidy up\r");
    await app.until(() => second, 15_000);
    const from = app.screen().length;
    app.input.write("/diff list\r");
    await app.until(text => text.slice(from).includes("/diff <task number> shows one."), 15_000);
    expect(app.screen().slice(from)).toContain("Task 1 · ");
    expect(app.screen().slice(from)).not.toContain("Show the changes of which task?");
    gate.resolve();
  } finally { gate.resolve(); await app.close(); }
}, 30_000);

test("/mcp during a task prints the list with its command hints and no picker, so a box the task opens is shown; idle it opens the picker", async () => {
  const gate = Promise.withResolvers<void>();
  let turns = 0, started = false;
  const app = await richApp(project => ({
    async start() {
      return {
        setTools: () => {},
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async () => { if (++turns === 1) { started = true; await gate.promise; } },
      };
    },
    async dispose() {},
  }), { loadMCPConfiguration: async () => ({ diagnostics: [], servers: [{ name: "demo-server", source: "fixture", cwd: process.cwd(), disabled: false,
    transport: { type: "stdio", command: "never-run-fixture", args: [], env: {} } }] }) });
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("keep working\r");
    await app.until(() => started, 15_000);
    const from = app.screen().length;
    app.input.write("/mcp\r");
    await app.until(text => text.slice(from).includes("/mcp connect demo-server"), 15_000);
    expect(app.screen().slice(from)).not.toContain("Pick a server");
    // Nothing holds the question slot: an approval the task asks is shown and can be answered.
    const answer = app.app.terminal.approve("Reach example.com?\n", "Allow it?", [{ label: "No" }, { label: "Yes, this once" }]);
    await app.until(text => text.slice(from).includes("Allow it?"), 15_000);
    await Bun.sleep(400);
    app.input.write("2");
    expect(await answer).toBe("Yes, this once");
    // The typed forms that change things still wait for the task.
    app.input.write("/mcp disconnect demo-server\r");
    await app.until(text => text.slice(from).includes("waits until this task ends"), 15_000);
    const doneFrom = app.screen().length;
    gate.resolve();
    await app.until(text => text.slice(doneFrom).includes("idle"), 15_000);
    // The refused line stayed as a draft; clear it, then ask for the list again.
    app.input.write("\x15");
    await Bun.sleep(100);
    const idleFrom = app.screen().length;
    app.input.write("/mcp\r");
    await app.until(text => text.slice(idleFrom).includes("Pick a server"), 15_000);
  } finally { gate.resolve(); await app.close(); }
}, 30_000);
