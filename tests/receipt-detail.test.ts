import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { showReceiptDetail } from "../src/app/undo";
import { formatTaskResult, receiptView, shortReceiptText, type TaskResult } from "../src/task/result";
import { RECEIPT_HELP } from "../src/tui/help";
import { buildNextRow } from "../src/tui/next-row";
import { cardRows, receiptDetail, RECEIPT_HINT } from "../src/tui/receipt-card";
import { InteractiveTerminal } from "../src/tui/terminal";
import { roleCode } from "../src/tui/theme";
import type { VerificationReport, VerificationResult } from "../src/verify/evidence";
import { ansiCells, cellsFor } from "./support/ansi-cells";
import { withEnv } from "./support/env";
import { interactiveTerminal } from "./support/tty";

function check(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return { name: "test", status: "pass", command: "npm run test", cwd: "/repo", exitCode: 0, signal: null,
    stdout: "", stderr: "", truncated: false, durationMs: 1312, freshness: "unavailable", ...overrides };
}
function report(results: VerificationResult[], overrides: Partial<VerificationReport> = {}): VerificationReport {
  const status = results.some((result) => result.status === "fail") ? "fail" : "pass";
  return { status, repairAttempts: 0, rounds: [results], results, ...overrides };
}
const done = (task: Omit<TaskResult, "execution">): TaskResult => ({ execution: "completed", ...task });
const proven: TaskResult["proof"] = { status: "proven", check: "test", command: "npm run test", testsChanged: true, without: { exitCode: 1, ended: "fail" } };
const files = Array.from({ length: 10 }, (_, index) => `src/file-${index}.ts`);
const detail = (task: TaskResult, width = 140) => cardRows(receiptDetail(receiptView(task, { full: true }), task, false)!, width, false);

test("/receipt's card says every line in full under plain labels, the proof even when it is strong", () => {
  const task = done({ changedPaths: [...files, "package.json"], verificationMode: "auto", receipt: 7, undo: { available: true },
    verification: report([check({ name: "lint", command: "npm run lint", durationMs: 2100 }), check()], { repairAttempts: 1 }), proof: proven,
    acceptance: { status: "pass", mode: "verdict" }, checklist: ["sum(2, 3) is 5", "sum('2', 3) is 5"], review: { done: ["sums"], open: [] },
    observedChecks: [{ name: "build", command: "npm run build", toolStatus: "success", output: "", truncated: false }], pagesShown: 2 });
  expect(detail(task)).toEqual([
    "▌ ✓ Verified: the checks pass, and the tests fail without the change",
    "▌   Changes                   11 files: src/file-0.ts, src/file-1.ts, src/file-2.ts, src/file-3.ts, src/file-4.ts, src/file-5.ts,",
    "▌                             src/file-6.ts, src/file-7.ts, src/file-8.ts, src/file-9.ts, package.json",
    "▌   Config                    package.json",
    "▌   Checks                    ✓ lint passed (npm run lint, 2.1s)",
    "▌                             ✓ test passed (npm run test, 1.3s)",
    "▌                             Casper tried 1 repair",
    "▌   Proof                     ✓ Proven: test fails without this change (exit 1) and passes with it",
    "▌   Tests from your request   ✓ Independent acceptance: tests written from the request alone pass",
    "▌                             2 cases from your request (handed to the model to test; not evidence)",
    "▌                             - sum(2, 3) is 5",
    "▌                             - sum('2', 3) is 5",
    "▌   Model's review            The model's review: all 1 requirements covered (its own claim, not checked by Casper)",
    "▌   Shell runs (not counted)  build ran via bash only (npm run build: passed)",
    "▌   Notes                     The AI looked at 2 screenshots of the pages (advice, not a check)",
    "▌   Undo                      available: /undo 7",
    "▌   Next                      /verify build",
  ]);
});

test("a failed check keeps its advice in /receipt's card, its log one key away, and a timeout is amber, never red", () => {
  const task = done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check({ status: "fail", exitCode: 1 }),
    check({ name: "lint", command: "npm run lint", status: "fail", exitCode: null, ended: "timeout", reason: "Timed out after 600000ms" })]) });
  expect(detail(task)).toEqual([
    "▌ ✗ Failed: test failed, lint timed out",
    "▌   Changes                   1 file: sum.js",
    "▌   Checks                    ✗ test failed (exit 1) — Ctrl+T shows the log; /verify repair test to fix",
    "▌                             ⚠ lint timed out after 10m — it did not finish, so it was not checked; /verify lint to run it again (a session",
    "▌                             offers more time)",
    "▌   Next                      /verify repair test · /verify lint",
  ]);
});

