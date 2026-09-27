import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateAcceptance, gradePreparedEval, hiddenPaths, prepareEvalTask, prepareWorkdir, referenceChanges, runEvalTask, type EvalTask } from "../evals/runner";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener, RuntimeStartOptions } from "../src/runtime/types";
import { BENCHMARK_PACKS, EVAL_TASKS, packTasks } from "../evals/tasks";

const repoRoot = path.resolve(import.meta.dir, "..");
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const exists = (target: string) => stat(target).then(() => true, () => false);
async function owned(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
const benchmark = EVAL_TASKS.filter((task) => task.pack);

/** Harder tasks built so far; Tasks 2-7 each raise it by one, ending at 6. */
const HARDER_BUILT = 2;

test("the benchmark has 9 core, 9 network, 6 hard and 6 harder tasks, each on its own fixture except the two notes-api tasks", () => {
  expect(BENCHMARK_PACKS).toEqual(["core", "network", "hard", "harder"]);
  expect(packTasks("core")).toHaveLength(9);
  expect(packTasks("network")).toHaveLength(9);
  expect(packTasks("hard")).toHaveLength(6);
  expect(packTasks("harder")).toHaveLength(HARDER_BUILT);
  expect(new Set(benchmark.map((task) => task.fixture)).size).toBe(23 + HARDER_BUILT);
  // The lifecycle task shares the notes server on purpose; each task runs only its own hidden file.
  expect(benchmark.filter((task) => task.fixture === "notes-api").map((task) => [task.id, task.verify.at(-1)!.argv.slice(1).join(" ")]))
    .toEqual([["core-rest-validation", "test ./acceptance/create-note.test.ts"], ["core-service-lifecycle", "test ./acceptance/server-lifecycle.test.ts"]]);
  // The pre-benchmark catalog keeps its fixtures; packs never reuse them, so their numbers stay comparable.
  const legacy = new Set(EVAL_TASKS.filter((task) => !task.pack).map((task) => task.fixture));
  expect(benchmark.filter((task) => legacy.has(task.fixture))).toEqual([]);
});

test("every harder task states 30-35 cases: one hidden test each, under the checklist's 40-case cap", async () => {
  for (const task of packTasks("harder")) {
    const dir = path.join(repoRoot, "evals/fixtures", task.fixture, "acceptance");
    let count = 0;
    for (const file of await readdir(dir)) if (file.endsWith(".test.ts")) count += ((await Bun.file(path.join(dir, file)).text()).match(/^test\(/gm) ?? []).length;
    expect({ task: task.id, count, inRange: count >= 30 && count <= 35 }).toEqual({ task: task.id, count, inRange: true });
  }
});

test("a setup removal ending in / deletes that whole directory from the candidate", async () => {
  const root = await owned("casper-eval-hidden-root-");
  await mkdir(path.join(root, "evals/fixtures/demo/acceptance/deep"), { recursive: true });
  await mkdir(path.join(root, "evals/setups/demo/files"), { recursive: true });
  await writeFile(path.join(root, "evals/fixtures/demo/keep.txt"), "kept");
  await writeFile(path.join(root, "evals/fixtures/demo/acceptance/deep/hidden.test.ts"), "secret");
  await writeFile(path.join(root, "evals/setups/demo/remove.json"), '["acceptance/"]');
  const task: EvalTask = { id: "demo", fixture: "demo", setup: "demo", prompt: "p", verify: [], candidatePaths: [], initialVerification: "fail", acceptance: {} };
  const workdir = await prepareWorkdir(task, root);
  cleanup.push(() => rm(workdir, { recursive: true, force: true }));
  expect(await readdir(workdir)).toEqual(["keep.txt"]);
  expect(await hiddenPaths(task, root)).toEqual(["acceptance/"]);
});

test("hidden acceptance tests exist in the solved fixture, never reach the candidate, and are graded", async () => {
  for (const task of benchmark) {
    expect({ task: task.id, hidden: await hiddenPaths(task, repoRoot) }).toEqual({ task: task.id, hidden: ["acceptance/"] });
    const hidden = await readdir(path.join(repoRoot, "evals/fixtures", task.fixture, "acceptance"), { recursive: true });
    expect(hidden.some((file) => String(file).endsWith(".test.ts"))).toBe(true);
    const workdir = await prepareWorkdir(task, repoRoot);
    cleanup.push(() => rm(workdir, { recursive: true, force: true }));
    expect({ task: task.id, leaked: await exists(path.join(workdir, "acceptance")) }).toEqual({ task: task.id, leaked: false });
    expect(await exists(path.join(workdir, "CONTEXT.md"))).toBe(true);
    // The model is told hidden tests exist, never where they live.
    expect(task.prompt).not.toContain("acceptance/");
    expect(task.prompt).toContain("CONTEXT.md");
    expect(task.prompt).toContain("hidden acceptance tests");
    expect(task.verify.some((check) => check.name === "hidden acceptance" && check.argv.slice(1).join(" ").startsWith("test ./acceptance"))).toBe(true);
    expect(task.candidatePaths).not.toContain("acceptance");
  }
});

test("the reference solution satisfies every acceptance and convention predicate", async () => {
  for (const task of benchmark) {
    const changes = await referenceChanges(task, repoRoot);
    const touched = [...changes.added, ...changes.modified, ...changes.removed];
    expect({ task: task.id, touched: touched.length > 0 }).toEqual({ task: task.id, touched: true });
    expect(touched.some((entry) => entry.startsWith("acceptance/"))).toBe(false);
    const solved = await prepareWorkdir({ ...task, setup: undefined }, repoRoot);
    cleanup.push(() => rm(solved, { recursive: true, force: true }));
    await rm(path.join(solved, "acceptance"), { recursive: true, force: true });
    const context = { workdir: solved, touched, answer: "" };
    expect({ task: task.id, ...await evaluateAcceptance(task.acceptance, context) }).toEqual({ task: task.id, passed: true, failures: [] });
    expect(task.conventions?.length ?? 0).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const convention of task.conventions ?? []) {
      expect(ids.has(convention.id)).toBe(false);
      ids.add(convention.id);
      expect({ task: task.id, convention: convention.id, ...await evaluateAcceptance(convention.check, context) })
        .toEqual({ task: task.id, convention: convention.id, passed: true, failures: [] });
    }
  }
}, 120_000);

/** One scripted model turn: `act` edits the workspace, then the answer is reported. */
function scripted(act: (cwd: string) => Promise<void>): () => AgentRuntime {
  return () => ({
    async start(options: RuntimeStartOptions) {
      const listeners = new Set<RuntimeEventListener>();
      const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
      return {
        async prompt() {
          emit({ type: "assistant_response_start" });
          await act(options.cwd);
          emit({ type: "assistant_text_delta", delta: "Done." });
          emit({ type: "assistant_response_end", stopReason: "stop" });
          emit({ type: "message_end" });
        },
        async abort() {},
        subscribe(listener: RuntimeEventListener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        getState: () => ({ cwd: options.cwd, isStreaming: false }),
      };
    },
    async dispose() {},
  });
}

test("through the real grader, the reference solution is accepted and an untouched workspace is not", async () => {
  for (const task of benchmark) {
    const solve = scripted(async (cwd) => {
      for (const top of task.candidatePaths) {
        await rm(path.join(cwd, top), { recursive: true, force: true });
        await cp(path.join(repoRoot, "evals/fixtures", task.fixture, top), path.join(cwd, top), { recursive: true });
      }
    });
    const solved = await runEvalTask(task, { repoRoot, runtimeFactory: solve, autoVerify: false });
    expect({ task: task.id, success: solved.success, failures: solved.acceptance.failures, checks: solved.verification.checks.filter((check) => check.status !== "pass").map((check) => check.output.slice(-400)) })
      .toEqual({ task: task.id, success: true, failures: [], checks: [] });
    const idle = await runEvalTask(task, { repoRoot, runtimeFactory: scripted(async () => {}), autoVerify: false });
    expect({ task: task.id, success: idle.success, hidden: idle.verification.checks.find((check) => check.name === "hidden acceptance")?.status })
      .toEqual({ task: task.id, success: false, hidden: "fail" });
  }
}, 300_000);

test("a task that needs TypeScript gets a working `bun run typecheck` in the candidate, for every harness", async () => {
  const typed = benchmark.filter((task) => task.tools?.includes("typescript"));
  expect(typed.map((task) => task.id)).toEqual(["core-refactor-across-files"]);
  for (const task of typed) {
    const workdir = await prepareWorkdir(task, repoRoot);
    cleanup.push(() => rm(workdir, { recursive: true, force: true }));
    const run = Bun.spawnSync([process.execPath, "run", "typecheck"], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
    expect({ task: task.id, exit: run.exitCode, output: `${run.stdout}${run.stderr}`.slice(-300) }).toMatchObject({ task: task.id, exit: 0 });
  }
});

test("a prepared task with linked tools can still be graded offline; only the candidate gets the tools", async () => {
  const task = benchmark.find((entry) => entry.tools?.includes("typescript"))!;
  const { root, workdir } = await prepareEvalTask(task, repoRoot);
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  expect(await exists(path.join(workdir, "node_modules/.bin/tsc"))).toBe(true);
  expect(await exists(path.join(root, "evaluator/node_modules"))).toBe(false);
  for (const top of task.candidatePaths) {
    await rm(path.join(workdir, top), { recursive: true, force: true });
    await cp(path.join(repoRoot, "evals/fixtures", task.fixture, top), path.join(workdir, top), { recursive: true });
  }
  const result = await gradePreparedEval(root, { startedAt: new Date().toISOString(), wallClockMs: 1, execution: "completed", modelCalls: 1, answer: "Done.", interventions: [] });
  expect({ success: result.success, failures: result.acceptance.failures }).toEqual({ success: true, failures: [] });
});
