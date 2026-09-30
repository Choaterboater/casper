import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

/**
 * Casper's own CI: every action is pinned to a commit, and the job that may write a release runs
 * no project code. A moved tag or a poisoned install step can then never publish on its own.
 */

const DIR = path.resolve(import.meta.dir, "../.github/workflows");
const files = readdirSync(DIR).filter((name) => /\.ya?ml$/.test(name));

interface Step { uses?: string; run?: string; name?: string; with?: Record<string, unknown> }
interface Job { permissions?: Record<string, string>; steps: Step[]; needs?: string | string[] }
interface Workflow { permissions?: Record<string, string>; jobs: Record<string, Job> }
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