test("/receipt on a session's rich terminal is the card; with --verbose, and on the plain terminal, the full form", async () => {
  const task = done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check({ status: "fail", exitCode: 1 })]) });
  await withEnv({ TERM: "xterm-256color", NO_COLOR: undefined }, async () => {
    const f = interactiveTerminal();
    try {
      f.terminal.start();
      let written = "";
      showReceiptDetail({ terminal: f.terminal, output: { write: (text) => { written += text; } } }, task);
      await f.screen.until((output) => output.includes("Tests from your request") || output.includes("Changes "));
      expect(Bun.stripANSI(f.screen.output)).toContain("▌ ✗ Failed: test failed");
      expect(written).toBe("");
      // --verbose: the full form, on the terminal like the receipt (a failure red), not the card.
      showReceiptDetail({ terminal: f.terminal, verbose: true, output: { write: (text) => { written += text; } } }, task);
      await f.screen.until((output) => output.includes("[task] Execution completed"));
      expect(Bun.stripANSI(f.screen.output)).toContain("verification Checks fail (command execution)");
      expect(written).toBe("");
    } finally { f.close(); }
  });
  let shown = "";
  const writer = Object.assign(new EventEmitter(), { isTTY: false, columns: 100, write: (text: string) => { shown += text; return true; } });
  const plain = new InteractiveTerminal(Object.assign(new PassThrough(), { isTTY: false }), writer, () => {}, () => {});
  let written = "";
  showReceiptDetail({ terminal: plain, output: { write: (text) => { written += text; } } }, task);
  // The plain terminal: the full form, byte for byte.
  expect(shown).toBe(`${formatTaskResult(task)}\n`);
  expect(written).toBe("");
});

test("/help receipt says what each verdict means and what to do", () => {
  const lines = RECEIPT_HELP.trimEnd().split("\n");
  for (const term of ["✓ Verified", "⚠ Checks passed · not proven", "⚠ Not verified", "⚠ Not checked", "⚠ Incomplete", "✗ Failed", "⚠ Stopped"]) {
    const line = lines.find((entry) => entry.trimStart().startsWith(`${term} `));
    expect({ term, explained: Boolean(line && line.length > term.length + 30) }).toEqual({ term, explained: true });
  }
  expect(RECEIPT_HELP).toContain("/verify repair <check>");
  expect(RECEIPT_HELP).toContain("Ctrl+T shows the log");
});

test("the first problem receipt of a session ends with where its words are explained, grey, once", async () => {
  const failed = done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check({ status: "fail", exitCode: 1 })]) });
  const verified = done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]), proof: proven,
    undo: { available: true, left: [{ path: ".env", why: "git ignores it" }] } });
  await withEnv({ TERM: "xterm-256color", NO_COLOR: undefined }, async () => {
    const f = interactiveTerminal();
    const next = buildNextRow({ diff: { label: "Show diff", command: "/diff" }, undo: { label: "Undo", command: "/undo" } });
    const receipt = (task: TaskResult) => {
      const view = receiptView(task);
      f.terminal.writeResult(`${shortReceiptText(view)}\n`, view);
      f.terminal.offerNext(next);
    };
    const count = () => Bun.stripANSI(f.screen.output).split(RECEIPT_HINT).length - 1;
    try {
      f.terminal.start();
      // A pass with a row is not a problem: no pointer.
      receipt(verified);
      await f.screen.until((output) => output.includes("can't put back"));
      receipt(failed);
      await f.screen.until((output) => output.includes(RECEIPT_HINT));
      const rows = (f.terminal as unknown as { surface: { tui: { render(width: number): string[] } } }).surface.tui.render(100);
      const at = rows.findIndex((row) => Bun.stripANSI(row).includes(RECEIPT_HINT));
      expect(Bun.stripANSI(rows[at - 1]!)).toBe("▌            1 Show diff · 2 Undo");
      expect(Bun.stripANSI(rows[at]!).trimEnd()).toBe(`▌   ${RECEIPT_HINT}`);
      const cells = ansiCells([rows[at]!]);
      expect(cells[0]![0]!.foreground).toBe(roleCode("error"));
      expect(cellsFor(cells, RECEIPT_HINT).every((cell) => cell.dim)).toBe(true);
      // Never again in this session.
      receipt(done({ ...failed, changedPaths: ["other.js"] }));
      await f.screen.until((output) => output.includes("other.js"));
      expect(count()).toBe(1);
    } finally { f.close(); }
  });
});
