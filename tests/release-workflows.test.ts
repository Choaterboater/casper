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
