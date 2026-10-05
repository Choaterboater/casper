import { expect, test } from "bun:test";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { VerificationReport } from "../src/verify/evidence";
import type { TaskResult } from "../src/task/result";
import { POSIX, needsSymlinks, posixOnly } from "./support/platform";
import { cleanUpAfterEach, runsCheck, answer, calls, fixture, caseInsensitiveFilesystem } from "./support/phase8-pi";

cleanUpAfterEach();

// A write through a link out of the project is refused now (tests/secrets-pi.integration.test.ts), so only
// the in-project destination is left here.
for (const destination of ["excluded"]) posixOnly(`pinned Pi retains included symlink invalidation after removal (${destination})`, async () => {
  let step = 0;
  const linkTarget = "generated";
  const f = await fixture(() => {
    switch (step++) {
      case 0: case 4: case 5: return calls([{ name: "casper_check", args: { check: "test" } }]);
      case 1: return calls([{ name: "bash", args: { command: `ln -s '${linkTarget}' src/link` } }]);
      case 2: return calls([{ name: "write", args: { path: "src/link/transient", content: "temporary output\n" } }]);
      case 3: return calls([{ name: "bash", args: { command: "rm src/link/transient src/link" } }]);
      default: return answer("DONE");
    }
  });
  await mkdir(path.join(f.project, "src/generated"), { recursive: true });
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), JSON.stringify({
    verify: { test: runsCheck },
    verification: { scopes: { test: { inputs: ["src"], exclude: ["src/generated"] } } },
  }));
  const harness = path.join(f.agent, "included-symlink.ts");
  await writeFile(harness, `import { CasperApp } from ${JSON.stringify(path.join(import.meta.dir, "../src/app.ts"))};
const app = new CasperApp({ autoVerify: true });
try {
  const report = await app.runOnce('Continue');
  console.log('CHECK_RESULT=' + JSON.stringify({ report, task: app.getLastTaskResult() }));
} finally { await app.close(); }
`);
  const result = await f.run([harness]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const { report, task }: { report: VerificationReport; task: TaskResult } = JSON.parse(result.stdout.split("CHECK_RESULT=")[1]!);
  expect(report).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(report.rounds.flat().map((check) => Boolean(check.reused))).toEqual([false, false, true]);
  expect(report.results[0]).toMatchObject({ freshness: "fresh", exitCode: 0 });
  expect(task.observedEdits).toEqual(["src/link/transient"]);
  expect(await readFile(path.join(f.project, "test-runs"), "utf8")).toBe("xx");
  expect(f.payloads).toHaveLength(7);
}, 15_000);


test.skipIf(!caseInsensitiveFilesystem || !POSIX)("pinned Pi matches a case-aliased scope root without broadening its exclusions", async () => {
  let step = 0;
  const f = await fixture(() => {
    switch (step++) {
      case 0: case 3: case 6: case 7: return calls([{ name: "casper_check", args: { check: "test" } }]);
      case 1: return calls([{ name: "write", args: { path: "SRC/generated/report", content: "excluded\n" } }]);
      case 2: return calls([{ name: "bash", args: { command: "rm SRC/generated/report" } }]);
      case 4: return calls([{ name: "write", args: { path: "SRC/transient", content: "included\n" } }]);
      case 5: return calls([{ name: "bash", args: { command: "rm SRC/transient" } }]);
      default: return answer("DONE");
    }
  });
  await mkdir(path.join(f.project, "src/generated"), { recursive: true });
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), JSON.stringify({
    verify: { test: runsCheck },
    verification: { scopes: { test: { inputs: ["SRC"], exclude: ["SRC/generated"] } } },
  }));
  const harness = path.join(f.agent, "case-scope.ts");
  await writeFile(harness, `import { CasperApp } from ${JSON.stringify(path.join(import.meta.dir, "../src/app.ts"))};
const app = new CasperApp({ autoVerify: true });
try {
  const report = await app.runOnce('Continue');
  console.log('CHECK_RESULT=' + JSON.stringify({ report, task: app.getLastTaskResult() }));
} finally { await app.close(); }
`);
  const result = await f.run([harness]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const { report, task }: { report: VerificationReport; task: TaskResult } = JSON.parse(result.stdout.split("CHECK_RESULT=")[1]!);
  expect(report).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(task.observedEdits).toEqual(["SRC/generated/report", "SRC/transient"]);
  expect(report.rounds.flat().map((check) => Boolean(check.reused))).toEqual([false, true, false, true]);
  expect(await readFile(path.join(f.project, "test-runs"), "utf8")).toBe("xx");
}, 15_000);

