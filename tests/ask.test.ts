import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { InteractiveTerminal } from "../src/tui/terminal";
import { fakeWriter, interactiveTerminal } from "./support/tty";
import { ASK_BUDGET, askTool, type AskChannel } from "../src/tui/ask";
import { formatTaskPrompt, underSpecifiedTarget } from "../src/task/classify";

// The rich-surface path is gated on `TERM !== "dumb"`; a harness or CI shell that
// exports TERM=dumb must not silently downgrade these fixtures to readline input.
const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const OPTIONS = [{ label: "SQLite", description: "file-based" }, { label: "Postgres" }];

test("an ask shows a standalone question and Up/Down selects an option", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask("Which database?", OPTIONS, false);
    await session.screen.until(output => output.includes("Which database?") && output.includes("SQLite") && output.includes("Postgres"));
    const visible = Bun.stripANSI(session.screen.output);
    expect(visible).toMatch(/Which database\?[^\r\n]*\r?\n→ SQLite/);
    expect(visible).not.toContain("1. SQLite");
    session.input.write("\x1b[B\r");
    const result = await Promise.race([answer, new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 250))]);
    expect(result).toEqual(["Postgres"]);
  } finally { session.close(); }
});

test("a non-numeric reply is a free-text answer", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask("Which database?", OPTIONS, false);
    await session.screen.until(output => output.includes("SQLite"));
    session.input.write("SQLite with litestream\r");
    expect(await answer).toEqual(["SQLite with litestream"]);
  } finally { session.close(); }
});

test("Up/Down and Enter select one option; Space toggles multiple options", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const multi = session.terminal.ask("Pick layers?", OPTIONS, true);
    await session.screen.until(output => output.includes("Pick layers?") && output.includes("[ ] SQLite"));
    session.input.write(" ");
    await session.screen.until(output => output.includes("[x] SQLite"));
    session.input.write("\x1b[B");
    session.input.write(" \r");
    expect(await multi).toEqual(["SQLite", "Postgres"]);
    const single = session.terminal.ask("Pick one layer?", OPTIONS, false);
    await session.screen.until(output => output.includes("Pick one layer?"));
    session.input.write("\x1b[B\r");
    expect(await single).toEqual(["Postgres"]);
  } finally { session.close(); }
});

test("arrow navigation wraps and Enter chooses the highlighted option", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask("Which database?", OPTIONS, false);
    await session.screen.until(output => output.includes("Which database?") && output.includes("SQLite"));
    session.input.write("\x1b[B");
    session.input.write("\x1b[B\r");
    expect(await answer).toEqual(["SQLite"]);
  } finally { session.close(); }
});

test("Escape skips the question", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask("Which database?", OPTIONS, false);
    await session.screen.until(output => output.includes("SQLite"));
    session.input.write("\x1b");
    expect(await answer).toBeUndefined();
  } finally { session.close(); }
});

test("abort resolves the pending question as skipped", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const controller = new AbortController();
    const answer = session.terminal.ask("Which database?", OPTIONS, false, controller.signal);
    await session.screen.until(output => output.includes("SQLite"));
    controller.abort();
    expect(await answer).toBeUndefined();
  } finally { session.close(); }
});

test("Ctrl-C during a question skips it without ending the session", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask("Which database?", OPTIONS, false);
    await session.screen.until(output => output.includes("SQLite"));
    session.input.write("\x03");
    expect(await answer).toBeUndefined();
    const command = session.terminal.readCommand();
    session.input.write("hi\r");
    expect(await command).toBe("hi");
  } finally { session.close(); }
});

test("a pretyped draft is never consumed as an answer and survives the question", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const command = session.terminal.readCommand();
    session.input.write("partial");
    await session.screen.until(output => output.includes("partial"));
    const answer = session.terminal.ask("Which database?", OPTIONS, false);
    await session.screen.until(output => output.includes("SQLite"));
    session.input.write("\x1b[B\r");
    expect(await answer).toEqual(["Postgres"]);
    session.input.write("\r");
    expect(await command).toBe("partial");
  } finally { session.close(); }
});

test("closing the terminal resolves a pending question as skipped", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const terminal = new InteractiveTerminal(input, screen.writer, () => {}, () => {});
  try {
    terminal.setStatus("fixture"); terminal.start();
    const answer = terminal.ask("Which database?", OPTIONS, false);
    await screen.until(output => output.includes("SQLite"));
    terminal.close();
    expect(await answer).toBeUndefined();
  } finally { input.destroy(); }
});

