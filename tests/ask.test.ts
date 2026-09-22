import { afterAll, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { InteractiveTerminal } from "../src/tui/terminal";
import { ASK_BUDGET, askTool, type AskChannel } from "../src/tui/ask";
import { formatTaskPrompt, underSpecifiedTarget } from "../src/task/classify";

// The rich-surface path is gated on `TERM !== "dumb"`; a harness or CI shell that
// exports TERM=dumb must not silently downgrade these fixtures to readline input.
const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const OPTIONS = [{ label: "SQLite", description: "file-based" }, { label: "Postgres" }];

/** Fake TTY writer whose `until` resolves on the first write that satisfies the predicate, no timers. */
function fakeWriter() {
  let output = "";
  let pending: { test: (output: string) => boolean; resolve: () => void } | undefined;
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30, write(text: string) {
    output += text;
    if (pending?.test(output)) { pending.resolve(); pending = undefined; }
  } });
  return {
    writer,
    get output() { return output; },
    until(test: (output: string) => boolean): Promise<void> {
      if (test(output)) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      pending = { test, resolve };
      return promise;
    },
  };
}

function interactiveTerminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const terminal = new InteractiveTerminal(input, screen.writer, () => {}, () => {});
  return { input, terminal, screen, close: () => { terminal.close(); input.destroy(); } };
}

test("an ask renders numbered options and a numeric reply resolves the labels", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask("Which database?", OPTIONS, false);
    await session.screen.until(output => output.includes("1. SQLite") && output.includes("file-based") && output.includes("2. Postgres"));
    session.input.write("2\r");
    expect(await answer).toEqual(["Postgres"]);
  } finally { session.close(); }
});

test("a non-numeric reply is a free-text answer", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask("Which database?", OPTIONS, false);
    await session.screen.until(output => output.includes("1. SQLite"));
    session.input.write("SQLite with litestream\r");
    expect(await answer).toEqual(["SQLite with litestream"]);
  } finally { session.close(); }
});

test("multi allows several numbers; a single-choice question rejects them", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const multi = session.terminal.ask("Pick layers?", OPTIONS, true);
    await session.screen.until(output => output.includes("Pick layers?"));
    session.input.write("1, 2\r");
    expect(await multi).toEqual(["SQLite", "Postgres"]);
    const single = session.terminal.ask("Pick one layer?", OPTIONS, false);
    await session.screen.until(output => output.includes("Pick one layer?"));
    session.input.write("1 2\r"); // Several numbers on a single-choice question keep it open.
    session.input.write("1\r");
    expect(await single).toEqual(["SQLite"]);
  } finally { session.close(); }
});

test("out-of-range, empty and malformed replies keep the question open", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask("Which database?", OPTIONS, false);
    await session.screen.until(output => output.includes("1. SQLite"));
    session.input.write("9\r");
    session.input.write("0\r");
    session.input.write("\r");
    session.input.write("1\r");
    expect(await answer).toEqual(["SQLite"]);
  } finally { session.close(); }
});

test("Escape skips the question", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask("Which database?", OPTIONS, false);
    await session.screen.until(output => output.includes("1. SQLite"));
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
    await session.screen.until(output => output.includes("1. SQLite"));
    controller.abort();
    expect(await answer).toBeUndefined();
  } finally { session.close(); }
});

test("Ctrl-C during a question skips it without ending the session", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.ask("Which database?", OPTIONS, false);
    await session.screen.until(output => output.includes("1. SQLite"));
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
    await session.screen.until(output => output.includes("1. SQLite"));
    session.input.write("\r"); // Empty Enter inside the question is not an answer.
    session.input.write("2\r");
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
    await screen.until(output => output.includes("1. SQLite"));
    terminal.close();
    expect(await answer).toBeUndefined();
  } finally { input.destroy(); }
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
