import { expect, test } from "bun:test";
import { futility, type ReceiptCell } from "../evals/benchmark";

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