const REPAINT = "\x1b[2J\x1b[H\x1b[3J";
/** The screen as last fully repainted (a width change forces one), without styling. */
const lastFrame = (output: string) => Bun.stripANSI(output.split(REPAINT).at(-1)!).split("\r\n");

test("a long question and long options wrap in full at 60 columns, below the model's lead-in", async () => {
  const question = "Which storage backend should the rate limiter use for its counters in production, given that you run several API instances behind a load balancer and want limits to hold across all of them even during a deploy?";
  const options = [
    { label: "Redis (shared, survives instance restarts, needs a running server)", description: "Counters live in Redis with an expiring key per window; every instance sees the same counts." },
    { label: "In-memory per instance", description: "No new dependency, but each instance counts on its own, so the effective limit is multiplied by the instance count." },
    { label: "Postgres", description: "file-based" },
  ];
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    session.terminal.write("Two backends fit; the choice changes the deploy.\n");
    const answer = session.terminal.ask(question, options, false);
    await session.screen.until(output => output.includes("skip"));
    session.screen.writer.columns = 60; session.screen.writer.emit("resize");
    await session.screen.until(() => session.screen.output.split(REPAINT).length > 1 && lastFrame(session.screen.output).some(line => line.includes("skip")));
    const frame = lastFrame(session.screen.output);
    for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    // The panel follows the transcript instead of covering its tail.
    expect(frame).toContain("Two backends fit; the choice changes the deploy.");
    const panel = frame.slice(frame.findIndex(line => line.startsWith("Which storage")), frame.findIndex(line => line.includes("skip")));
    const text = panel.join(" ").replace("→", " ").replace(/\s+/g, " ");
    expect(text).toContain(question);
    for (const option of options) expect(text).toContain(`${option.label} ${option.description}`);
    session.input.write("\x1b[B\r");
    expect(await answer).toEqual([options[1]!.label]);
  } finally { session.close(); }
});

test("a question taller than the screen stays on screen: only the highlighted option keeps its description", async () => {
  const question = "Which of these five approaches should the change take?";
  const options = Array.from({ length: 5 }, (_, index) => ({ label: `Option ${index + 1}`,
    description: `Explanation ${index + 1} of what this choice changes, long enough to wrap onto more rows at sixty columns.` }));
  const session = interactiveTerminal();
  const repaint = async (columns: number) => {
    const repaints = session.screen.output.split(REPAINT).length;
    session.screen.writer.columns = columns; session.screen.writer.rows = 20; session.screen.writer.emit("resize");
    await session.screen.until(() => session.screen.output.split(REPAINT).length > repaints && lastFrame(session.screen.output).some(line => line.includes("skip")));
    // The rows a 20-row terminal shows: the frame's last 20 lines.
    return lastFrame(session.screen.output).slice(-20).map(line => line.trimEnd());
  };
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask(question, options, false);
    await session.screen.until(output => output.includes("skip"));
    let visible = await repaint(60);
    expect(visible).toContain(question);
    expect(visible.join(" ").replace(/\s+/g, " ")).toContain(`→ Option 1 ${options[0]!.description}`);
    expect(visible).toContain("  Option 2");
    expect(visible.join(" ")).not.toContain("Explanation 2");
    session.input.write("\x1b[B");
    visible = await repaint(61);
    expect(visible).toContain(question);
    expect(visible.join(" ").replace(/\s+/g, " ")).toContain(`→ Option 2 ${options[1]!.description}`);
    expect(visible.join(" ")).not.toContain("Explanation 1");
    session.input.write("\r");
    expect(await answer).toEqual(["Option 2"]);
  } finally { session.close(); }
});

