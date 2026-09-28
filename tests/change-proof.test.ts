import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diffSnapshots, snapshotTree } from "../src/task/changes";
import { ChangeBaseline, isCodePath, isTestPath, withoutEnded } from "../src/verify/proof";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-proof-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await write(root, files);
  return root;
}
async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
}

/** Capture, let `change` act as the model, then prove the change with `command`. */
async function prove(files: Record<string, string>, change: (root: string) => Promise<void>, command: string) {
  const root = await project(files);
  const before = await snapshotTree(root);
  const baseline = await ChangeBaseline.capture(root);
  cleanup.push(() => baseline.dispose());
  await change(root);
  const changes = diffSnapshots(before, await snapshotTree(root));
  return baseline.prove({ root, changes, check: "test", command, timeoutMs: 20_000 });
}

test("test paths are recognized across common layouts; source is not", () => {
  for (const test of ["tests/sum.test.ts", "test/helpers.js", "src/__tests__/a.js", "spec/a_spec.rb", "src/sum.test.ts",
    "src/sum.spec.js", "pkg/sum_test.go", "tests/test_sum.py", "test_sum.py", "packages/a/tests/fixtures/data.json"]) {
    expect({ test, isTest: isTestPath(test) }).toEqual({ test, isTest: true });
  }
  for (const source of ["src/sum.ts", "src/testing.ts", "src/contest/entry.ts", "latest.js", "README.md", "package.json"]) {
    expect({ source, isTest: isTestPath(source) }).toEqual({ source, isTest: false });
  }
});

test("a change is proven when the tests fail without it and pass with it", async () => {
  const proof = await prove({ "src/sum.js": "broken\n", "tests/check.sh": "test -f src/sum.js\n" }, async (root) => {
    await write(root, { "src/sum.js": "fixed\n", "tests/check.sh": "grep -q fixed src/sum.js\n" });
  }, "sh tests/check.sh");
  // The run without the change is evidence too: how it ended, and the end of its output.
  expect(proof).toEqual({ status: "proven", check: "test", command: "sh tests/check.sh", testsChanged: true,
    without: { exitCode: 1, ended: "fail" } });
});

test("a failure without the change that is a crash, not a test failure, is kept as weaker evidence with a bounded output tail", async () => {
  // The shell reports a child killed by SIGSEGV as exit 139.
  const proof = await prove({ "src/sum.js": "broken\n", "tests/check.sh": "test -f src/sum.js\n" }, async (root) => {
    await write(root, { "src/sum.js": "fixed\n", "tests/check.sh": "grep -q fixed src/sum.js && exit 0\nhead -c 3000 /dev/zero | tr '\\0' x; echo; echo crashing >&2; sh -c 'kill -SEGV $$'\n" });
  }, "sh tests/check.sh");
  expect(proof?.status).toBe("proven");
  const without = proof && "without" in proof ? proof.without : undefined;
  expect({ exitCode: without?.exitCode, ended: without?.ended }).toEqual({ exitCode: 139, ended: "crash" });
  expect(without?.output?.length).toBeLessThanOrEqual(500);
  expect(without?.output).toContain("\ncrashing\n");
});

test("how the run without the change ended: a test failure, a timeout, a crash or a command that could not start", () => {
  expect(withoutEnded(1)).toBe("fail");
  expect(withoutEnded(0)).toBe("pass");
  expect(withoutEnded(143, "Timed out after 1000ms")).toBe("timeout");
  expect(withoutEnded(139)).toBe("crash");
  expect(withoutEnded(3221225477)).toBe("crash");
  expect(withoutEnded(127)).toBe("no_start");
});

test("a change the tests also pass without is not proven, and the receipt can say no test changed", async () => {
  const proof = await prove({ "src/sum.js": "broken\n", "tests/check.sh": "test -f src/sum.js\n" }, async (root) => {
    await write(root, { "src/sum.js": "fixed\n" });
  }, "sh tests/check.sh");
  expect(proof).toEqual({ status: "unproven", check: "test", command: "sh tests/check.sh", testsChanged: false, without: { exitCode: 0, ended: "pass" } });
});

test("an existing test that the change makes pass proves it too", async () => {
  const proof = await prove({ "src/sum.js": "broken\n", "tests/check.sh": "grep -q fixed src/sum.js\n" }, async (root) => {
    await write(root, { "src/sum.js": "fixed\n" });
  }, "sh tests/check.sh");
  expect(proof?.status).toBe("proven");
});

