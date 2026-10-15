import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { verifySshSignature } from "../src/update/signature";
import { suiteFiles } from "../tools/test-shard";
import { decide, tiers } from "../tools/test-tier";
import { posixOnly } from "./support/platform";
import { sshKeygenVerifies } from "./support/release-signing";
import { removeTempDir } from "./support/temp-dir";

/**
 * Casper's own CI: every action is pinned to a commit, and the job that may write a release runs
 * no project code. A moved tag or a poisoned install step can then never publish on its own.
 */

const DIR = path.resolve(import.meta.dir, "../.github/workflows");
const files = readdirSync(DIR).filter((name) => /\.ya?ml$/.test(name));

interface Step { uses?: string; run?: string; name?: string; id?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; "timeout-minutes"?: number }
interface Job { "timeout-minutes"?: number; permissions?: Record<string, string>; steps: Step[]; needs?: string | string[]; if?: string; env?: Record<string, string>; outputs?: Record<string, string> }
interface Workflow { on?: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> }
const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await removeTempDir(dir); });
const load = (name: string): Workflow => parse(readFileSync(path.join(DIR, name), "utf8")) as Workflow;

test("every action in every workflow is pinned to a full commit", () => {
  expect(files.length).toBeGreaterThan(0);
  const loose: string[] = [];
  for (const name of files) {
    for (const [jobName, job] of Object.entries(load(name).jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(step.uses)) loose.push(`${name} ${jobName}: ${step.uses}`);
      }
    }
  }
  expect(loose).toEqual([]);
});

test("the release job that can write runs no project code, and the build waits for green previews", () => {
  const workflow = load("publish-release.yml");
  expect(workflow.permissions ?? {}).toEqual({});
  const writers = Object.entries(workflow.jobs).filter(([, job]) => job.permissions?.contents === "write");
  expect(writers.map(([name]) => name)).toEqual(["publish"]);
  const publish = writers[0]![1];
  for (const step of publish.steps) {
    expect(step.uses ?? "").not.toContain("actions/checkout");
    expect(step.uses ?? "").not.toContain("setup-bun");
    expect(step.run ?? "").not.toMatch(/\bbun\b|\bnpm\b|\bnode\b/);
  }
  expect(publish.needs).toBe("build");
  const build = workflow.jobs.build!;
  expect(build.permissions).toEqual({ contents: "read", actions: "read" });
  const checkout = build.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout?.with?.["persist-credentials"]).toBe(false);
  const gate = build.steps.findIndex((step) => /linux-preview\.yml/.test(step.run ?? "") && /windows-preview\.yml/.test(step.run ?? ""));
  const install = build.steps.findIndex((step) => /bun install/.test(step.run ?? ""));
  expect(gate).toBeGreaterThanOrEqual(0);
  expect(gate).toBeLessThan(install);
});

test("the publish job signs where the build came from over SHA256SUMS, and only it may", () => {
  const workflow = load("publish-release.yml");
  const publish = workflow.jobs.publish!;
  expect(publish.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
  const attest = publish.steps.find((step) => step.uses?.startsWith("actions/attest-build-provenance@"));
  expect(attest?.with?.["subject-checksums"]).toBe("dist/release/SHA256SUMS");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== "publish") expect(job.permissions?.["id-token"]).toBeUndefined();
  }
  // No tags on red CI: the build waits for every preview, macOS included.
  const gate = workflow.jobs.build!.steps.find((step) => /linux-preview\.yml/.test(step.run ?? ""));
  expect(gate?.run).toContain("macos-preview.yml");
});

test("every checkout drops its token, no workflow writes by default, and no input lands inside a run script", () => {
  for (const name of files) {
    const workflow = load(name);
    for (const value of Object.values(workflow.permissions ?? {})) expect(value).not.toBe("write");
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/checkout@")) expect(step.with?.["persist-credentials"]).toBe(false);
        expect(step.run ?? "").not.toMatch(/\$\{\{\s*(?:inputs\.|github\.event\.)/);
      }
    }
  }
});

