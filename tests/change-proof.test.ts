import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diffSnapshots, snapshotTree } from "../src/task/changes";
import { ChangeBaseline, isCodePath, isTestPath, withoutEnded } from "../src/verify/proof";
import { checkCommand } from "./support/check-command";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-proof-"));
  cleanup.push(() => removeTempDir(root));
  await write(root, files);
  return root;
}
async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
}

// The project's test is a script the runtime runs, not `sh tests/check.sh`: on Windows a check runs through cmd.exe.
const CHECK = `${JSON.stringify(process.execPath)} tests/check.js`;
const pass = "process.exit(0);\n";
const has = (file: string) => `require("fs").existsSync(${JSON.stringify(file)})`;
const says = (file: string, word: string) => `require("fs").readFileSync(${JSON.stringify(file)}, "utf8").includes(${JSON.stringify(word)})`;
/** A test that passes when every condition holds. */
const check = (...conditions: string[]) => `process.exit(${conditions.join(" && ")} ? 0 : 1);\n`;

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
  const proof = await prove({ "src/sum.js": "broken\n", "tests/check.js": check(has("src/sum.js")) }, async (root) => {
    await write(root, { "src/sum.js": "fixed\n", "tests/check.js": check(says("src/sum.js", "fixed")) });
  }, CHECK);
  // The run without the change is evidence too: how it ended, and the end of its output.
  expect(proof).toEqual({ status: "proven", check: "test", command: CHECK, testsChanged: true,
    without: { exitCode: 1, ended: "fail" } });
});

// A real SIGSEGV as a POSIX shell reports it (exit 139), so this one needs sh; Git for Windows has it.
test.skipIf(!Bun.which("sh"))("a failure without the change that is a crash, not a test failure, is kept as weaker evidence with a bounded output tail", async () => {
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
  const proof = await prove({ "src/sum.js": "broken\n", "tests/check.js": check(has("src/sum.js")) }, async (root) => {
    await write(root, { "src/sum.js": "fixed\n" });
  }, CHECK);
  expect(proof).toEqual({ status: "unproven", check: "test", command: CHECK, testsChanged: false, without: { exitCode: 0, ended: "pass" } });
});

test("an existing test that the change makes pass proves it too", async () => {
  const proof = await prove({ "src/sum.js": "broken\n", "tests/check.js": check(says("src/sum.js", "fixed")) }, async (root) => {
    await write(root, { "src/sum.js": "fixed\n" });
  }, CHECK);
  expect(proof?.status).toBe("proven");
});

test("a copy that cannot run the tests is unavailable, never mistaken for proof", async () => {
  // The check needs .git/, which copies never contain: it fails in both copies, so no comparison is possible.
  const proof = await prove({ "src/sum.js": "broken\n", ".git/marker": "x" }, async (root) => { await write(root, { "src/sum.js": "fixed\n" }); },
    checkCommand("require:.git/marker", "require-line:src/sum.js=fixed"));
  expect(proof).toEqual({ status: "unavailable", check: "test", reason: "test does not pass in a copy of the workspace, so Casper cannot compare with and without the change" });
});

test("docs and other non-code edits need no proof: only a code change must be proven", async () => {
  expect(await prove({ "src/sum.js": "x\n", "tests/check.js": pass }, async (root) => {
    await write(root, { "README.md": "notes\n", "docs/usage.md": "how\n" });
  }, CHECK)).toBeUndefined();
  for (const code of ["src/sum.ts", "lib/a.py", "cmd/main.go", "app/page.tsx", "src/lib.rs", "bin/cli.mjs"]) expect({ code, isCode: isCodePath(code) }).toEqual({ code, isCode: true });
  for (const other of ["README.md", "docs/a.txt", "package.json", "tests/a.test.ts", "assets/logo.png"]) expect({ other, isCode: isCodePath(other) }).toEqual({ other, isCode: false });
});

test("only test changes need no proof; dependencies are linked, not copied", async () => {
  expect(await prove({ "src/sum.js": "x\n", "tests/check.js": pass }, async (root) => {
    await write(root, { "tests/check.js": `// reworded\n${pass}` });
  }, CHECK)).toBeUndefined();
  const proof = await prove({ "src/sum.js": "broken\n", "node_modules/dep/index.js": "dep\n", "tests/check.js": pass }, async (root) => {
    await write(root, { "src/sum.js": "fixed\n", "tests/check.js": check(has("node_modules/dep/index.js"), says("src/sum.js", "fixed")) });
  }, CHECK);
  expect(proof?.status).toBe("proven");
});

test("the baseline and every comparison copy are removed", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "casper-proof-scratch-"));
  cleanup.push(() => removeTempDir(scratch));
  const root = await project({ "src/sum.js": "broken\n", "tests/check.js": check(says("src/sum.js", "fixed")) });
  const before = await snapshotTree(root);
  const baseline = await ChangeBaseline.capture(root, { scratch });
  await write(root, { "src/sum.js": "fixed\n" });
  await baseline.prove({ root, changes: diffSnapshots(before, await snapshotTree(root)), check: "test", command: CHECK, timeoutMs: 20_000 });
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
  cleanup.push(() => removeTempDir(outside));
  await write(outside, { "keep.test.js": "precious\n", "a.test.js": "precious too\n" });
  const proof = await prove({ "src/code.js": "old\n", "tests/a/keep.test.js": "x\n", "tests/a/a.test.js": "x\n", "tests/check.js": check(says("src/code.js", "new")) }, async (root) => {
    await removeTempDir(path.join(root, "tests/a"));
    await symlink(outside, path.join(root, "tests/a"), "dir");
    await write(root, { "src/code.js": "new\n" });
  }, CHECK);
  expect(proof).toBeDefined();
  expect((await readdir(outside)).sort()).toEqual(["a.test.js", "keep.test.js"]);
});

test("a test file added under a folder the model turned into a link is not written through it", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "casper-proof-outside-"));
  cleanup.push(() => removeTempDir(outside));
  const proof = await prove({ "src/code.js": "old\n", "tests/check.js": check(says("src/code.js", "new")), "tests/unit/.keep": "" }, async (root) => {
    await removeTempDir(path.join(root, "tests/unit"));
    await symlink(outside, path.join(root, "tests/unit"), "dir");
    await write(outside, { "new.test.js": "planted\n" });
    await write(root, { "src/code.js": "new\n" });
  }, CHECK);
  expect(proof).toBeDefined();
  expect((await readdir(outside)).sort()).toEqual(["new.test.js"]);
});

test("before(): a run that crashed or was killed in the copy can't tell; only a real failure is 'already failing'", async () => {
  const root = await project({ "tests/check.js": pass });
  const baseline = await ChangeBaseline.capture(root);
  cleanup.push(() => baseline.dispose());
  const run = (command: string) => baseline.before({ root, check: "test", command, timeoutMs: 20_000 });
  expect(await run(`${JSON.stringify(process.execPath)} -e "process.exit(1)"`)).toBe("fail");
  expect(await run(`${JSON.stringify(process.execPath)} -e "process.exit(0)"`)).toBe("pass");
  // A shell reporting a signal (128 + 9) and a run killed outright are crashes, not test failures.
  expect(await run(`${JSON.stringify(process.execPath)} -e "process.exit(137)"`)).toBeUndefined();
  if (process.platform !== "win32") expect(await run(`${JSON.stringify(process.execPath)} -e "process.kill(process.pid, 'SIGKILL')"`)).toBeUndefined();
});
