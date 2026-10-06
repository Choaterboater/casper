import { afterEach, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BenchmarkRun } from "../evals/benchmark";
import { baseOutcome, replayAcceptance, replayedOutcome, replayStopReasons, type ReplayRun } from "../evals/replay";
import { prepareWorkdir } from "../evals/runner";
import { findEvalTask } from "../evals/tasks";
import type { AcceptanceCompletion } from "../src/verify/acceptance";
import { removeTempDir } from "./support/temp-dir";

const repoRoot = path.resolve(import.meta.dir, "..");
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** A saved hard-pack run: the grader's verdict, the receipt (and its own acceptance check) and a kept workspace. */
const saved = (fields: { harness?: BenchmarkRun["harness"]; success: boolean; receiptOutcome: string | null; receiptAcceptance?: { status: string };
  workspace?: string; wallClockMs?: number; phases?: { phase: "acceptance"; durationMs: number }[]; receiptProof?: string | null }): BenchmarkRun => {
  const { harness = "casper", success, receiptOutcome, receiptAcceptance, workspace, wallClockMs = 100_000, phases, receiptProof } = fields;
  return {
    taskId: "hard-job-queue", pack: "hard", harness, repeat: 1, graded: { success },
    run: { termination: "completed", exitCode: 0, errors: [], wallClockMs, receiptOutcome, ...(receiptAcceptance ? { receiptAcceptance } : {}), ...(phases ? { phases } : {}),
      ...(receiptProof !== undefined ? { receiptProof } : {}) },
    score: { effort: { wallClockMs, turns: 1, tokens: 1000, estimatedCost: null, rescues: 0 } }, ...(workspace ? { workspace } : {}),
  } as unknown as BenchmarkRun;
};

test("a failing replayed check turns only a verified receipt into not_verified", () => {
  expect(replayedOutcome("verified", { status: "fail" })).toBe("not_verified");
  expect(replayedOutcome("verified", { status: "pass" })).toBe("verified");
  // A check that could not run is no evidence against the change.
  expect(replayedOutcome("verified", { status: "error" })).toBe("verified");
  expect(replayedOutcome("failed", { status: "fail" })).toBe("failed");
  expect(replayedOutcome(null, null)).toBeNull();
});

test("the replay judges the receipt without the saved run's own acceptance verdict", () => {
  expect(baseOutcome(saved({ success: true, receiptOutcome: "not_verified", receiptAcceptance: { status: "fail" } }))).toBe("verified");
  expect(baseOutcome(saved({ success: true, receiptOutcome: "not_verified", receiptAcceptance: { status: "pass" } }))).toBe("not_verified");
  // Warn mode never downgraded: the receipt already is the base.
  expect(baseOutcome(saved({ success: true, receiptOutcome: "verified", receiptAcceptance: { status: "fail" } }))).toBe("verified");
  // v0.2.17 on, "verified" needs a proven change: without one the base stays not_verified.
  expect(baseOutcome(saved({ success: true, receiptOutcome: "not_verified", receiptAcceptance: { status: "fail" }, receiptProof: null }))).toBe("not_verified");
  expect(baseOutcome(saved({ success: true, receiptOutcome: "not_verified", receiptAcceptance: { status: "fail" }, receiptProof: "skipped" }))).toBe("not_verified");
  expect(baseOutcome(saved({ success: true, receiptOutcome: "not_verified", receiptAcceptance: { status: "fail" }, receiptProof: "proven" }))).toBe("verified");
});

test("the replay stopper waits until every replayed harness is decided", () => {
  const replayed = (outcome: string) => ({ replayOutcome: outcome } as ReplayRun);
  const flaggedRight = { original: saved({ success: true, receiptOutcome: "verified" }), replay: replayed("not_verified") };
  const other = saved({ harness: "casper-acceptance", success: true, receiptOutcome: "verified" });
  // casper: 1 flagged of 1 right with nothing left is decided; casper-acceptance still has a run to go.
  expect(replayStopReasons([flaggedRight, { original: other }])).toEqual([]);
  expect(replayStopReasons([flaggedRight, { original: other, replay: replayed("not_verified") }]))
    .toEqual(["hard casper: flagged 1 of at most 1 right runs > 20%", "hard casper-acceptance: flagged 1 of at most 1 right runs > 20%"]);
});

