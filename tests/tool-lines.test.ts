import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { RuntimeEventView, stepSummary } from "../src/app/events";
import { commandLabel, formatToolActivity } from "../src/tui/format";
import { InteractiveTerminal } from "../src/tui/terminal";
import { SPEND_STOP_REASON } from "../src/task/spend";
import type { RuntimeEvent } from "../src/runtime/types";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

/** A terminal that records the main screen and the Working box apart. */
function fakeTerminal(rich: boolean) {
  const screen: string[] = [];
  let box: string[] | undefined;
  let text = "";
  const terminal = {
    rich, columns: 100,
    setActivity(status?: string | readonly string[]) { box = status === undefined ? undefined : typeof status === "string" ? [status] : [...status]; },
    endAssistant() { if (text) { screen.push(...text.split("\n").filter(Boolean)); text = ""; } },
    assistant(delta: string) { text += delta; },
    write(value: string) { screen.push(...value.split("\n").filter(Boolean)); },
  };
  const output = { write: (value: string) => terminal.write(value) };
  const view = new RuntimeEventView(terminal as unknown as InteractiveTerminal, output, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
    projectRoot: () => "/work/app",
  });
  return { view, screen, get box() { return box; }, handle: (...events: RuntimeEvent[]) => { for (const event of events) view.handle(event); } };
}

const start = (id: string, toolName: string, input: Record<string, string>): RuntimeEvent => ({ type: "tool_start", toolName, toolCallId: id, input });
const end = (id: string, toolName: string, input: Record<string, string>, isError = false, output?: string): RuntimeEvent =>
  ({ type: "tool_end", toolName, toolCallId: id, input, isError, ...(output ? { output: { text: output, truncated: false } } : {}) });

test("a shell command shows as its program and target, at most 80 characters", () => {
  expect(commandLabel("git status")).toBe("git status");
  expect(commandLabel("cd mist-tools && python3 -m pytest -q tests/test_x.py")).toBe("python3 -m pytest …");
  expect(commandLabel("ssh -p 22 -i key root@10.0.0.5 'systemctl restart demoapp'")).toBe("ssh root@10.0.0.5 …");
  expect(commandLabel("FOO=1 sudo /usr/bin/pvesh get /nodes")).toBe("pvesh get …");
  expect(commandLabel("ls")).toBe("ls");
  // sshpass's password is never the label's target.
  expect(commandLabel("sshpass -p 'hunter2' ssh -o StrictHostKeyChecking=no root@10.0.0.5 'pvesh get /nodes'")).toBe("ssh root@10.0.0.5 …");
  expect(commandLabel("sshpass -phunter2 scp a.txt root@lab:/tmp")).toBe("scp a.txt …");
  const long = commandLabel(`cat ${"a".repeat(200)}`);
  expect([...long].length).toBeLessThanOrEqual(80);
  expect(long.endsWith("…")).toBe(true);
});

test("tool lines drop 'completed' and durations under a second", () => {
  const input = { command: "npm test -- --watch=false" };
  expect(formatToolActivity({ type: "tool_start", toolName: "bash", input })).toBe("• bash · npm test …");
  expect(formatToolActivity({ type: "tool_end", toolName: "bash", input, isError: false }, 400)).toBe("✓ bash · npm test …");
  expect(formatToolActivity({ type: "tool_end", toolName: "bash", input, isError: false }, 4200)).toBe("✓ bash · npm test … · 4.2s");
  expect(formatToolActivity({ type: "tool_end", toolName: "bash", input, isError: false }, 125_000)).toBe("✓ bash · npm test … · 2m05s");
  expect(formatToolActivity({ type: "tool_end", toolName: "bash", input, isError: true }, 10)).toBe("✗ bash · npm test … — failed");
});

test("rich terminal: parallel tools with text between print one line each, never a running line", () => {
  const t = fakeTerminal(true);
  t.handle(start("a", "bash", { command: "git status" }), start("b", "read", { path: "/work/app/src/x.ts" }));
  expect(t.box).toEqual(["• bash · git status", "• read · src/x.ts"]);
  t.handle(end("a", "bash", { command: "git status" }));
  expect(t.box).toEqual(["✓ bash · git status", "• read · src/x.ts"]);
  expect(t.screen).toEqual([]);
  t.handle({ type: "assistant_text_delta", delta: "Looking.\n" });
  t.handle(end("b", "read", { path: "/work/app/src/x.ts" }), { type: "message_end" });
  expect(t.screen).toEqual(["✓ bash · git status", "Looking.", "✓ read · src/x.ts"]);
  expect(t.screen.some(line => line.startsWith("•") || line.includes("completed") || line.includes("running"))).toBe(false);
  expect(t.box).toBeUndefined();
});

