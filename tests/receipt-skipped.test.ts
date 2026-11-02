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
  const left = ["run-1/runs/casper/app", "run-1/runs/omp/app", "runs/casper/app", "runs/omp/app"].map((entry) => ({ path: entry, why: "a nested repository" }));
  const text = formatShortReceipt({ ...scoring, undo: { available: true, left } });
  expect(text).toContain("– Undo can't put back: run-1/runs/casper/app, run-1/runs/omp/app and 2 more (a nested repository, each)");
});
