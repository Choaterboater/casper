import { expect, test } from "bun:test";
import { findMoves } from "../src/task/changes";
import { attributeChanges } from "../src/task/attribution";
import { formatShortReceipt, receiptView, type TaskResult } from "../src/task/result";
import { cardRows, receiptCard } from "../src/tui/receipt-card";
import { builtOutput, inOutputFolder, isOutputPath, planAutoChecks } from "../src/verify/mode";

/**
 * Runs 9 and 10 at once (v0.4.8): the harness was copied into run-9/ and run-10/, each with its own builds/, runs/,
 * results/ and logs/. Only top-level ones counted as output, so the receipt said "⚠ Not verified", "Proof 4 cases … no
 * checks ran", listed run-9/…/package.json copies as Config, called run-10/results/checks/*.server.log someone else's,
 * and named six archived build databases "Left by your test runs".
 */

test("builds/, runs/ and results/ are output at any depth, logs/ too for what is not code; never under a source folder", () => {
  for (const file of ["run-10/runs/casper/app/src/server.js", "run-9/builds/B/data/tracker.db", "run-10/results/checks/A.server.log", "archive/2026/results/score.json"]) {
    expect([file, inOutputFolder(file), builtOutput(file)]).toEqual([file, true, true]);
  }
  expect(isOutputPath("run-9/logs/omp.stderr.json")).toBe(true);
  // Code under a nested logs/ is still code; a source folder's own runs/ or results/ is the project's.
  for (const file of ["backend/logs/logger.ts", "src/runs/handler.ts", "packages/web/results/Results.tsx", "lib/builds/plan.py"]) {
    expect([file, inOutputFolder(file), builtOutput(file), isOutputPath(file)]).toEqual([file, false, false, false]);
  }
  expect(planAutoChecks({ commands: { test: "npm test" }, changedPaths: ["run-9/builds/A/src/server.js", "run-9/logs/omp.json", "run-9/compare.out"] }))
    .toEqual({ run: [], skipped: "output" });
});

test("files copied into a folder the task made are copies, not new work; a copy beside the code is new work", () => {
  const before = new Map([["package.json", "p"], ["scripts/run.mjs", "r"], ["src/a.ts", "a"]]);
  const after = new Map([...before, ["run-9/package.json", "p"], ["run-9/scripts/run.mjs", "r"], ["run-9/notes.md", "n"], ["src/b.ts", "a"]]);
  const moves = findMoves(before, after, { added: ["run-9/notes.md", "run-9/package.json", "run-9/scripts/run.mjs", "src/b.ts"], modified: [], removed: [] });
  expect(moves).toEqual([{ from: "package.json", to: "run-9/package.json", copied: true }, { from: "scripts/run.mjs", to: "run-9/scripts/run.mjs", copied: true }]);
});

test("archived builds' databases are never this task's test data: they lie in output folders, or were moved or copied", async () => {
  const at = async () => 30_000;
  const changes = { added: ["run-10/builds/A/data/tracker.db", "run-8/runs/casper/app/data/tracker.db", "archive/data/app.db", "data/app.db"], modified: [], removed: [] };
  const split = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]], changes, changedAt: at, ownRuns: true,
    moved: new Set(["archive/data/app.db"]) });
  expect(split.testData).toEqual(["data/app.db"]);
  // A log a copied harness wrote into its own logs/ goes by its time; the app's own logs/ at the top stays the app's.
  const logs = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]], changedAt: async () => 11_000,
    changes: { added: ["run-9/logs/omp.stderr.log", "logs/app.log"], modified: [], removed: [] } });
  expect([logs.task, logs.others]).toEqual([["run-9/logs/omp.stderr.log"], ["logs/app.log"]]);
});

test("only output, moved and copied files: grey checks skipped, no Config row, no proof row and no /verify", () => {
  const moved = [{ from: "runs/casper/app/server.js", to: "run-8/runs/casper/app/server.js" }, { from: "package.json", to: "run-9/package.json", copied: true as const }];
  const task: TaskResult = { execution: "completed", verificationMode: "offer", autoSkipped: "output", checklist: ["Run test 9", "Run test 10", "Run them at once", "Report both"],
    changedPaths: ["run-8/runs/casper/app/server.js", "runs/casper/app/server.js", "run-9/package.json", "run-9/builds/A/package.json", "run-10/results/checks/A.server.log"], moved };
  const text = formatShortReceipt(task);
  expect(text.split("\n")[0]).toMatch(/^– Checks skipped — only output files changed/);
  expect(text).not.toMatch(/Not verified|not confirmed|\/verify/);
  expect(text).toContain("moved 1 file into run-8/runs/casper/app/; copied 1 into run-9/");
  const card = cardRows(receiptCard(receiptView(task), false)!, 200, false).join("\n");
  expect(card).not.toMatch(/Config|Proof|\/verify/);
});