test.skipIf(!caseInsensitiveFilesystem)("pinned Pi invalidates a failed edit of a missing case-aliased named input", async () => {
  let step = 0;
  const f = await fixture(() => {
    switch (step++) {
      case 0: case 2: case 3: return calls([{ name: "casper_check", args: { check: "test" } }]);
      case 1: return calls([{ name: "edit", args: { path: "src/missing", edits: [{ oldText: "old", newText: "new" }] } }]);
      default: return answer("DONE");
    }
  });
  await mkdir(path.join(f.project, "src"));
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), JSON.stringify({
    verify: { test: runsCheck }, verification: { scopes: { test: { inputs: ["SRC/MISSING"] } } },
  }));
  const harness = path.join(f.agent, "missing-native-alias.ts");
  await writeFile(harness, `import { CasperApp } from ${JSON.stringify(path.join(import.meta.dir, "../src/app.ts"))};
const app = new CasperApp({ autoVerify: true });
try {
  const report = await app.runOnce('Continue');
  console.log('CHECK_RESULT=' + JSON.stringify({ report, task: app.getLastTaskResult() }));
} finally { await app.close(); }
`);
  const result = await f.run([harness]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const { report, task }: { report: VerificationReport; task: TaskResult } = JSON.parse(result.stdout.split("CHECK_RESULT=")[1]!);
  expect(report).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(report.rounds.flat().map((check) => Boolean(check.reused))).toEqual([false, false, true]);
  expect(task).toMatchObject({ observedEdits: [], possibleMutations: false, changedPaths: expect.arrayContaining(["test-runs"]) });
  expect(await readFile(path.join(f.project, "test-runs"), "utf8")).toBe("xx");
}, 15_000);

test.skipIf(!caseInsensitiveFilesystem || !POSIX)("pinned Pi preserves exclusions for case-aliased symlinks while retaining included traversal", async () => {
  let step = 0;
  const f = await fixture(() => {
    switch (step++) {
      case 0: case 3: case 7: case 8: return calls([{ name: "casper_check", args: { check: "test" } }]);
      case 1: return calls([{ name: "write", args: { path: "SRC/GENERATED/transient", content: "excluded output\n" } }]);
      case 2: return calls([{ name: "bash", args: { command: "rm src/generated/transient" } }]);
      case 4: return calls([{ name: "bash", args: { command: "ln -s generated src/link" } }]);
      case 5: return calls([{ name: "write", args: { path: "SRC/LINK/transient", content: "temporary output\n" } }]);
      case 6: return calls([{ name: "bash", args: { command: "rm src/link/transient src/link" } }]);
      default: return answer("DONE");
    }
  });
  await mkdir(path.join(f.project, "src"));
  await mkdir(path.join(f.project, "outside"));
  await symlink("../outside", path.join(f.project, "src/generated"), "dir");
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), JSON.stringify({
    verify: { test: runsCheck },
    verification: { scopes: { test: { inputs: ["SRC"], exclude: ["SRC/generated"] } } },
  }));
  const harness = path.join(f.agent, "case-symlink.ts");
  await writeFile(harness, `import { CasperApp } from ${JSON.stringify(path.join(import.meta.dir, "../src/app.ts"))};
const app = new CasperApp({ autoVerify: true });
try {
  const report = await app.runOnce('Continue');
  console.log('CHECK_RESULT=' + JSON.stringify({ report, task: app.getLastTaskResult() }));
} finally { await app.close(); }
`);
  const result = await f.run([harness]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).not.toContain("✗");
  const { report, task }: { report: VerificationReport; task: TaskResult } = JSON.parse(result.stdout.split("CHECK_RESULT=")[1]!);
  expect(report).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(report.rounds.flat().map((check) => Boolean(check.reused))).toEqual([false, true, false, true]);
  expect(task.observedEdits).toEqual(["SRC/GENERATED/transient", "SRC/LINK/transient"]);
  expect(await readFile(path.join(f.project, "test-runs"), "utf8")).toBe("xx");
}, 15_000);

