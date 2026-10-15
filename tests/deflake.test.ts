import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { countRuns, repetitions, report, testFile } from "../tools/deflake";
import { removeTempDir } from "./support/temp-dir";
import { needsSymlinks } from "./support/platform";
import { symlink } from "node:fs/promises";

test("deflake counts every independent run sequentially, retains failures and reports both counts", async () => {
  let active = 0;
  const seen: number[] = [];
  const result = await countRuns(4, async attempt => {
    expect(++active).toBe(1);
    seen.push(attempt);
    await Promise.resolve();
    active--;
    return attempt === 2 || attempt === 4 ? 1 : 0;
  });
  expect(seen).toEqual([1, 2, 3, 4]);
  expect(result).toEqual({ passed: 2, failed: 2 });
  const text = report("tests/example.test.ts", 4, result);
  for (const expected of ["tests/example.test.ts", `OS: ${process.platform}`, "Runs: 4", "Pass: 2", "Fail: 2", "skipped test is not flake evidence"]) expect(text).toContain(expected);
  expect(await countRuns(2, async () => 0)).toEqual({ passed: 2, failed: 0 });
});

test("deflake validates bounded integral run counts, never runs a whole-suite repeat", () => {
  for (const good of ["1", "10", "100"]) expect(repetitions(good)).toBe(Number(good));
  for (const bad of ["0", "-1", "101", "1.5", "NaN", "Infinity", "1;echo", "", " 2", "01"]) expect(() => repetitions(bad)).toThrow("1 to 100");
});

test("deflake accepts exactly one existing test file, refusing paths, patterns and arguments outside tests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-deflake-"));
  try {
    await mkdir(path.join(root, "tests"));
    await writeFile(path.join(root, "tests", "one.test.ts"), "");
    await writeFile(path.join(root, "outside.test.ts"), "");
    await mkdir(path.join(root, "tests", "folder.test.ts"));
    expect(await testFile(root, "tests/one.test.ts")).toBe(path.join(await realpath(root), "tests/one.test.ts"));
    for (const bad of ["tests/../outside.test.ts", "tests", "tests/*.test.ts", "--preload=evil", "tests/one.test.ts; echo", "tests\\one.test.ts", "tests/missing.test.ts", "tests/folder.test.ts"]) {
      await expect(testFile(root, bad)).rejects.toThrow();
    }
  } finally { await removeTempDir(root); }
});

needsSymlinks("deflake refuses a symlinked test escaping tests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-deflake-link-"));
  try {
    await mkdir(path.join(root, "tests"));
    await writeFile(path.join(root, "outside.test.ts"), "");
    await symlink(path.join(root, "outside.test.ts"), path.join(root, "tests/link.test.ts"));
    await expect(testFile(root, "tests/link.test.ts")).rejects.toThrow("inside tests");
  } finally { await removeTempDir(root); }
});

test("manual deflake workflow chooses an OS, takes one file and N runs through env, and retains evidence even on failure", async () => {
  const workflow = parse(await Bun.file(new URL("../.github/workflows/deflake.yml", import.meta.url)).text());
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  const inputs = workflow.on.workflow_dispatch.inputs;
  expect(inputs.file).toMatchObject({ type: "string", required: true });
  expect(inputs.runs).toMatchObject({ type: "number", default: "10", required: true });
  expect(inputs.os.options).toEqual(["ubuntu-24.04", "macos-15", "windows-2025"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  const job = workflow.jobs.deflake;
  expect(job["runs-on"]).toBe("${{ inputs.os }}");
  const step = job.steps.find((step: { run?: string }) => step.run === "bun tools/deflake.ts");
  expect(step.env.DEFLAKE_FILE).toBe("${{ inputs.file }}");
  expect(step.env.DEFLAKE_RUNS).toBe("${{ inputs.runs }}");
  for (const step of job.steps) if (step.run) expect(step.run).not.toContain("${{ inputs.");
  expect(job.steps[0].with["persist-credentials"]).toBe(false);
  const artifact = job.steps.at(-1);
  expect(artifact.if).toBe("always()");
  expect(artifact.with.path).toBe("${{ runner.temp }}/deflake-results/");
});
