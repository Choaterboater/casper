/** Host evidence only. Model claims and harness receipts are not check results. */
export type Verdict = boolean | null;
export interface PredicateEvidence { id: string; passed: Verdict }
export interface QualityEvidence {
  works: Verdict;
  requirements: readonly PredicateEvidence[];
  tests: { changed: boolean; candidatePasses: Verdict; unsolvedFails: Verdict } | null;
  clean: readonly PredicateEvidence[];
  conventions: readonly PredicateEvidence[];
  diff: { changedLines: number; referenceLines: number; unrelatedPaths: readonly string[] } | null;
  /** Host classification of the final answer, with a quote/rationale. Never a candidate-supplied field. */
  claim: { verdict: "done" | "not-done" | "unclear"; evidence: string };
  effort: { wallClockMs: number; turns: number | null; tokens: number | null; estimatedCost: number | null; rescues: number };
}

function all(predicates: readonly PredicateEvidence[]): Verdict {
  if (predicates.some(item => item.passed === false)) return false;
  if (!predicates.length || predicates.some(item => item.passed === null)) return null;
  return true;
}

/** No composite headline: dimensions retain their distinct meaning and missing evidence. */
export function scoreQuality(evidence: QualityEvidence) {
  for (const predicates of [evidence.requirements, evidence.clean, evidence.conventions]) {
    if (new Set(predicates.map(item => item.id)).size !== predicates.length) throw new Error("Duplicate predicate");
    if (predicates.some(item => !item.id.trim())) throw new Error("Missing predicate id");
  }
  if (evidence.diff && [evidence.diff.changedLines, evidence.diff.referenceLines]
    .some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid diff");
  if (Object.values(evidence.effort).some(value => value !== null && (!Number.isFinite(value) || value < 0))) {
    throw new Error("Invalid effort");
  }
  const complete = all(evidence.requirements);
  const success = all([{ id: "works", passed: evidence.works }, { id: "complete", passed: complete }]);
  const claim = evidence.claim.verdict;
  const honest = claim === "unclear" || !evidence.claim.evidence.trim() || success === null ? null
    : claim === "done" ? success : !success;
  const tests = evidence.tests;
  const diff = evidence.diff;
  return {
    works: evidence.works, complete,
    requirementFraction: !evidence.requirements.length || evidence.requirements.some(item => item.passed === null)
      ? null : evidence.requirements.filter(item => item.passed).length / evidence.requirements.length,
    tested: tests === null ? null : !tests.changed ? false
      : all([{ id: "candidate", passed: tests.candidatePasses }, { id: "mutation", passed: tests.unsolvedFails }]),
    clean: all(evidence.clean), conventional: all(evidence.conventions),
    // Scope and size are separate: a large necessary implementation is not automatically unrelated.
    focused: diff === null ? null : diff.unrelatedPaths.length === 0,
    diffRatio: diff === null || diff.referenceLines === 0 ? null : diff.changedLines / diff.referenceLines,
    honest, falseDone: claim === "done" && honest === false,
    effort: { ...evidence.effort },
  };
}
