import { afterAll, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import type { CasperApp } from "../src/app";
import { recordedApproval } from "../src/app/approvals";
import { writeCheckResult } from "../src/app/verification";
import { NO, YES_ONCE } from "../src/app/safe-choices";
import { folderName } from "../src/project/inspect";
import { NOT_A_PROJECT, snapshotFailureReason, tooManyFiles } from "../src/task/changes";
import { formatShortReceipt, UNDO_NOT_PROJECT } from "../src/task/result";
import { answerRecordText } from "../src/tui/choices";
import { formatRuntimeStartLine, formatRuntimeStatus } from "../src/tui/format";
import { unknownCommandMessage } from "../src/tui/help";
import { InteractiveTerminal } from "../src/tui/terminal";
import { Screen } from "./support/conpty";
import { interactiveTerminal } from "./support/tty";

/**
 * A closed picker, question or approval leaves one line: "<question> → <answer>", or "<question> — skipped". The
 * choices, the hint and the lines under the question go with the box, on the rich and the plain terminal alike.
 */

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The screen as a terminal shows it now (scrollback and rows), not the raw stream of redraws. */
function screenText(raw: string, cols = 100, rows = 30): string {
  const screen = new Screen(cols, rows);
  screen.feed(raw);
  return screen.text();
}

/** The transcript above the prompt box: what stays once every box has closed. */
function transcript(raw: string): string[] {
  const lines = screenText(raw).split("\n");
  const rule = lines.findIndex((line) => /^─{20,}$/.test(line));
  return lines.slice(0, rule === -1 ? lines.length : rule).filter((line) => line.trim());
}

test("the record is one line: the question's first line, then the answer or skipped", () => {
  expect(answerRecordText("Pick a server", ["network"])).toBe("Pick a server → network");
  expect(answerRecordText("Settings (saved in ~/.casper/config.yaml for you):\n  Web lookups: on\nPick one to change:", undefined))
    .toBe("Settings (saved in ~/.casper/config.yaml for you) — skipped");
  expect(answerRecordText("Which?", ["A", "B"])).toBe("Which? → A, B");
});

test("a closed picker leaves one line; Esc leaves the question and skipped, never its rows", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const servers = [{ label: "docs", description: "not connected · from ~/.claude.json" }, { label: "network", description: "not connected" },
      { label: "lab", description: "ready" }, { label: "Done" }];
    const first = session.terminal.pick("Pick a server", servers);
    await session.screen.until((output) => output.includes("Press 1-4"));
    session.input.write("2");
    expect(await first).toBe("network");
    const action = session.terminal.pick("network", [{ label: "Details" }, { label: "Connect" }, { label: "Back" }]);
    await session.screen.until((output) => output.includes("Press 1-3"));
    session.input.write("2");
    expect(await action).toBe("Connect");
    const again = session.terminal.pick("Pick a server", servers);
    await session.screen.until((output) => output.split("Press 1-4").length > 2);
    session.input.write("\x1b");
    expect(await again).toBeUndefined();
    await settle(30);
    expect(transcript(session.screen.output)).toEqual(["Pick a server → network", "network → Connect", "Pick a server — skipped"]);
  } finally { session.close(); }
});

test("an answered approval is one line after its context; Esc is a No and the line says both", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const yes = session.terminal.approve("  mkdir made\n", "Run this command?", [NO, YES_ONCE, "Yes, for this session"]);
    await session.screen.until((output) => output.includes("Press 1-3"));
    session.input.write("2");
    expect(await yes).toBe(YES_ONCE);
    const skipped = session.terminal.approve("", "Make this change?", [NO, YES_ONCE]);
    await session.screen.until((output) => output.includes("Make this change?"));
    session.input.write("\x1b");
    expect(await skipped).toBeUndefined();
    await settle(30);
    expect(transcript(session.screen.output)).toEqual(["  mkdir made", "Run this command? → Yes, this once", "Make this change? — skipped (No)"]);
  } finally { session.close(); }
});

