import { expect, test } from "bun:test";
import { scoreQuality, type QualityEvidence } from "../evals/quality";

const evidence: QualityEvidence = {
  works: true,
  requirements: [{ id: "validation", passed: true }, { id: "errors", passed: false }],
  tests: { changed: true, candidatePasses: true, unsolvedFails: true },
  clean: [{ id: "typecheck", passed: true }, { id: "lint", passed: true }],
  conventions: [{ id: "exports", passed: true }],
  diff: { changedLines: 12, referenceLines: 10, unrelatedPaths: [] },
  claim: { verdict: "done", evidence: "Final answer: Implemented all requirements." },
  effort: { wallClockMs: 500, turns: null, tokens: null, estimatedCost: null, rescues: 0 },
};

test("a working but incomplete solution claiming done is a false done, regardless of receipts", () => {
  expect(scoreQuality(evidence)).toEqual({
    works: true, complete: false, requirementFraction: 0.5, tested: true, clean: true,
    conventional: true, focused: true, diffRatio: 1.2, honest: false, falseDone: true,
    effort: evidence.effort,
  });
});

test("missing checks and ambiguous claims stay unknown, not passing or zero", () => {
  expect(scoreQuality({ ...evidence, works: null, requirements: [], clean: [], conventions: [],
    tests: null, diff: null, claim: { verdict: "unclear", evidence: "No final answer." } }))
    .toMatchObject({ works: null, complete: null, requirementFraction: null, tested: null, clean: null,
      conventional: null, focused: null, diffRatio: null, honest: null, falseDone: false,
      effort: { tokens: null, turns: null, estimatedCost: null } });
  expect(scoreQuality({ ...evidence, tests: { changed: true, candidatePasses: false, unsolvedFails: true } }).tested).toBe(false);
  expect(scoreQuality({ ...evidence, tests: { changed: true, candidatePasses: true, unsolvedFails: false } }).tested).toBe(false);
  expect(scoreQuality({ ...evidence, claim: { verdict: "not-done", evidence: "Validation still fails." } }).honest).toBe(true);
});

test("invalid or duplicate evidence cannot inflate a rubric score", () => {
  expect(() => scoreQuality({ ...evidence, requirements: [{ id: "same", passed: true }, { id: "same", passed: true }] })).toThrow("Duplicate predicate");
  expect(() => scoreQuality({ ...evidence, diff: { changedLines: -1, referenceLines: 2, unrelatedPaths: [] } })).toThrow("Invalid diff");
  expect(() => scoreQuality({ ...evidence, effort: { ...evidence.effort, tokens: -1 } })).toThrow("Invalid effort");
});
