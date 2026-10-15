import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { shardFiles, suiteFiles } from "../tools/test-shard";
import { heavyReason, loadTimings } from "../tools/test-tier";
import { terminalArgs, terminalReason } from "../tools/test-terminal";
import { suiteArgs } from "../tools/test-suite";
import { windowsProofProblems } from "../tools/windows-ci-proof";

const workflow = () => parse(readFileSync(".github/workflows/windows-preview.yml", "utf8"));

test("Windows suite uses six balanced two-worker shards with an 18-minute step inside a 25-minute job", async () => {
  const job = workflow().jobs.suite;
  expect(job.strategy.matrix.part).toEqual([1, 2, 3, 4, 5, 6]);
  expect(job.strategy["fail-fast"]).toBe(false);
  expect(job["timeout-minutes"]).toBe(25);
  const suite = job.steps.find((step: { name?: string }) => step.name?.startsWith("Regression suite"));
  expect(suite["timeout-minutes"]).toBe(18);
  expect(suite.run).toContain("bun tools/test-shard.ts 6 ${{ matrix.part }} $env:TIER");
  expect(suite.run).toContain("bun test --parallel=2 --timings=tests/timings.json @files");
  expect(suite.run).not.toMatch(/--retry|--rerun-each/);
  expect(suite.run).toContain("if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }");
  const files = await suiteFiles("tests", "parallel"), timings = loadTimings();
  const known = files.flatMap(file => timings[file] === undefined ? [] : [timings[file]!]);
  const average = known.reduce((sum, ms) => sum + ms, 0) / known.length;
  const shards = [1, 2, 3, 4, 5, 6].map(index => shardFiles(files, timings, 6, index));
  expect(shards.flat().sort()).toEqual(files);
  expect(new Set(shards.flat()).size).toBe(files.length);
  const totals = shards.map(shard => shard.reduce((sum, file) => sum + (timings[file] ?? average), 0));
  expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(Math.max(...known));
  // Historical timings are a sizing check, not proof of Windows wall time; the real run is checked separately.
  expect(Math.max(...totals) / 2).toBeLessThan(suite["timeout-minutes"] * 60_000);
  for (const start of ["Real debugger test", "Eval bench tests"]) {
    const step = job.steps.find((step: { name?: string }) => step.name?.startsWith(start));
    expect(step["timeout-minutes"]).toBe(3);
    expect(job["timeout-minutes"] - suite["timeout-minutes"] - step["timeout-minutes"]).toBeGreaterThanOrEqual(4);
  }
});