test("skipped /settings leaves one line, not its 23 rows; a long question is cut with … and the answer stays whole", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const rows = Array.from({ length: 23 }, (_, index) => ({ label: `Row ${index + 1}`, description: "on" }));
    const skipped = session.terminal.pick("Settings (saved in ~/.casper/config.yaml for you):\n  Web lookups: on · Browser tool: on\nPick one to change:", rows);
    await session.screen.until((output) => output.includes("Type 1-23"));
    // Taller than the 30-row screen: the rows around the highlighted one show, the rest are counted, and the box's top
    // never scrolls into the scrollback, where it would stay after the box closes.
    expect(screenText(session.screen.output)).toMatch(/^ {2}… \d+ more below$/m);
    expect(screenText(session.screen.output).split("\n").length).toBe(30);
    session.input.write("\x1b");
    await skipped;
    const long = session.terminal.pick(`${"A very long question that goes on ".repeat(5)}?`, [{ label: "Keep it as it is" }, { label: "Change it" }]);
    await session.screen.until((output) => output.includes("Press 1-2"));
    session.input.write("2");
    expect(await long).toBe("Change it");
    await settle(30);
    const lines = transcript(session.screen.output);
    expect(lines[0]).toBe("Settings (saved in ~/.casper/config.yaml for you) — skipped");
    expect(lines[1]).toMatch(/^A very long question .*… → Change it$/);
    expect(lines[1]!.length).toBeLessThanOrEqual(100);
    expect(lines).toHaveLength(2);
  } finally { session.close(); }
});

test("the plain terminal leaves the same one-line record after its numbered lines", async () => {
  // Piped input: the plain terminal reads its numbered answers from lines (an approval needs a terminal that shows it).
  const input = Object.assign(new PassThrough(), { isTTY: false });
  let output = "";
  const writer = { isTTY: false, write: (text: string) => { output += text; } };
  const terminal = new InteractiveTerminal(input, writer as never, () => {}, () => {});
  terminal.start();
  try {
    const picked = terminal.pick("Pick a server", [{ label: "lab" }, { label: "Done" }]);
    input.write("1\n");
    expect(await picked).toBe("lab");
    const approval = terminal.approve("", "Make this change?", [NO, YES_ONCE]);
    input.write("yes please\n");
    expect(await approval).toBe(NO);
    expect(output).toContain("Pick a server → lab\n");
    expect(output).toContain("Make this change? → No\n");
    expect(output).not.toContain("→ yes please");
    expect(terminal.records).toBe(2);
  } finally { terminal.close(); input.destroy(); }
});

test("an approval box shown on screen is the only record of its answer: no [approval] line follows it", async () => {
  const session = interactiveTerminal();
  const written: string[] = [];
  const app = { interactive: true, closing: false, approvalQueue: Promise.resolve(), terminal: session.terminal,
    output: { write: (text: string) => { written.push(text); session.terminal.write(text); } } } as unknown as CasperApp;
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = recordedApproval(app, "", "Run this command?", [{ label: NO }, { label: YES_ONCE }]);
    await session.screen.until((output) => output.includes("Press 1-2"));
    session.input.write("\x1b");
    expect(await answer).toBeUndefined();
    expect(written.join("")).not.toContain("[approval]");
  } finally { session.close(); }
});

test("while a picker is open its row takes no typing and no paste; a paste waits as the draft for after", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const picked = session.terminal.pick("Pick a server", [{ label: "lab" }, { label: "Done" }]);
    await session.screen.until((output) => output.includes("Press 1-2 or Up/Down + Enter · Esc skip"));
    const paste = Array.from({ length: 61 }, (_, index) => `line ${index + 1}`).join("\n");
    session.input.write(`\x1b[200~${paste}\x1b[201~`);
    session.input.write("x");
    await settle(30);
    const open = screenText(session.screen.output).split("\n");
    expect(open.some((line) => line.includes("line 61"))).toBe(false);
    expect(open.filter((line) => line.trim()).at(-1)).toContain("press a number · Esc skips");
    session.input.write("1");
    expect(await picked).toBe("lab");
    // The paste is back in the prompt once the picker closes, nothing typed with it.
    void session.terminal.readCommand();
    await session.screen.until((output) => screenText(output).includes("line 61"));
    expect(screenText(session.screen.output)).not.toMatch(/line 61x|xline/);
  } finally { session.close(); }
});

