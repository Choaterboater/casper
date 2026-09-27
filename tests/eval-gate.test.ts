import { expect, test } from "bun:test";
import { decidedReasons, futility, type BenchmarkRun, type ReceiptCell } from "../evals/benchmark";
import type { EvalTask } from "../evals/runner";

const cell = (fields: Partial<ReceiptCell>): ReceiptCell => ({ harness: "casper", runs: 24, timeouts: 0, noReceipt: 0, wrong: 2, caught: 1,
  catchInterval: null, right: 22, flagged: 2, verified: 20, verifiedWrong: 1, wallRatio: 1, tokenRatio: 1, rule: null, ...fields });

test("the gate stays open while the remaining runs could still meet every bar", () => {
  // 5 flagged of at most 22 + 3 right runs is exactly 20%: still possible.
  expect(futility(cell({ flagged: 5 }), 3)).toEqual([]);
  expect(futility(cell({ wallRatio: 1.25, tokenRatio: null, caught: 2 }), 0)).toEqual([]);
});

test("the gate closes when flagged runs, catches or cost can no longer meet the bar", () => {
  expect(futility(cell({ flagged: 6 }), 3)).toEqual(["flagged 6 of at most 25 right runs > 20%"]);
  // 1 caught of 4 wrong, 2 runs left: at best 3 of 6.
  expect(futility(cell({ wrong: 4, caught: 1 }), 2)).toEqual(["caught 1/4 cannot reach 70%"]);
  expect(futility(cell({ wallRatio: 1.61 }), 72)).toEqual(["wall 1.61× Pi > 1.25×"]);
});

/** A finished hard-pack run: the grader's verdict, the receipt and the wall time. */
const run = (harness: BenchmarkRun["harness"], taskId: string, success: boolean, receiptOutcome: string | null, wallClockMs = 100_000): BenchmarkRun => ({
  taskId, pack: "hard", harness, repeat: 1, graded: { success }, run: { termination: "completed", exitCode: 0, errors: [], receiptOutcome, wallClockMs },
  score: { effort: { wallClockMs, turns: 1, tokens: 1000, estimatedCost: null, rescues: 0 } },
}) as unknown as BenchmarkRun;
const tasks = [{ id: "a", pack: "hard" }, { id: "b", pack: "hard" }] as EvalTask[];

test("the in-run stopper decides on the finished runs and the jobs still unfinished", () => {
  const flagged = [run("casper", "a", true, "not_verified"), run("casper", "b", true, "not_verified"), run("casper", "a", true, "verified")];
  // 2 flagged of at most 3 + 7 right runs is exactly 20%: still open; one fewer job left decides it.
  expect(decidedReasons(flagged, "casper", tasks, () => 7)).toEqual([]);
  expect(decidedReasons(flagged, "casper", tasks, () => 6)).toEqual(["hard: flagged 2 of at most 9 right runs > 20%"]);
  // Another harness's runs never decide this one.
  expect(decidedReasons(flagged, "casper-acceptance", tasks, () => 0)).toEqual([]);
});

test("the stopper counts cost only once every task has a run of both the harness and Pi", () => {
  const slow = [run("casper", "a", false, "not_verified", 300_000), run("pi", "a", true, null), run("casper", "b", false, "failed", 300_000)];
  // Task b has no Pi run yet: a median over different tasks is no cost evidence.
  expect(decidedReasons(slow, "casper", tasks, () => 10)).toEqual([]);
  expect(decidedReasons([...slow, run("pi", "b", true, null)], "casper", tasks, () => 10)).toEqual(["hard: wall 3.00× Pi > 1.25×"]);
});