test("every OS keeps real-terminal and ConPTY files in a separate serial source job", async () => {
  const all = await suiteFiles(), parallel = await suiteFiles("tests", "parallel"), terminal = await suiteFiles("tests", "terminal");
  expect([...parallel, ...terminal].sort()).toEqual(all);
  expect(parallel.filter(file => terminal.includes(file))).toEqual([]);
  // A new terminal file must not be silently filtered out of a fast tier while the serial job is skipped.
  for (const file of terminal) expect(heavyReason(file, readFileSync(file, "utf8"), {})).toBeDefined();
  for (const name of ["windows-screen", "login", "model-selection", "model-servers-terminal", "plan-terminal", "private-tmux", "terminal-ux"]) expect(terminal).toContain(`tests/${name}.test.ts`);
  expect(terminalReason("tests/a.test.ts", 'await import("./support/outer")', () => 'import "./pty";')).toContain("pty");
  expect(terminalReason("tests/a.test.ts", 'import "./support/ansi-cells";', () => "")).toBeUndefined();
  const args = terminalArgs(terminal);
  expect(args).toContain("--max-concurrency=1");
  expect(args).toContain("--retry=1");
  expect(args).toContain("--timeout=120000");
  expect(args.some(arg => /^--parallel/.test(arg))).toBe(false);
  const parallelArgs = suiteArgs(parallel, [], 4);
  expect(parallelArgs).toContain("--parallel=4");
  for (const workers of [1, 2, 3, 4, 8]) expect(suiteArgs(parallel, [], workers)[1]).toBe(`--parallel=${Math.min(4, workers)}`);
  for (const workers of [0, -1, 1.5]) expect(() => suiteArgs(parallel, [], workers)).toThrow("positive integer");
  expect(parallelArgs.slice(3)).toEqual(parallel.map(file => `./${file}`));
  expect(suiteArgs(parallel, ["--update-timings"])).toContain("--update-timings");
  expect(() => suiteArgs([])).toThrow("no test files");
  for (const os of ["linux", "macos"]) {
    const preview = parse(readFileSync(`.github/workflows/${os}-preview.yml`, "utf8"));
    const source = preview.jobs.source, serial = preview.jobs.terminal;
    expect(source["timeout-minutes"]).toBe(os === "linux" ? 18 : 25);
    expect(source.steps.some((step: { run?: string }) => step.run?.includes("bun run test:terminal"))).toBe(false);
    expect(serial["timeout-minutes"]).toBe(20);
    const step = serial.steps.find((step: { run?: string }) => step.run?.includes("bun run test:terminal"));
    expect(step["timeout-minutes"]).toBe(15);
    expect(step.run).toContain("terminal.log");
    expect(serial.steps.map((step: { run?: string }) => step.run ?? "").join("\n")).toMatch(/(?:apt-get install|brew install)[^\n]*tmux/);
    expect(serial.steps.some((step: { if?: string; uses?: string }) => step.if === "always()" && step.uses?.startsWith("actions/upload-artifact@"))).toBe(true);
    if (os === "macos") {
      expect(serial.needs).toBe("source");
      expect(source.outputs.tier).toBe("${{ steps.tier.outputs.tier }}");
      expect(serial.if).toContain("needs.source.outputs.tier != 'fast'");
      expect(serial.if).toContain("!cancelled()");
    }
  }
  const job = workflow().jobs.terminal;
  expect(job.if).toBe("${{ !cancelled() && needs.changes.outputs.tier != 'fast' }}");
  expect(job.needs).toBe("changes");
  const step = job.steps.find((step: { name?: string }) => step.name?.startsWith("Serial real-terminal lane"));
  expect(step.run).toContain("bun run test:terminal");
  expect(step["timeout-minutes"]).toBe(15);
  expect(job["timeout-minutes"]).toBe(20);
  expect(job.steps.some((step: { if?: string; uses?: string }) => step.if === "always()" && step.uses?.startsWith("actions/upload-artifact@"))).toBe(true);
});

test("full Windows proof requires all six shards, terminals and build green at the exact SHA on attempt one", () => {
  const sha = "a".repeat(40);
  const run = { path: ".github/workflows/windows-preview.yml", event: "workflow_dispatch", status: "completed", conclusion: "success", head_sha: sha, run_attempt: 1 };
  const jobs = ["changes", "standalone", "terminal", ...[1, 2, 3, 4, 5, 6].map(part => `suite (${part})`)]
    .map(name => ({ name, status: "completed", conclusion: "success" }));
  expect(windowsProofProblems(run, jobs, sha)).toEqual([]);
  for (const changed of [{ run_attempt: 2 }, { event: "pull_request" }, { head_sha: "b".repeat(40) }, { status: "in_progress" }, { conclusion: "failure" }, { path: ".github/workflows/linux-preview.yml" }]) {
    expect(windowsProofProblems({ ...run, ...changed }, jobs, sha).length).toBeGreaterThan(0);
  }
  for (const name of jobs.map(job => job.name)) {
    expect(windowsProofProblems(run, jobs.filter(job => job.name !== name), sha).length).toBeGreaterThan(0);
    for (const conclusion of ["failure", "skipped", "cancelled"]) expect(windowsProofProblems(run, jobs.map(job => job.name === name ? { ...job, conclusion } : job), sha).length).toBeGreaterThan(0);
  }
  expect(windowsProofProblems(run, [...jobs, jobs[0]!], sha).length).toBeGreaterThan(0);
});
