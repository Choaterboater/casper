import { expect, test } from "bun:test";
import { findMoves } from "../src/task/changes";
import { formatShortReceipt, formatTaskResult, receiptView, type TaskResult } from "../src/task/result";
import { cardRows, receiptCard, receiptTone } from "../src/tui/receipt-card";
import { planAutoChecks } from "../src/verify/mode";
import type { VerificationResult } from "../src/verify/evidence";

/**
 * v0.4.4, "run another omp vs casper test": run 2 moved into run-2/, run 3 relaunched and scored. The receipt said
 * "⚠ Checks passed · not proven: no app code changed", ran the 44 s tests, "Moved 88 files into run-2/" then a bare
 * "86 files", a Config row of run-2/… files, and an Undo line about nested repositories inside run-2/.
 */

test("a file moved into the same folder as the others is a move even when run 3 wrote its old path again with the same bytes", () => {
  // runs/casper/app/config/widgets.yaml: run 2's and run 3's are the same template, so the old path didn't change at all.
  const before = new Map([["runs/casper/app/server.js", "s2"], ["runs/casper/app/config/widgets.yaml", "w"], ["src/a.ts", "a"]]);
  const after = new Map([["run-2/runs/casper/app/server.js", "s2"], ["run-2/runs/casper/app/config/widgets.yaml", "w"],
    ["runs/casper/app/server.js", "s3"], ["runs/casper/app/config/widgets.yaml", "w"], ["src/a.ts", "a"]]);
  const moves = findMoves(before, after, { added: ["run-2/runs/casper/app/config/widgets.yaml", "run-2/runs/casper/app/server.js"],
    modified: ["runs/casper/app/server.js"], removed: [] });
  expect(moves.map((move) => move.to)).toEqual(["run-2/runs/casper/app/config/widgets.yaml", "run-2/runs/casper/app/server.js"]);
  // A copy beside the code with no move into its folder is new work, not a move.
  expect(findMoves(new Map([["src/a.ts", "a"]]), new Map([["src/a.ts", "a"], ["src/b.ts", "a"]]), { added: ["src/b.ts"], modified: [], removed: [] })).toEqual([]);
});

test("only a program's output changed (its builds and runs too, code included): no checks", () => {
  const commands = { test: "npm run test" };
  expect(planAutoChecks({ commands, changedPaths: ["builds/A/server.js", "runs/casper/app/lib/status.js", "results/report.html", "logs/omp.json", "compare.out"] }))
    .toEqual({ run: [], skipped: "output" });
  expect(planAutoChecks({ commands, changedPaths: ["runs/casper/app/server.js", "scripts/run.mjs"] }).run).toEqual(["test"]);
  // What the AI's own write tool put there is its work; dist/ is the project's own build.
  expect(planAutoChecks({ commands, changedPaths: ["builds/A/server.js"], toolFiles: new Set(["builds/A/server.js"]) }).run).toEqual(["test"]);
  expect(planAutoChecks({ commands, changedPaths: ["dist/feature.js"] }).run).toEqual(["test"]);
});

const check: VerificationResult = { name: "test", status: "pass", command: "npm run test", cwd: "/repo", exitCode: 0, signal: null,
  stdout: "", stderr: "", truncated: false, durationMs: 44_000, freshness: "unavailable" };
const scored: TaskResult = { execution: "completed", verificationMode: "auto",
  changedPaths: ["results/review/answer.json", "tests/run.test.mjs"], verification: { status: "pass", repairAttempts: 0, rounds: [[check]], results: [check] },
  proofSkipped: "no app code changed, only tests, data or docs" };

test("checks that pass with no app code changed are a plain pass, green, with no proof wording", () => {
  const view = receiptView(scored);
  expect(view.verdict?.status).toBe("Checks passed");
  expect(receiptTone(view)).toBe("success");
  expect(formatShortReceipt(scored)).not.toMatch(/not proven|no app code/);
});

test("the Changed row says where many files are, and undo's nested repositories inside a moved folder are /receipt detail only", () => {
  const changed = [...Array.from({ length: 23 }, (_, i) => `builds/A/f${i}.js`), ...Array.from({ length: 21 }, (_, i) => `results/r${i}.json`), "compare.out"];
  const moved = Array.from({ length: 4 }, (_, i) => ({ from: `runs/x${i}`, to: `run-2/runs/x${i}` }));
  const left = ["run-2/runs/casper/app", "run-2/runs/omp/app"].map((entry) => ({ path: entry, why: "a nested repository" }));
  const task: TaskResult = { execution: "completed", verificationMode: "auto", changedPaths: [...changed, ...moved.map((move) => move.to), ...moved.map((move) => move.from)],
    moved, autoSkipped: "output", undo: { available: true, left } };
  const card = cardRows(receiptCard(receiptView(task), false)!, 160, false).join("\n");
  expect(card).toContain("Moved 4 files into run-2/");
  expect(card).toContain("45 files in builds/ (23), results/ (21) and here (1)");
  expect(card).not.toContain("nested repository");
  expect(formatTaskResult(task)).toContain("no copy of run-2/runs/casper/app, run-2/runs/omp/app");
});