for (const toolName of ["edit", "write"]) for (const form of ["alias", "file-url", "double-at"]) needsSymlinks(`pinned Pi conservatively invalidates a failed native ${toolName} (${form})`, async () => {
  let step = 0;
  const input = form === "double-at" ? "@src" : "src";
  // Edit a missing target; write to a directory. Neither error is a completed edit.
  const target = toolName === "edit" ? `${input}/missing/target` : input;
  let nativePath = "";
  const f = await fixture(() => {
    switch (step++) {
      case 0: case 2: return calls([{ name: "casper_check", args: { check: "test" } }]);
      case 1: return calls([{ name: toolName, args: toolName === "edit"
        ? { path: nativePath, edits: [{ oldText: "old", newText: "new" }] } : { path: nativePath, content: "cannot write a directory" } }]);
      default: return answer("DONE");
    }
  });
  await mkdir(path.join(f.project, input));
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), JSON.stringify({
    verify: { test: runsCheck }, verification: { scopes: { test: { inputs: [input] } } },
  }));
  if (form === "alias") {
    const alias = path.join(f.agent, "project-alias");
    await symlink(await realpath(f.project), alias, "dir");
    nativePath = path.join(alias, target);
  } else nativePath = form === "file-url"
    ? pathToFileURL(path.join(await realpath(f.project), target)).href : `@${target}`;
  const harness = path.join(f.agent, "failed-edit.ts");
  await writeFile(harness, `import { CasperApp } from ${JSON.stringify(path.join(import.meta.dir, "../src/app.ts"))};
const app = new CasperApp({ autoVerify: true });
try {
  const report = await app.runOnce('Continue');
  console.log('CHECK_RESULT=' + JSON.stringify({ report, task: app.getLastTaskResult() }));
} finally { await app.close(); }
`);
  const result = await f.run([harness]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const { report, task }: { report: VerificationReport; task: TaskResult } = JSON.parse(result.stdout.split("CHECK_RESULT=")[1]!);
  expect(report).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(report.rounds.flat().map((check) => Boolean(check.reused))).toEqual([false, false]);
  expect(task).toMatchObject({ observedEdits: [], possibleMutations: false, changedPaths: expect.arrayContaining(["test-runs"]) });
  expect(await readFile(path.join(f.project, "test-runs"), "utf8")).toBe("xx");
}, 15_000);

test("pinned Pi invalidates a failed native write whose expanded path is cwd", async () => {
  let step = 0;
  const f = await fixture(() => {
    switch (step++) {
      case 0: case 2: case 3: return calls([{ name: "casper_check", args: { check: "test" } }]);
      case 1: return calls([{ name: "write", args: { path: "@", content: "cannot overwrite cwd" } }]);
      default: return answer("DONE");
    }
  });
  await mkdir(path.join(f.project, "src"));
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), JSON.stringify({
    verify: { test: runsCheck }, verification: { scopes: { test: { inputs: ["src"] } } },
  }));
  const harness = path.join(f.agent, "empty-native-path.ts");
  await writeFile(harness, `import { CasperApp } from ${JSON.stringify(path.join(import.meta.dir, "../src/app.ts"))};
const app = new CasperApp({ autoVerify: true });
try {
  const report = await app.runOnce('Continue');
  console.log('CHECK_RESULT=' + JSON.stringify({ report, task: app.getLastTaskResult() }));
} finally { await app.close(); }
`);
  const result = await f.run([harness]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const { report, task }: { report: VerificationReport; task: TaskResult } = JSON.parse(result.stdout.split("CHECK_RESULT=")[1]!);
  expect(report).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(report.rounds.flat().map((check) => Boolean(check.reused))).toEqual([false, false, true]);
  expect(task).toMatchObject({ observedEdits: [], possibleMutations: false, changedPaths: expect.arrayContaining(["test-runs"]) });
  expect(await readFile(path.join(f.project, "test-runs"), "utf8")).toBe("xx");
}, 15_000);