test("Linux and macOS CI run the live sandbox tests", () => {
  const linux = load("linux-preview.yml").jobs.source!.steps.map((step) => step.run ?? "").join("\n");
  expect(linux).toContain("apt-get install -y -q bubblewrap socat ripgrep");
  expect(linux).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
  expect(linux).toContain("tests/sandbox-live.test.ts");
  // zizmor, from the same hash-locked file Casper installs it from, audits these workflows.
  expect(linux).toContain("--require-hashes --no-deps -r src/security/locks/zizmor.txt");
  expect(linux).toContain("zizmor\" --offline .github/workflows");
  const mac = load("macos-preview.yml");
  const macRun = Object.values(mac.jobs)[0]!.steps.map((step) => step.run ?? "").join("\n");
  expect(macRun).toContain("tests/sandbox-live.test.ts");
  // The live tests' unlisted host (127.0.0.2) is on lo0, and Pi's grep finds ripgrep.
  expect(macRun).toContain("sudo ifconfig lo0 alias 127.0.0.2 up");
  expect(macRun).toContain("brew install ripgrep");
});

test("the full suite runs files in parallel, slowest first, with the eval tests in their own script; CI uses it", () => {
  const scripts = (JSON.parse(readFileSync(path.resolve(import.meta.dir, "../package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  expect(scripts["test:suite"]).toBe("bun tools/test-suite.ts");
  const runner = readFileSync(path.resolve(import.meta.dir, "../tools/test-suite.ts"), "utf8");
  expect(runner).toContain("workers = availableParallelism()");
  expect(runner).toContain("Math.min(4, workers)");
  expect(runner).toContain('"--timings=tests/timings.json"');
  expect(runner).toContain('suiteFiles("tests", "parallel")');
  // Terminal users and the real debugger never share the parallel workers.
  expect(scripts.test).toBe("bun run test:suite && bun run test:terminal && bun test tests/phase10-debugger-real.test.ts");
  expect(scripts["test:timings"]).toBe("bun tools/test-suite.ts --update-timings && bun tools/test-terminal.ts --update-timings");
  expect(scripts["test:evals"]).toContain("tests/eval-");
  expect(scripts["test:fast"]).toBeUndefined();
  for (const name of ["linux-preview.yml", "macos-preview.yml"]) {
    const runs = Object.values(load(name).jobs).flatMap((job) => (job.steps ?? []).map((step) => step.run ?? ""));
    // Through tools/stall-guard.sh (which stops a run that goes silent, dumps what it was doing and retries
    // the stuck file once). The suite and the real debugger test are separate steps, so a retried stall still
    // runs the debugger test; a file a workflow leaves out of the suite runs in a step of its own.
    const guarded = (command: string) => runs.map((run) => new RegExp(`^bash tools/stall-guard\\.sh .* -- ${command}\\s*$`).exec(run)).find(Boolean);
    const suite = runs.map((run) => /^bash tools\/stall-guard\.sh .* -- bun run test:suite((?: --path-ignore-patterns='[^']+')*)\s*$/.exec(run)).find(Boolean);
    expect(suite, name).toBeDefined();
    expect(guarded("bun test tests/phase10-debugger-real\\.test\\.ts"), name).toBeDefined();
    for (const [, left] of suite![1]!.matchAll(/--path-ignore-patterns='([^']+)'/g)) {
      expect(guarded(`bun test ${left!.replaceAll(".", "\\.")}`), `${name}: ${left}`).toBeDefined();
    }
    expect(runs.some((run) => /^bun test 2>&1/.test(run))).toBe(false);
  }
  // macOS runs the browser test on its own after the suite: under load there it grew to 300 s and ran last.
  const mac = Object.values(load("macos-preview.yml").jobs).flatMap((job) => job.steps.map((step) => step.run ?? "")).join("\n");
  expect(mac).toContain("-- bun run test:suite --path-ignore-patterns='tests/phase10-browser.test.ts'");
  // Windows runs each part on two workers: spawned CLIs and servers need CPU/memory headroom.
  const windows = load("windows-preview.yml").jobs.suite!.steps.map((step) => step.run ?? "").join("\n");
  expect(windows).toMatch(/bun test --parallel=2 --timings=tests\/timings\.json @files/);
});

test("the release counts only whole-suite runs: a push, nightly or manual run on Linux, macOS and Windows, never a pull request's", () => {
  const gate = load("publish-release.yml").jobs.build!.steps.find((step) => /linux-preview\.yml/.test(step.run ?? ""))!.run!;
  for (const name of ["linux-preview.yml", "macos-preview.yml", "windows-preview.yml"]) expect(gate).toContain(name);
  expect(gate).toContain('select(.event == "push" or .event == "schedule" or .event == "workflow_dispatch")');
  expect(gate).toContain('[ "$conclusion" = success ]');
  // Those events always choose the whole suite.
  for (const event of ["push", "schedule", "workflow_dispatch"]) expect(decide(event, [], new Set()).tier).toBe("full");
});

test("every preview runs nightly, and a pull request on macOS or Windows always runs at least the fast tier", async () => {
  for (const name of ["linux-preview.yml", "macos-preview.yml", "windows-preview.yml"]) {
    const on = load(name).on as { schedule?: Array<{ cron: string }>; push?: unknown; workflow_dispatch?: unknown };
    expect(on.schedule?.[0]?.cron, name).toBe("17 3 * * *");
    expect(on.push, name).toBeDefined();
    expect(on.workflow_dispatch, name).toBeDefined();
  }
  // The tier comes from the event and the PR's own diff, and is only ever "full" or "fast".
  const tierStep = (steps: Step[]) => steps.find((step) => step.id === "tier")!;
  const mac = load("macos-preview.yml").jobs.source!;
  const windows = load("windows-preview.yml");
  for (const step of [tierStep(mac.steps), tierStep(windows.jobs.changes!.steps)]) {
    expect(step.env?.EVENT).toBe("${{ github.event_name }}");
    // --no-renames: a moved file lists its old path too, so a file moved out of an OS path still counts.
    expect(step.run).toContain("git diff --no-renames --name-only HEAD^1 HEAD");
    expect(step.run).toContain('bun tools/test-tier.ts decide "$EVENT"');
    expect(step.run).toContain("case \"$tier\" in full | fast) ;; *)");
    expect(step.run).toContain("GITHUB_STEP_SUMMARY");
  }
  // macOS: the whole suite when full, the fast tier when fast; heavy-only steps run only when full.
  const ifOf = (start: string) => mac.steps.find((step) => step.name?.startsWith(start))?.if ?? "";
  expect(ifOf("Full regression suite")).toContain("steps.tier.outputs.tier == 'full'");
  expect(ifOf("Fast tier of the suite")).toContain("steps.tier.outputs.tier == 'fast'");
  const fast = mac.steps.find((step) => step.name?.startsWith("Fast tier of the suite"))!;
  expect(fast.run).toContain('files="$(bun tools/test-tier.ts fast)"');
  expect(fast.run).toMatch(/bash tools\/stall-guard\.sh .* -- bun test --parallel --timings=tests\/timings\.json \$files/);
  for (const start of ["The shell sandbox", "Browser test", "Real debugger test"]) expect(ifOf(start), start).toContain("steps.tier.outputs.tier == 'full'");
  // Windows: six parts always run; source terminals and the build/installer job run only when full.
  expect(windows.jobs.suite!.needs).toBe("changes");
  // If the changes job fails, the parts still run, the whole suite, and the build job too: a job skipped
  // because a needed job failed would count as passed for a required check.
  expect(windows.jobs.suite!.if).toBe("${{ !cancelled() }}");
  expect(windows.jobs.suite!.env?.TIER).toBe("${{ needs.changes.outputs.tier || 'full' }}");
  expect(windows.jobs.suite!.steps.map((step) => step.run ?? "").join("\n")).toContain("bun tools/test-shard.ts 6 ${{ matrix.part }} $env:TIER");
  expect(windows.jobs.terminal!.if).toBe("${{ !cancelled() && needs.changes.outputs.tier != 'fast' }}");
  expect(windows.jobs.standalone!.if).toBe("${{ !cancelled() && needs.changes.outputs.tier != 'fast' }}");
  expect(windows.jobs.changes!.if).toBeUndefined();
  // No suite file is left out of every tier.
  const { fast: quick, heavy } = await tiers();
  expect([...quick, ...heavy].sort()).toEqual(await suiteFiles());
});

test("the build lists both installers in SHA256SUMS, and only the publish job's signing step sees the release key", () => {
  const workflow = load("publish-release.yml");
  const verify = workflow.jobs.build!.steps.find((step) => step.name === "Verify the build");
  expect(verify?.run).toMatch(/casper-windows-arm64\.exe install\.sh install\.ps1; do/);
  const users = files.flatMap((name) => readFileSync(path.join(DIR, name), "utf8").includes("secrets.RELEASE_SIGNING_KEY") ? [name] : []);
  expect(users).toEqual(["publish-release.yml"]);
  const steps = workflow.jobs.publish!.steps;
  const signing = steps.filter((step) => JSON.stringify(step).includes("secrets.RELEASE_SIGNING_KEY"));
  expect(signing.map((step) => step.name)).toEqual(["Sign SHA256SUMS with the release key"]);
  // Signed after the provenance and before anything is published.
  const at = (find: (step: Step) => boolean) => steps.findIndex(find);
  expect(at((step) => step.uses?.startsWith("actions/attest-build-provenance@") ?? false)).toBeLessThan(at((step) => step === signing[0]));
  expect(at((step) => step === signing[0])).toBeLessThan(at((step) => /gh release create/.test(step.run ?? "")));
});

/** Runs the workflow's signing step in a temp folder, the way the runner would. */
async function runSigningStep(pinned: string, secret: string) {
  const step = load("publish-release.yml").jobs.publish!.steps.find((each) => each.name === "Sign SHA256SUMS with the release key")!;
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-sign-step-"));
  temps.push(root);
  await mkdir(path.join(root, "dist/release"), { recursive: true });
  await writeFile(path.join(root, "dist/release/SHA256SUMS"), `${"a".repeat(64)}  casper-linux-x64\n`);
  await writeFile(path.join(root, "dist/release/install.sh"), `#!/bin/sh\nRELEASE_KEY='${pinned}'\n`);
  const child = Bun.spawn(["bash", "-e", "-c", step.run!], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", RUNNER_TEMP: root, RELEASE_SIGNING_KEY: secret }, stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const signature = await readFile(path.join(root, "dist/release/SHA256SUMS.sig"), "utf8").catch(() => undefined);
  const leftovers = (await readdir(root)).filter((name) => name === "release-key");
  return { stdout, exitCode, signature, sums: await readFile(path.join(root, "dist/release/SHA256SUMS"), "utf8"), leftovers };
}

/** A throwaway OpenSSH key pair made by ssh-keygen in a temp folder (tests only). */
async function throwawayKey(): Promise<{ privateKey: string; publicKey: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-throwaway-key-"));
  temps.push(dir);
  const made = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", path.join(dir, "key")], { stdout: "pipe", stderr: "pipe" });
  expect(made.exitCode).toBe(0);
  return { privateKey: await readFile(path.join(dir, "key"), "utf8"), publicKey: (await readFile(path.join(dir, "key.pub"), "utf8")).trim().split(" ").slice(0, 2).join(" ") };
}

test.skipIf(process.platform === "win32" || !sshKeygenVerifies())("the signing step signs with the secret, checks it against the pinned key, and stops on any mismatch", async () => {
  // No key yet: a warning, nothing signed, the release goes on.
  const none = await runSigningStep("", "");
  expect(none.exitCode).toBe(0);
  expect(none.stdout).toContain("No release key yet");
  expect(none.signature).toBeUndefined();

  const key = await throwawayKey(), other = await throwawayKey();
  const good = await runSigningStep(key.publicKey, key.privateKey);
  expect(good.exitCode).toBe(0);
  expect(verifySshSignature(good.sums, good.signature!, key.publicKey)).toBe(true);
  expect(good.leftovers).toEqual([]);

  // A secret that is not the pinned key's other half, a pinned key with no secret, or a secret with no pinned key: stop.
  expect((await runSigningStep(key.publicKey, other.privateKey)).exitCode).not.toBe(0);
  expect((await runSigningStep(key.publicKey, "")).exitCode).not.toBe(0);
  expect((await runSigningStep("", key.privateKey)).exitCode).not.toBe(0);
});

test("Linux runs the suite when only docs, the site or the README change, since tests read them", () => {
  const on = load("linux-preview.yml").on as { push: { paths: string[] }; pull_request: { paths: string[] } };
  for (const trigger of [on.push, on.pull_request]) for (const path of ["docs/**", "site/**", "README.md"]) expect(trigger.paths).toContain(path);
});

test("a stuck preview run is cut off in minutes, not at the old 30 to 45 minute job limit, and the evidence is still kept", () => {
  for (const name of ["linux-preview.yml", "macos-preview.yml", "windows-preview.yml", "windows-arm64.yml"]) {
    for (const [jobName, job] of Object.entries(load(name).jobs)) {
      // macOS and the rebalanced Windows suite allow 25 minutes; other jobs stay at 20 or less.
      const ceiling = name === "macos-preview.yml" || name === "windows-preview.yml" && jobName === "suite" ? 25 : 20;
      expect(job["timeout-minutes"], `${name} ${jobName}`).toBeLessThanOrEqual(ceiling);
    }
  }
  for (const name of ["linux-preview.yml", "macos-preview.yml"]) {
    const steps = Object.values(load(name).jobs).flatMap((job) => job.steps);
    const suite = steps.find((step) => step.name?.startsWith("Full regression suite"));
    expect(suite?.["timeout-minutes"], name).toBeLessThanOrEqual(18);
    expect(suite?.run).toContain("tools/stall-guard.sh");
    // The dump sits next to the log, in the folder the always-run upload keeps.
    expect(steps.some((step) => step.uses?.startsWith("actions/upload-artifact@") && (step as { if?: string }).if === "always()")).toBe(true);
  }
});

posixOnly("the release's personal-path check lets GitHub's own macOS build account through and nothing else", async () => {
  const workflow = readFileSync(path.join(DIR, "publish-release.yml"), "utf8");
  const line = workflow.split("\n").map((entry) => entry.trim()).find((entry) => entry.startsWith("! grep -a") && entry.includes("/Users/"));
  expect(line).toBeDefined();
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-paths-"));
  try {
    const run = async (name: string, text: string) => {
      await writeFile(path.join(dir, name), text);
      return Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", line!.replace(/casper-\*/, name)], { cwd: dir }).exitCode;
    };
    expect(await run("casper-darwin-test", "xx /Users/runner/work/x yy")).toBe(0);
    expect(await run("casper-linux-test", "a clean binary")).toBe(0);
    expect(await run("casper-user-test", "a /Users/alice/project b")).not.toBe(0);
    expect(await run("casper-ci-test", "a /home/runner/work/casper b")).not.toBe(0);
    expect(await run("casper-bare-test", "a /Users/ b")).not.toBe(0);
  } finally { await removeTempDir(dir); }
});