test("an asked question is recorded on its own line, not appended to the running ask tool line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-ask-record-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home, { recursive: true }); await mkdir(project, { recursive: true });
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
  let tools: RuntimeTool[] = [];
  const runtime: AgentRuntime = {
    start: async options => {
      tools = options.tools ?? [];
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        setTools: next => { tools = next; },
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        abort: async () => {},
        prompt: async () => {
          emit({ type: "tool_start", toolName: "ask", toolCallId: "ask-1" });
          const result = await tools.find(tool => tool.name === "ask")!.execute({ question: "Which database?", options: OPTIONS });
          emit({ type: "tool_end", toolName: "ask", toolCallId: "ask-1", isError: Boolean(result.isError) });
          emit({ type: "message_end" });
        },
      };
    },
    dispose: async () => {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const app = new CasperApp({
    input, output: screen.writer, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  try {
    await screen.until(output => output.includes("idle"));
    input.write("pick a database\r");
    await screen.until(output => output.includes("Which database?"));
    input.write("\r");
    await screen.until(output => output.includes("ask — completed") && output.includes("idle"));
    const repaints = screen.output.split(REPAINT).length;
    screen.writer.columns = 90; screen.writer.emit("resize");
    await screen.until(() => screen.output.split(REPAINT).length > repaints && lastFrame(screen.output).some(line => line.includes("ask — completed")));
    const frame = lastFrame(screen.output);
    const running = frame.findIndex(line => line.startsWith("• ask — running"));
    expect(frame.slice(running, running + 6)).toEqual(["• ask — running", "Which database?", "• SQLite  file-based", "• Postgres", "[ask] SQLite", expect.stringMatching(/^✓ ask — completed/)]);
  } finally {
    input.write("/exit\r");
    await interactive;
    await app.close();
    input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

/** Recording channel stub for the tool-level contract. */
function stubChannel(available: boolean, answers: (string[] | undefined)[]): { channel: AskChannel; records: string[] } {
  const records: string[] = [];
  let call = 0;
  return {
    records,
    channel: {
      available: () => available,
      ask: async () => answers[Math.min(call++, answers.length - 1)],
      record: answer => { records.push(answer); },
    },
  };
}

test("the ask tool degrades to a structured skip outside interactive sessions", async () => {
  const { channel } = stubChannel(false, []);
  const tool = askTool(channel);
  const result = await tool.execute({ question: "Which?", options: [{ label: "A" }, { label: "B" }] });
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.text)).toMatchObject({ skipped: true });
});

test("the ask tool reports answers and remaining budget, then enforces the cap", async () => {
  const stub = stubChannel(true, [["Postgres"]]);
  const tool = askTool(stub.channel);
  const args = { question: "Which database?", options: OPTIONS, multi: false };
  for (let index = 0; index < ASK_BUDGET; index++) {
    const result = await tool.execute(args);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toEqual({ answers: ["Postgres"], skipped: false, remaining: ASK_BUDGET - index - 1 });
  }
  expect(stub.records).toEqual(Array(ASK_BUDGET).fill("Postgres"));
  const exhausted = await tool.execute(args);
  expect(exhausted.isError).toBe(true);
  expect(JSON.parse(exhausted.text)).toMatchObject({ skipped: true, reason: expect.stringContaining("budget") });
});

test("the ask tool rejects malformed questions without consuming budget", async () => {
  const stub = stubChannel(true, [["A"]]);
  const tool = askTool(stub.channel);
  const malformed = [
    { question: "  ", options: OPTIONS },
    { question: "Which?", options: [{ label: "A" }] },
    { question: "Which?", options: [{ label: "  " }, { label: "B" }] },
    { options: OPTIONS },
  ];
  for (const args of malformed) {
    const result = await tool.execute(args);
    expect(result.isError).toBe(true);
  }
  const result = await tool.execute({ question: "Which?", options: OPTIONS });
  expect(JSON.parse(result.text)).toEqual({ answers: ["A"], skipped: false, remaining: ASK_BUDGET - 1 });
});

test("under-specification probes for explicit targets, not incidental dots and quotes", () => {
  expect(underSpecifiedTarget("build me a REST API for this project")).toBe(true);
  expect(underSpecifiedTarget("add support for e.g. webhooks and retries")).toBe(true);
  expect(underSpecifiedTarget("bump the version to 0.2.10 everywhere")).toBe(true);
  expect(underSpecifiedTarget("update src/app.ts to route the ask tool")).toBe(false);
  expect(underSpecifiedTarget("rename the `formatCurrency` export")).toBe(false);
  expect(underSpecifiedTarget("extend the \"order\" service with a second constructor")).toBe(false);
});

test("an under-specified modify request carries the clarification hint, others do not", () => {
  const model = { commands: {} } as never;
  const vague = formatTaskPrompt("build me a REST API", { intent: "implement", mode: "modify", verification: [] }, model);
  expect(vague).toContain("under-specified");
  const targeted = formatTaskPrompt("add a retry to src/app.ts", { intent: "implement", mode: "modify", verification: [] }, model);
  expect(targeted).not.toContain("under-specified");
  const inspection = formatTaskPrompt("find the largest module", { intent: "inspect", mode: "read", verification: [] }, model);
  expect(inspection).not.toContain("under-specified");
});
