import { expect, test } from "bun:test";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { VerificationReport } from "../src/verify/evidence";
import type { TaskResult } from "../src/task/result";
import { posixOnly } from "./support/platform";
import { checkCommand } from "./support/check-command";
import { cleanUpAfterEach, runsCheck, answer, calls, fixture } from "./support/phase8-pi";

cleanUpAfterEach();

posixOnly("pinned Pi uses managed checks in its native edit loop, reuses scoped passes, and hands real failure to one repair owner", async () => {
  const native = "printf native > native-proof; kill -TERM $$";
  const command = checkCommand("append:test-runs", "require-line:src/value=good");
  let step = 0;
  const f = await fixture(() => {
    switch (step++) {
      case 0: return calls([
        { name: "write", args: { path: "src/value", content: "good\n" } },
        { name: "bash", args: { command: native } },
      ]);
      case 1: case 2: case 4: case 7: return calls([{ name: "casper_check", args: { check: "test" } }]);
      case 3: return calls([{ name: "edit", args: { path: "src/value", edits: [{ oldText: "good", newText: "bad" }] } }]);
      case 5: return answer("INITIAL_DONE");
      case 6: return calls([{ name: "write", args: { path: "src/value", content: "good\n" } }]);
      default: return answer("REPAIR_DONE");
    }
  });
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), JSON.stringify({
    verify: { test: command, build: native },
    verification: { scopes: { test: { inputs: ["src"] } } }, repair: { maxAttempts: 1 },
  }));
  const harness = path.join(f.agent, "managed-checks.ts");
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
  expect(report).toMatchObject({ status: "pass", repairAttempts: 1 });
  expect(report.results).toHaveLength(1);
  expect(report.results[0]).toMatchObject({ name: "test", freshness: "fresh", exitCode: 0 });
  expect(report.rounds.flat().filter((check) => !check.reused).map((check) => check.status)).toEqual(["pass", "fail", "pass"]);
  expect(await readFile(path.join(f.project, "test-runs"), "utf8")).toBe("xxx");
  expect(await readFile(path.join(f.project, "src/value"), "utf8")).toBe("good\n");
  expect(await readFile(path.join(f.project, "native-proof"), "utf8")).toBe("native");
  // Native signal termination resolves as a tool error in this pinned Pi (exit 143). Its tool
  // status remains diagnostic, never fabricated exit 0 or a managed build pass.
  expect(task.observedChecks).toEqual([{ name: "build", command: native, toolStatus: "error", output: expect.stringContaining("143"), truncated: false }]);
  expect(task.observedChecks?.[0]).not.toHaveProperty("exitCode");
  expect(f.payloads).toHaveLength(9);
  for (const payload of f.payloads) expect(payload.tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["bash", "edit", "write", "casper_check"]));
  expect(String(f.payloads[3]?.messages.at(-1)?.content)).toContain('"reused":true');
  expect(String(f.payloads[5]?.messages.at(-1)?.content)).toContain('"exitCode":1');
  const repair = f.payloads[6]?.messages.at(-1)?.content;
  if (!Array.isArray(repair) || typeof repair[0]?.text !== "string") throw new Error("Missing repair prompt");
  expect(repair[0].text).toContain("Original request:\nContinue");
  expect(repair[0].text).toContain('"exitCode": 1');
}, 15_000);

for (const form of ["relative", "at-prefix", "absolute", "file-url", "double-at", "tilde", "unicode-space", "alias"]) posixOnly(`pinned Pi retains native edit invalidation after restored directory membership (${form})`, async () => {
  let step = 0;
  const input = form === "double-at" ? "@src" : form === "unicode-space" ? "src dir" : "src";
  let nativePath = form === "double-at" ? "@@src/transient" : "src/transient";
  const f = await fixture(() => {
    switch (step++) {
      case 0: case 3: case 4: return calls([{ name: "casper_check", args: { check: "test" } }]);
      case 1: return calls([{ name: "write", args: { path: nativePath, content: "intermediate source\n" } }]);
      case 2: return calls([{ name: "bash", args: { command: `test -f '${input}/transient' && rm '${input}/transient'` } }]);
      default: return answer("DONE");
    }
  });
  await mkdir(path.join(f.project, input));
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), JSON.stringify({
    verify: { test: runsCheck }, verification: { scopes: { test: { inputs: [input] } } },
  }));
  if (form === "at-prefix") nativePath = "@./src/transient";
  if (form === "absolute") nativePath = path.join(await realpath(f.project), "src/transient");
  if (form === "file-url") nativePath = pathToFileURL(path.join(await realpath(f.project), "src/transient")).href;
  if (form === "tilde") nativePath = "~/../project/src/transient";
  if (form === "unicode-space") nativePath = "src\u00a0dir/transient";
  if (form === "alias") {
    const alias = path.join(f.agent, "project-alias");
    await symlink(await realpath(f.project), alias, "dir");
    nativePath = path.join(alias, "src/transient");
  }
  const harness = path.join(f.agent, "native-invalidation.ts");
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
  expect(task.observedEdits).toHaveLength(1);
  expect(await readFile(path.join(f.project, "test-runs"), "utf8")).toBe("xx");
  expect(f.payloads).toHaveLength(6);
}, 15_000);