test("replay reruns the check on a kept workspace from the unsolved start and rewrites only verified receipts", async () => {
  const task = findEvalTask("hard-job-queue")!;
  const kept = await prepareWorkdir(task, repoRoot);
  cleanup.push(() => removeTempDir(kept));
  await writeFile(path.join(kept, "src/queue.ts"), "export const changed = true;\n", { flag: "a" });
  // Saved documents redact the temp directory (writeEvalReport); the replay restores it.
  const workspace = `<tmp>/${path.relative(os.tmpdir(), kept)}`;
  const answers = ["```ts\nimport { expect, test } from \"bun:test\";\ntest(\"'fails'\", () => expect(1).toBe(2));\n```", "```ts\nimport { expect, test } from \"bun:test\";\ntest(\"'holds'\", () => expect(1).toBe(1));\n```"];
  const prompts: string[] = [];
  const complete = (model: string): AcceptanceCompletion => async (input) => {
    prompts.push(`${model}\n${input.user}`);
    return { text: answers.shift()!, usage: { tokens: 42, estimatedCost: 0.001 } };
  };
  const result = await replayAcceptance({
    repoRoot, concurrency: 1, timeoutMs: 60_000, stopWhenDecided: false, complete,
    sources: [{ file: "saved.json", model: "openrouter/some/model", route: ["Together"], runs: [
      saved({ success: false, receiptOutcome: "verified", workspace }),
      saved({ success: false, receiptOutcome: "failed", workspace }),
      // Flagged by its own check, which the replay replaces; its 30 s acceptance phase leaves the wall estimate.
      saved({ harness: "casper-acceptance", success: true, receiptOutcome: "not_verified", receiptAcceptance: { status: "fail" }, workspace, phases: [{ phase: "acceptance", durationMs: 30_000 }] }),
      saved({ success: true, receiptOutcome: "verified" }),
      saved({ harness: "pi", success: true, receiptOutcome: null, wallClockMs: 50_000 }),
    ] }],
  });
  expect(result.failures).toEqual([]);
  expect(result.withoutWorkspace).toBe(1);
  expect(result.runs.map((run) => [run.harness, run.receiptOutcome, run.replayOutcome, run.acceptance?.status ?? run.skipped]))
    .toEqual([["casper", "verified", "not_verified", "fail"], ["casper", "failed", "failed", "receipt failed"], ["casper-acceptance", "not_verified", "verified", "pass"]]);
  // The request, the workspace's own test command with the file appended, and the change from the unsolved start.
  expect(prompts[0]).toStartWith(`openrouter/some/model\nRequest:\n${task.prompt}`);
  expect(prompts[0]).toMatch(/run with: bun run test \.\/tests\/casper-acceptance-[0-9a-f]{8}\.test\.ts$/);
  expect(prompts[0]).toContain("Changed file src/queue.ts:");
  const acceptance = result.runs.find((run) => run.harness === "casper-acceptance")!;
  expect(acceptance.estimatedWallClockMs).toBe(100_000 - 30_000 + acceptance.acceptance!.durationMs);
  const casper = result.cells.find((cell) => cell.harness === "casper")!;
  expect({ caught: casper.receipt.caught, wrong: casper.receipt.wrong, flagged: casper.receipt.flagged, checked: casper.checked, tokens: casper.acceptanceTokens })
    .toEqual({ caught: 2, wrong: 2, flagged: 0, checked: { pass: 0, fail: 1, error: 0 }, tokens: 42 });
  expect(casper.estimatedWallRatio).toBeGreaterThan(2);
  // The kept workspace is evidence: the replay works on a copy.
  expect((await readdir(path.join(kept, "tests"))).some((name) => name.startsWith("casper-acceptance-"))).toBe(false);
}, 120_000);