test("rich terminal: the Working box keeps the last 3 steps, then folds them into one summary line", () => {
  const t = fakeTerminal(true);
  const edit = { path: "/work/app/a.py" };
  t.handle(start("1", "edit", edit), end("1", "edit", edit, true, "old text not found"));
  t.handle(start("2", "edit", edit), end("2", "edit", edit));
  t.handle(start("3", "bash", { command: "python3 -m pytest -q" }), end("3", "bash", { command: "python3 -m pytest -q" }, true, "1 failed"));
  t.handle(start("4", "write", { path: "/work/app/b.py" }), end("4", "write", { path: "/work/app/b.py" }));
  t.handle(start("5", "read", { path: "/work/app/c.py" }));
  expect(t.box).toEqual(["✗ bash · python3 -m pytest … — failed", "✓ write · b.py", "• read · c.py"]);
  t.handle(end("5", "read", { path: "/work/app/c.py" }));
  expect(t.screen).toEqual([]);
  t.handle({ type: "assistant_text_delta", delta: "Fixed it." });
  // The failed edit was tried again at once: counted, not printed. The failed command prints with its cause.
  expect(t.screen).toEqual(["✗ bash · python3 -m pytest … — failed", "  1 failed", "• 3 edits · 1 command · 1 read · 2 failed"]);
  expect(t.box).toBeUndefined();
});

test("the Working box never stays after the receipt, even for a tool that ends after its turn", async () => {
  const t = fakeTerminal(true);
  t.handle(start("x", "bash", { command: "sleep 5" }), { type: "message_end" });
  expect(t.box).toEqual(["• bash · sleep 5"]);
  t.handle(end("x", "bash", { command: "sleep 5" }));
  expect(t.box).toEqual(["✓ bash · sleep 5"]);
  t.view.reset();
  expect(t.box).toBeUndefined();
  expect(t.screen).toEqual(["✓ bash · sleep 5"]);

  // On the real surface the prompt's return clears the box too. A width change repaints the whole screen.
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  let pending: { test: () => boolean; resolve: () => void } | undefined;
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write(text: string) {
    output += text;
    if (pending?.test()) { pending.resolve(); pending = undefined; }
  } });
  const until = (check: () => boolean) => check() ? Promise.resolve() : new Promise<void>(resolve => { pending = { test: check, resolve }; });
  const REPAINT = "\x1b[2J\x1b[H\x1b[3J";
  const lastFrame = () => Bun.stripANSI(output.split(REPAINT).at(-1)!);
  const terminal = new InteractiveTerminal(input, writer, () => {}, () => {});
  try {
    terminal.setStatus("fixture"); terminal.start();
    terminal.setActivity(["✓ bash · sleep 5"]);
    await until(() => Bun.stripANSI(output).includes("Working"));
    void terminal.readCommand();
    const repaints = output.split(REPAINT).length;
    writer.columns = 79; writer.emit("resize");
    await until(() => output.split(REPAINT).length > repaints && lastFrame().includes("❯"));
    expect(lastFrame()).not.toContain("Working");
    expect(lastFrame()).not.toContain("sleep 5");
  } finally { terminal.close(); input.destroy(); }
});

test("plain terminal prints only the end line of each tool", () => {
  const t = fakeTerminal(false);
  t.handle(start("a", "bash", { command: "git status" }));
  expect(t.screen).toEqual([]);
  t.handle(end("a", "bash", { command: "git status" }), { type: "message_end" });
  expect(t.screen).toEqual(["✓ bash · git status"]);
  expect(t.box).toBeUndefined();
});

test("the summary line counts steps and shows time only from a second up", () => {
  expect(stepSummary([{ kind: "edit", startedAt: 0, endedAt: 10 }, { kind: "edit", startedAt: 20, endedAt: 30 }])).toBe("✓ 2 edits");
  expect(stepSummary([{ kind: "command", startedAt: 0, endedAt: 38_000, failed: true }, { kind: "other", startedAt: 0, endedAt: 5 }]))
    .toBe("• 1 command · 1 other step · 1 failed · 38.0s");
});

test("a tool call stopped at the spend limit shows as not run, never as a failed step or with the model's instruction", () => {
  for (const rich of [true, false]) {
    const t = fakeTerminal(rich);
    const input = { command: "ssh root@10.0.0.5 'systemctl restart demoapp'" };
    t.handle(start("1", "read", { path: "/work/app/a.py" }), end("1", "read", { path: "/work/app/a.py" }));
    t.handle(start("2", "bash", input), end("2", "bash", input, true, SPEND_STOP_REASON), { type: "message_end" });
    expect(t.screen).toContain("• bash · ssh root@10.0.0.5 … — not run (spend limit)");
    expect(t.screen.join("\n")).not.toContain("Do not call more tools");
    expect(t.screen.join("\n")).not.toMatch(/failed|✗/);
    if (rich) expect(t.screen).toContain("✓ read · a.py");
  }
});