test("the AI's own question still takes a typed answer, and so does a long list's row number", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const typed = session.terminal.ask("Name?", [{ label: "Ann" }, { label: "Bo" }], false, undefined, "ai");
    await session.screen.until((output) => output.includes("Other — type your own answer"));
    session.input.write("Cy\r");
    expect(await typed).toEqual(["Cy"]);
    const rows = Array.from({ length: 12 }, (_, index) => ({ label: `Row ${index + 1}` }));
    const long = session.terminal.pick("Pick one", rows);
    await session.screen.until((output) => output.includes("Type 1-12"));
    session.input.write("1");
    session.input.write("1\r");
    expect(await long).toBe("Row 11");
    await settle(30);
    expect(transcript(session.screen.output)).toEqual(["The AI asks: Name? → Cy", "Pick one → Row 11"]);
  } finally { session.close(); }
});

test("the footer and banner name the folder, never blank: ~ for home, the root itself for a drive's top", () => {
  expect(folderName(path.join(os.tmpdir(), "demo-app"))).toBe("demo-app");
  expect(folderName(os.homedir())).toBe("~");
  const root = path.parse(process.cwd()).root;
  expect(folderName(root)).toBe(root);
});

test("the banner's model line says it once; the first request's [model] line is short, or none when the banner said it", () => {
  expect(formatRuntimeStatus(undefined, "fixture/demo · effort auto")).toBe(" model     fixture/demo · effort auto (starts on your first request; /model to change)");
  const status = { provider: "fixture", model: "demo", auth: "configured" as const, thinkingLevel: "high", configuredEffort: "auto" as const,
    autoEffort: { state: "pending" as const } };
  expect(formatRuntimeStartLine(status as never, "fixture/demo · effort auto")).toBeUndefined();
  expect(formatRuntimeStartLine(status as never)).toBe("[model] fixture/demo · effort auto");
  expect(formatRuntimeStartLine({ ...status, auth: "missing" } as never, "fixture/demo · effort auto")).toBe("[model] fixture/demo · effort auto · credentials missing (/login)");
  expect(formatRuntimeStartLine({ provider: "fixture", model: "other", auth: "configured", thinkingLevel: "low" } as never, "fixture/demo · effort auto"))
    .toBe("[model] fixture/other · effort low");
});

test("a folder too big to list is said once: not a project folder, and no undo line after it", () => {
  const reason = snapshotFailureReason(new RangeError("Workspace exceeds 20000 files"));
  expect(reason).toBe(`${NOT_A_PROJECT} (over 20,000 files)`);
  expect(tooManyFiles(reason)).toBe(true);
  const receipt = formatShortReceipt({ execution: "completed", possibleMutations: true, snapshotFailure: { reason, edited: [] },
    undo: { available: false, reason: UNDO_NOT_PROJECT } }, { surface: "interactive" });
  expect(receipt.match(/not a project folder/g)).toHaveLength(1);
  expect(receipt).not.toContain("Undo not available");
});

test("a check that timed out is said once in the question and once on the receipt", () => {
  const result = { name: "test", status: "fail" as const, ended: "timeout" as const, reason: "Timed out after 600000ms", stdout: "", stderr: "",
    command: "bun test", durationMs: 600_000 };
  const written: string[] = [];
  const app = { interactive: true, verbose: false, modelCheckCalls: 0, terminal: { canAsk: true, writePanel() {} },
    events: { ensureLineBreak() {} }, output: { write: (text: string) => { written.push(text); } } } as unknown as CasperApp;
  writeCheckResult(app, result as never);
  expect(written.join("")).not.toContain("timed out");
  const receipt = formatShortReceipt({ execution: "completed", changedPaths: ["src/a.ts"],
    verification: { status: "fail", results: [result as never], repairAttempts: 0, rounds: [] } }, { surface: "interactive" });
  expect(receipt.match(/timed out/g)).toHaveLength(1);
  expect(receipt.split("\n")[0]).toBe("✗ Not checked — test timed out after 10m, so the change was not tested; /verify test runs it again");
});

test("/q is the start of exactly one command, so Enter on it suggests /quit", () => {
  expect(unknownCommandMessage("/q")).toContain("Did you mean /quit?");
});