test("a copy that cannot run the tests is unavailable, never mistaken for proof", async () => {
  // The check needs .git/, which copies never contain: it fails in both copies, so no comparison is possible.
  const proof = await prove({ "src/sum.js": "broken\n", ".git/marker": "x" }, async (root) => { await write(root, { "src/sum.js": "fixed\n" }); },
    "test -f .git/marker && grep -q fixed src/sum.js");
  expect(proof).toEqual({ status: "unavailable", check: "test", reason: "test does not pass in a copy of the workspace, so Casper cannot compare with and without the change" });
});

test("docs and other non-code edits need no proof: only a code change must be proven", async () => {
  expect(await prove({ "src/sum.js": "x\n", "tests/check.sh": "true\n" }, async (root) => {
    await write(root, { "README.md": "notes\n", "docs/usage.md": "how\n" });
  }, "sh tests/check.sh")).toBeUndefined();
  for (const code of ["src/sum.ts", "lib/a.py", "cmd/main.go", "app/page.tsx", "src/lib.rs", "bin/cli.mjs"]) expect({ code, isCode: isCodePath(code) }).toEqual({ code, isCode: true });
  for (const other of ["README.md", "docs/a.txt", "package.json", "tests/a.test.ts", "assets/logo.png"]) expect({ other, isCode: isCodePath(other) }).toEqual({ other, isCode: false });
});

test("only test changes need no proof; dependencies are linked, not copied", async () => {
  expect(await prove({ "src/sum.js": "x\n", "tests/check.sh": "true\n" }, async (root) => {
    await write(root, { "tests/check.sh": "true # reworded\n" });
  }, "sh tests/check.sh")).toBeUndefined();
  const proof = await prove({ "src/sum.js": "broken\n", "node_modules/dep/index.js": "dep\n", "tests/check.sh": "true\n" }, async (root) => {
    await write(root, { "src/sum.js": "fixed\n", "tests/check.sh": "test -f node_modules/dep/index.js && grep -q fixed src/sum.js\n" });
  }, "sh tests/check.sh");
  expect(proof?.status).toBe("proven");
});

test("the baseline and every comparison copy are removed", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "casper-proof-scratch-"));
  cleanup.push(() => rm(scratch, { recursive: true, force: true }));
  const root = await project({ "src/sum.js": "broken\n", "tests/check.sh": "grep -q fixed src/sum.js\n" });
  const before = await snapshotTree(root);
  const baseline = await ChangeBaseline.capture(root, { scratch });
  await write(root, { "src/sum.js": "fixed\n" });
  await baseline.prove({ root, changes: diffSnapshots(before, await snapshotTree(root)), check: "test", command: "sh tests/check.sh", timeoutMs: 20_000 });
  expect((await readdir(scratch)).length).toBe(1);
  await baseline.dispose();
  expect(await readdir(scratch)).toEqual([]);
});

test("a workspace over the copy limits cannot be captured", async () => {
  const root = await project({ "a.txt": "a", "b.txt": "b", "c.txt": "c" });
  await expect(ChangeBaseline.capture(root, { fileLimit: 2 })).rejects.toThrow("more than 2 files");
});

test("a change that swaps a test folder for a link outside the project never lets the proof step delete or write there", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "casper-proof-outside-"));
  cleanup.push(() => rm(outside, { recursive: true, force: true }));
  await write(outside, { "keep.test.js": "precious\n", "a.test.js": "precious too\n" });
  const proof = await prove({ "src/code.js": "old\n", "tests/a/keep.test.js": "x\n", "tests/a/a.test.js": "x\n", "tests/check.sh": "grep -q new src/code.js\n" }, async (root) => {
    await rm(path.join(root, "tests/a"), { recursive: true, force: true });
    await symlink(outside, path.join(root, "tests/a"), "dir");
    await write(root, { "src/code.js": "new\n" });
  }, "sh tests/check.sh");
  expect(proof).toBeDefined();
  expect((await readdir(outside)).sort()).toEqual(["a.test.js", "keep.test.js"]);
});

test("a test file added under a folder the model turned into a link is not written through it", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "casper-proof-outside-"));
  cleanup.push(() => rm(outside, { recursive: true, force: true }));
  const proof = await prove({ "src/code.js": "old\n", "tests/check.sh": "grep -q new src/code.js\n", "tests/unit/.keep": "" }, async (root) => {
    await rm(path.join(root, "tests/unit"), { recursive: true, force: true });
    await symlink(outside, path.join(root, "tests/unit"), "dir");
    await write(outside, { "new.test.js": "planted\n" });
    await write(root, { "src/code.js": "new\n" });
  }, "sh tests/check.sh");
  expect(proof).toBeDefined();
  expect((await readdir(outside)).sort()).toEqual(["new.test.js"]);
});
