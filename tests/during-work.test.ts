import { afterAll, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { settleAppSteers, steerFromApp } from "../src/app/during-work";
import type { AgentRuntime, RuntimeEventListener, RuntimeImage, RuntimeSession, RuntimeStatus } from "../src/runtime/types";
import { runsDuringWork } from "../src/tui/commands";
import { duringTask } from "../src/tui/give-way";
import { TerminalSurface } from "../src/tui/surface";
import { richApp } from "./support/app";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

test("every command runs during a task, with any words after it; only the few that change what the task works on wait", () => {
  for (const line of ["/help", "/help all", "/status", "/usage", "/context", "/permissions", "/permissions all", "/permissions ask",
    "/permissions write ../shared", "/diff", "/diff 12", "/diff list", "/tasks", "/tasks stop 2", "/tasks stop all", "/details", "/details quiet",
    "/receipt", "/receipt 3", "/receipt list", "/output", "/output 2", "/output all", "/mcp", "/tree", "/project", "/sandbox", "/allowed",
    "/secrets", "/skills", "/lsp", "/effort", "/effort low", "/effort high --session", "/thinking low", "/cost", "/branch", "/hotkeys",
    "/pane", "/pane off", "/model", "/model --session", "/model fixture/other", "/model --session fixture/other", "/model @reason",
    "/model roles", "/model role fast x", "/model big x", "/model failover", "/model failover x y", "/model failover clear", "/copy", "/export", "/rename x", "/logout", "/login", "/login codex", "/theme",
    "/config", "/settings", "/mcp connect x", "/mcp writes on", "/sandbox forget h", "/allowed forget 1", "/allowed forget all",
    "/secrets files off", "/skills trust a b", "/lsp connect x", "/memory remember x", "/references add", "/visualize repo",
    "/browser open https://example.com", "/services start web", "/debug start app", "/lab import hosts.txt", "/suggestions off",
    "/verify add ansible", "/security-review update", "/crew drop 1", "/btw what is this", "/doctor", "/exit", "/quit"])
    expect([line, runsDuringWork(line)]).toEqual([line, true]);
  for (const line of ["/undo", "/undo 2", "/redo", "/clear", "/new", "/resume", "/resume abc", "/compact", "/compact keep it short",
    "/branch x", "/switch main", "/project other", "/project new", "/project new web app", "/plan add a flag", "/verify", "/verify test",
    "/verify repair", "/security-review", "/security-review ai", "/delegate explorer find it", "/crew", "/crew build it", "/crew apply 1",
    "/suggestion 2"])
    expect([line, runsDuringWork(line)]).toEqual([line, false]);
  // Not a command: never "runs" as one.
  expect(runsDuringWork("/bogus")).toBe(false);
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
    await app.until(text => text.includes("/undo waits until this task ends · draft kept · Esc stops the task"));
    gate.resolve();
  } finally { gate.resolve(); await app.close(); }
}, 30_000);

