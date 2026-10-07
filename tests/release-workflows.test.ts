import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { verifySshSignature } from "../src/update/signature";
import { sshKeygenVerifies } from "./support/release-signing";
import { removeTempDir } from "./support/temp-dir";

/**
 * Casper's own CI: every action is pinned to a commit, and the job that may write a release runs
 * no project code. A moved tag or a poisoned install step can then never publish on its own.
 */

const DIR = path.resolve(import.meta.dir, "../.github/workflows");
const files = readdirSync(DIR).filter((name) => /\.ya?ml$/.test(name));

interface Step { uses?: string; run?: string; name?: string; with?: Record<string, unknown>; "timeout-minutes"?: number }
interface Job { "timeout-minutes"?: number; permissions?: Record<string, string>; steps: Step[]; needs?: string | string[] }
interface Workflow { permissions?: Record<string, string>; jobs: Record<string, Job> }
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

test("Linux and macOS CI run the live sandbox tests; dependabot keeps the action pins current", () => {
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
  const dependabot = parse(readFileSync(path.resolve(import.meta.dir, "../.github/dependabot.yml"), "utf8")) as { updates: Array<{ "package-ecosystem": string }> };
  expect(dependabot.updates.map((update) => update["package-ecosystem"])).toContain("github-actions");
});

test("the full suite runs files in parallel, slowest first, with the eval tests in their own script; CI uses it", () => {
  const scripts = (JSON.parse(readFileSync(path.resolve(import.meta.dir, "../package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  expect(scripts.test).toContain("bun test --parallel --timings=tests/timings.json");
  expect(scripts.test).toContain("--path-ignore-patterns='tests/eval-*'");
  // The real debugger shares the machine's debugger and Python; it runs alone after the rest.
  expect(scripts.test).toContain("bun test tests/phase10-debugger-real.test.ts");
  expect(scripts["test:evals"]).toContain("tests/eval-");
  expect(scripts["test:fast"]).toBeUndefined();
  for (const name of ["linux-preview.yml", "macos-preview.yml"]) {
    const runs = Object.values(load(name).jobs).flatMap((job) => (job.steps ?? []).map((step) => step.run ?? ""));
    // Run straight, or through tools/stall-guard.sh (which stops a run that goes silent and dumps what it was doing).
    expect(runs.some((run) => run.startsWith("bun run test 2>&1") || /^bash tools\/stall-guard\.sh .* -- bun run test\s*$/.test(run))).toBe(true);
    expect(runs.some((run) => /^bun test 2>&1/.test(run))).toBe(false);
  }
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

test("a stuck preview run is cut off in minutes, not at the old 30 to 45 minute job limit, and the evidence is still kept", () => {
  for (const name of ["linux-preview.yml", "macos-preview.yml", "windows-preview.yml", "windows-arm64.yml"]) {
    for (const [jobName, job] of Object.entries(load(name).jobs)) {
      expect(job["timeout-minutes"], `${name} ${jobName}`).toBeLessThanOrEqual(20);
    }
  }
  for (const name of ["linux-preview.yml", "macos-preview.yml"]) {
    const steps = Object.values(load(name).jobs).flatMap((job) => job.steps);
    const suite = steps.find((step) => step.name?.startsWith("Full regression suite"));
    expect(suite?.["timeout-minutes"], name).toBeLessThanOrEqual(15);
    expect(suite?.run).toContain("tools/stall-guard.sh");
    // The dump sits next to the log, in the folder the always-run upload keeps.
    expect(steps.some((step) => step.uses?.startsWith("actions/upload-artifact@") && (step as { if?: string }).if === "always()")).toBe(true);
  }
});
