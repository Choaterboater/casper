import { expect, test } from "bun:test";
import { formatShortReceipt, receiptView, type TaskResult } from "../src/task/result";
import { tint } from "../src/tui/format";
import { cardRows, receiptCard, receiptTone } from "../src/tui/receipt-card";

/** The scoring turn of comparison run 2: only results/ changed, checks were rightly skipped, and the receipt said
 * "⚠ Not verified: Casper ran no checks" with "Next /verify". */
const scoring: TaskResult = { execution: "completed", verificationMode: "auto",
  changedPaths: ["results/report.html", "results/review.json", "results/scores.json"], autoSkipped: "output",
  changedNotByModel: ["results/checks/A.server.log"] };

test("checks rightly skipped are line 1, neutral and grey, with no /verify push", () => {
  const view = receiptView(scoring);
  expect(view.verdict).toMatchObject({ status: "Checks skipped", detail: "only output files changed (results/report.html, results/review.json, results/scores.json)" });
  expect(view.verdict?.actions ?? []).toEqual([]);
  expect(formatShortReceipt(scoring).split("\n")[0]).toBe("– Checks skipped — only output files changed (results/report.html, results/review.json, results/scores.json)");
  expect(formatShortReceipt(scoring)).not.toMatch(/Not verified|\/verify/);
  expect(receiptTone(view)).toBe("muted");
  const plain = cardRows(receiptCard(view, false)!, 160, false);
  expect(plain[0]).toBe("▌ – Checks skipped: only output files changed (results/report.html, results/review.json, results/scores.json)");
  expect(plain.join("\n")).not.toContain("Next");
  const colored = cardRows(receiptCard(view, true)!, 160, true);
  expect(colored[0]).toStartWith(`${tint("▌", "muted", true)} `);
  for (const role of ["warning", "success", "error"] as const) expect(colored.join("\n")).not.toContain(tint("▌", role, true));
});

test("a question that ran no checks is neutral too; docs-only keeps its /verify note but is neutral", () => {
  const asked = receiptView({ ...scoring, changedPaths: ["state.yaml"], autoSkipped: "question" });
  expect(asked.verdict?.status).toBe("Checks skipped");
  expect(receiptTone(asked)).toBe("muted");
  const docs = receiptView({ ...scoring, changedPaths: ["README.md"], autoSkipped: "docs-only" });
  expect(docs.verdict?.status).toBe("Checks skipped");
  expect(receiptTone(docs)).toBe("muted");
});

test("undo's \"can't put back\" says one reason once: four nested repositories are one line", () => {
  const left = ["vendor/one", "vendor/two", "lib/three", "lib/four"].map((entry) => ({ path: entry, why: "a nested repository" }));
  const text = formatShortReceipt({ ...scoring, undo: { available: true, left } });
  expect(text).toContain("– Undo can't put back: vendor/one, vendor/two and 2 more (a nested repository, each)");
});

/** The archive-and-rescore turn of comparison run 4 ("re run the test for test 4"): run 3 moved into run-3/, the builds,
 * runs and results written again, and one case from the request. */
const many = (folder: string, count: number) => Array.from({ length: count }, (_, index) => `${folder}/file-${String(index).padStart(3, "0")}.txt`);
const rescore: TaskResult = { ...scoring, changedNotByModel: undefined, checklist: ['Re-run the test for "test 4"'],
  changedPaths: [...many("builds", 50), ...many("runs", 50), ...many("results", 22), ...many("logs", 6), "compare.out"] };

test("a long list of output files is counted on line 1 with where most of them are, never listed there", () => {
  const view = receiptView(rescore);
  expect(view.verdict?.detail).toBe("only output files changed (129 in builds/, runs/, results/ and 2 more places)");
  expect(formatShortReceipt(rescore).split("\n")[0]).toBe("– Checks skipped — only output files changed (129 in builds/, runs/, results/ and 2 more places)");
  // A few are still named.
  expect(receiptView(scoring).verdict?.detail).toBe("only output files changed (results/report.html, results/review.json, results/scores.json)");
});

test("checks rightly skipped leave no proof row: the request's cases are not \"not confirmed\" for want of checks that had nothing to check", () => {
  for (const task of [rescore, { ...rescore, autoSkipped: "question" as const }]) {
    const text = formatShortReceipt(task);
    expect(text).not.toContain("from your request not confirmed");
    const rows = cardRows(receiptCard(receiptView(task), false)!, 160, false).join("\n");
    expect(rows).not.toContain("Proof");
    expect(rows).not.toContain("/receipt");
  }
  // Checks that should have run and didn't still say so.
  expect(formatShortReceipt({ ...rescore, autoSkipped: undefined, verificationMode: "offer", changedPaths: ["src/app.ts"] })).toContain("1 case from your request not confirmed: no checks ran");
});