test("during a task: /permissions all takes effect at once, with no box, from the task's next question", async () => {
  const gate = Promise.withResolvers<void>();
  prompts.count = 0; prompts.started = false;
  const app = await richApp(() => workingRuntime(gate.promise, []));
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("write a poem\r");
    await app.until(() => prompts.started);
    app.input.write("/permissions all\r");
    await app.until(text => text.includes("The running task too, from its next question."));
    expect(app.app.stopAsking).toBe(true);
    expect(app.screen()).not.toContain("Stop asking until you quit?");
    expect(app.screen()).not.toContain("/permissions waits until this task ends");
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
    // A role mapping runs now too, as the command (it never changes the model in use): this runtime has no roles.
    app.input.write("/model role fast fixture/x\r");
    await app.until(text => text.includes("This runtime does not support model roles."));
    expect(selections).toHaveLength(4);
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

test("a question a command typed during a task opened closes for the task's approval or question, and says so", async () => {
  const { s, input, screen } = surface();
  try {
    s.start();
    // /settings typed during a task: its question is open when the task asks for an approval.
    const settings = duringTask(() => s.ask("Pick one to change:", [{ label: "Done" }, { label: "Theme" }], false));
    await Bun.sleep(20);
    const answer = s.approve("Reach example.com?\n", "Allow it?", [{ label: "No" }, { label: "Yes, this once" }]);
    expect(await settings).toBeUndefined();
    await Bun.sleep(100);
    expect(screen()).toContain("Pick one to change — closed for the task's question; type the command again");
    await Bun.sleep(400);
    input.write("2");
    expect(await answer).toBe("Yes, this once");
    // The AI's question closes it too.
    const again = duringTask(() => s.ask("Pick one to change:", [{ label: "Done" }, { label: "Theme" }], false));
    await Bun.sleep(20);
    const asked = s.ask("Which file?", [{ label: "a.ts" }, { label: "b.ts" }], false, undefined, "ai");
    expect(await again).toBeUndefined();
    await Bun.sleep(400);
    input.write("1");
    expect(await asked).toEqual(["a.ts"]);
    // A question asked outside a typed command (the task's own) is never closed by another.
    const own = s.ask("Fix it anyway?", [{ label: "No" }, { label: "Yes" }], false);
    await Bun.sleep(20);
    expect(await s.ask("Which file?", [{ label: "a.ts" }], false, undefined, "ai")).toBeUndefined();
    await Bun.sleep(400);
    input.write("2");
    expect(await own).toEqual(["Yes"]);
  } finally { s.close(); input.destroy(); }
});

test("a private box a command typed during a task opened (a key) is never closed: the task's approval waits for it", async () => {
  const { s, input } = surface();
  try {
    s.start();
    const typing = Promise.withResolvers<string>();
    const login = duringTask(() => s.exclusiveHost()!.run(() => typing.promise));
    await Bun.sleep(20);
    let shown = false;
    const answer = s.approve("Reach example.com?\n", "Allow it?", [{ label: "No" }, { label: "Yes, this once" }]).then((value) => { shown = true; return value; });
    await Bun.sleep(50);
    expect(shown).toBe(false);
    typing.resolve("key typed");
    expect(await login).toBe("key typed");
    await Bun.sleep(400);
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
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const app = await richApp(project => ({
    async start() {
      return {
        setTools: () => {},
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {},
        prompt: async () => {
          if (++turns === 1) {
            // The fixture's writes are its model's tool: a real model changes files only through its tools.
            emit({ type: "tool_start", toolName: "fixture_edit", toolCallId: `edit-${turns}` });
            await Bun.write(`${project}/notes.txt`, "changed\n");
            emit({ type: "tool_end", toolName: "fixture_edit", toolCallId: `edit-${turns}`, isError: false });
            return;
          }
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
    // The typed forms that change things run now too.
    const writesFrom = app.screen().length;
    app.input.write("/mcp writes off\r");
    await app.until(text => text.slice(writesFrom).includes("[mcp]"), 15_000);
    expect(app.screen().slice(writesFrom)).not.toContain("waits until this task ends");
    const doneFrom = app.screen().length;
    gate.resolve();
    await app.until(text => text.slice(doneFrom).includes("idle"), 15_000);
    const idleFrom = app.screen().length;
    app.input.write("/mcp\r");
    await app.until(text => text.slice(idleFrom).includes("Pick a server"), 15_000);
  } finally { gate.resolve(); await app.close(); }
}, 30_000);

/** An app with a runtime session that takes a steered line when `takes` says so, as `casper acp` holds one. */
function steeringApp(takes: (line: string, images?: readonly RuntimeImage[]) => boolean | Promise<boolean>, sees = true) {
  const written: string[] = [];
  const steered: Array<{ line: string; images?: readonly RuntimeImage[] }> = [];
  const app = new CasperApp({ output: { write(text) { written.push(text); } } });
  app.session = {
    setTools() {}, subscribe: () => () => {}, abort: async () => {}, prompt: async () => {},
    getState: () => ({ cwd: "", isStreaming: true }),
    getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const, images: sees }),
    steer: async (line: string, images?: readonly RuntimeImage[]) => { steered.push({ line, ...(images ? { images } : {}) }); return takes(line, images); },
  } satisfies RuntimeSession;
  return { app, written, steered };
}
const picture: RuntimeImage = { data: "aGVsbG8=", mimeType: "image/png" };

test("steerFromApp joins, steers or refuses without touching the queued lines", async () => {
  let taking = true;
  const { app, written, steered } = steeringApp(() => taking);
  app.queuedLines.push("a line typed in the terminal");
  let ended = 0;
  app.steerWaits.listen(() => { ended++; });
  // The model is working: the line goes to it, a step that only waits ends, and stderr says so.
  expect(await steerFromApp(app, "use port 8443")).toBe("steered");
  expect(app.steeredInTask).toEqual(["use port 8443"]);
  expect(ended).toBe(1);
  expect(written.join("")).toContain("↳ sent to Casper · it reads this when its current step ends");
  // Before the model's first turn the runtime takes nothing: the line joins the request.
  taking = false;
  app.beforeFirstModelTurn = true;
  expect(await steerFromApp(app, "and the docker network")).toBe("joined");
  expect(app.linesBeforeModel).toEqual(["and the docker network"]);
  expect(app.steeredInTask).toEqual(["use port 8443", "and the docker network"]);
  // A picture cannot join a request that has started: refused, and nothing is kept.
  expect(await steerFromApp(app, "look at [image 1]", [picture])).toBe("not_taken");
  // After the first turn, a line the runtime refuses is refused, and so is one whose steer fails.
  app.beforeFirstModelTurn = false;
  expect(await steerFromApp(app, "too late")).toBe("not_taken");
  const failing = steeringApp(() => { throw new Error("the runtime went away"); });
  expect(await steerFromApp(failing.app, "fails")).toBe("not_taken");
  expect(failing.app.steeredInTask).toEqual([]);
  // A closing Casper takes nothing and asks the runtime nothing.
  const closing = steeringApp(() => true);
  closing.app.closing = true;
  expect(await steerFromApp(closing.app, "late")).toBe("not_taken");
  expect(closing.steered).toEqual([]);
  expect(app.linesBeforeModel).toEqual(["and the docker network"]);
  expect(app.steeredInTask).toEqual(["use port 8443", "and the docker network"]);
  expect(app.queuedLines).toEqual(["a line typed in the terminal"]);
  expect(steered.map((entry) => entry.line)).toEqual(["use port 8443", "and the docker network", "look at [image 1]", "too late"]);
  expect(steered[2]!.images).toEqual([picture]);
});

test("steerFromApp sends a line without its pictures, with a note, to a model that can't see them", async () => {
  const { app, written, steered } = steeringApp(() => true, false);
  expect(await steerFromApp(app, "look at [image 1]", [picture])).toBe("steered");
  expect(steered).toEqual([{ line: "look at [image 1]" }]);
  expect(written.join("")).toContain("[image] This model can't see pictures; the AI gets your line without it.");
});

test("settleAppSteers resets the first-turn flag and drains unsent lines", () => {
  const { app } = steeringApp(() => true);
  let drained = 0;
  app.session!.takeUnsent = () => { drained++; return ["never read"]; };
  app.beforeFirstModelTurn = true;
  app.steering = ["waiting"];
  app.steeredInTask = ["waiting", "joined"];
  app.linesBeforeModel = ["joined"];
  app.queuedLines.push("held back");
  app.linePastes.set("held back", ["pasted"]);
  settleAppSteers(app);
  expect(drained).toBe(1);
  expect({ first: app.beforeFirstModelTurn, steering: app.steering, steered: app.steeredInTask, before: app.linesBeforeModel, queued: app.queuedLines, pastes: app.linePastes.size })
    .toEqual({ first: false, steering: [], steered: [], before: [], queued: [], pastes: 0 });
  // The next prompt starts clean even when the runtime has gone.
  app.session = undefined;
  app.queuedLines.push("again");
  settleAppSteers(app);
  expect(app.queuedLines).toEqual([]);
});
