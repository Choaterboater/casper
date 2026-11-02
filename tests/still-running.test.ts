import { expect, test } from "bun:test";
import { carryOnItem, jobEndedLine, tellJobEnded } from "../src/app/background-ended";
import type { CasperApp } from "../src/app";
import { mustStand } from "../src/task/ending";
import { formatShortReceipt, formatTaskResult, receiptView, type TaskResult } from "../src/task/result";
import { tint } from "../src/tui/format";
import { cardRows, receiptCard, receiptTone } from "../src/tui/receipt-card";
import type { NextRow } from "../src/tui/next-row";
import type { VerificationReport, VerificationResult } from "../src/verify/evidence";

function check(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return { name: "test", status: "pass", command: "npm run test", cwd: "/repo", exitCode: 0, signal: null,
    stdout: "", stderr: "", truncated: false, durationMs: 44_962, freshness: "unavailable", ...overrides };
}
const report = (results: VerificationResult[]): VerificationReport =>
  ({ status: results.some((result) => result.status === "fail") ? "fail" : "pass", repairAttempts: 0, rounds: [results], results });
const job = { id: "cmd-1", command: "node scripts/run.mjs --force > compare.out 2>&1", startedAt: Date.parse("2026-11-01T18:37:00Z") };
// The smoke session's receipt 5: scripts changed and proven by the tests, while the 90-minute comparison had just begun.
const launched: TaskResult = { execution: "completed", changedPaths: ["scripts/lib.mjs", "scripts/run.mjs", "tests/run.test.mjs"], verificationMode: "auto",
  verification: report([check()]), proof: { status: "proven", check: "test", command: "npm run test", testsChanged: true, without: { exitCode: 1, ended: "fail" } },
  stillRunning: [job] };

test("work still running in the background is line 1, never a done-style pass; what the checks showed stays under it", () => {
  const view = receiptView(launched);
  expect(view.verdict).toMatchObject({ status: "Still running", detail: "node scripts/run.mjs --force > compare.out 2>&1 (cmd-1) in the background; Casper says here when it ends", actions: ["/tasks"] });
  expect(view.short).toBeUndefined();
  const text = formatShortReceipt(launched).split("\n");
  expect(text[0]).toBe("◐ Still running — node scripts/run.mjs --force > compare.out 2>&1 (cmd-1) in the background; Casper says here when it ends");
  expect(text).toContain("✓ Verified — the checks pass, and the tests fail without the change");
  expect(text.join("\n")).not.toMatch(/^✓ Verified/);
  // Without it, the same task is the one-line pass it always was.
  const { stillRunning: _job, ...finished } = launched;
  expect(formatShortReceipt(finished).split("\n")[0]).toStartWith("✓ Verified");
  // The detailed receipt (/receipt, --verbose) names it too, and the card must stand even under the AI's question.
  expect(formatTaskResult(launched)).toContain("running      node scripts/run.mjs --force > compare.out 2>&1 (cmd-1) in the background (/tasks)");
  expect(mustStand(launched)).toBe(true);
});

test("the still-running card is in the accent colour with a ◐, not amber or green; plain and NO_COLOR read the same words", () => {
  const view = receiptView(launched);
  expect(receiptTone(view)).toBe("accent");
  const plain = cardRows(receiptCard(view, false)!, 160, false);
  expect(plain[0]).toBe("▌ ◐ Still running: node scripts/run.mjs --force > compare.out 2>&1 (cmd-1) in the background; Casper says here when it ends");
  expect(plain.slice(1, 3)).toEqual(["▌   Checks   ✓ test 44s", "▌            ✓ Verified — the checks pass, and the tests fail without the change"]);
  expect(plain.at(-1)).toBe("▌   Next     /tasks");
  // The bytes the terminal gets: the edge and the title in the theme's accent role, bold title, never warning or success.
  const colored = cardRows(receiptCard(view, true)!, 160, true);
  expect(colored[0]).toStartWith(`${tint("▌", "accent", true)} ${tint("◐ Still running", "accent", true, "1")}`);
  for (const role of ["warning", "success", "error"] as const) expect(colored.join("\n")).not.toContain(tint("▌", role, true));
});

test("a failure keeps its own line 1; the job still running is said under it", () => {
  const failing: TaskResult = { ...launched, verification: report([check({ status: "fail", exitCode: 1 })]), proof: undefined };
  const text = formatShortReceipt(failing);
  expect(text.split("\n")[0]).toStartWith("✗ Failed — test failed");
  expect(text).toContain("– Still running in the background: node scripts/run.mjs --force > compare.out 2>&1 (cmd-1) (/tasks)");
});

test("when the job ends you get one accent line, and at the prompt a Next row to carry on; nothing asks", () => {
  const ended = { id: "cmd-1", how: "ended with exit code 0", startedAt: job.startedAt, byPerson: false };
  expect(jobEndedLine(ended, "API_TOKEN=abcdef0123456789abcdef node scripts/run.mjs --force", job.startedAt + 34 * 60_000))
    .toBe("◐ Background job cmd-1 ended with exit code 0 after 34m: API_TOKEN=<secret hidden> node scripts/run.mjs --force");
  const written: string[] = [];
  const rows: Array<NextRow | undefined> = [];
  const app = (commandActive: boolean) => ({ closing: false, interactive: true, commandActive, events: { ensureLineBreak() {} }, output: { write: (text: string) => { written.push(text); } },
    terminal: { offerNext: (row: NextRow | undefined) => { rows.push(row); } } }) as unknown as CasperApp;
  tellJobEnded(app(false), ended, job.command);
  expect(written.at(-1)).toStartWith("◐ Background job cmd-1 ended with exit code 0 after");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.line).toBe("Next: 1 Carry on now that cmd-1 ended (uses tokens)");
  expect(rows[0]!.keys.get("1")).toBe(carryOnItem(ended).command);
  // While a task runs the AI reads its note itself; a stop from /tasks was the person's own: no row either way.
  tellJobEnded(app(true), ended, job.command);
  tellJobEnded(app(false), { ...ended, how: "was stopped from /tasks", byPerson: true }, job.command);
  expect(rows).toHaveLength(1);
  expect(written).toHaveLength(3);
});
