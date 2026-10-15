import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CasperApp } from "../src/app";
import { applySessionCheckOverrides, checkChangeOptions } from "../src/app/check-changes";
import { CHECK_CHANGE_CHOICES, CHECK_CHANGE_QUESTION, CheckChangeGuard, guardedFileTools, type CheckChange, type CheckChangeOptions } from "../src/runtime/check-changes";
import type { ProjectModel } from "../src/project/model";
import { VerifierRegistry } from "../src/verify/registry";
import { VerificationTask } from "../src/verify/task";
import { casperBashOperations } from "../src/runtime/pi";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });
const original = "commands:\n  test: bun .casper/quick-test.ts\n";
async function setup(options?: CheckChangeOptions) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-check-change-")); roots.push(root);
  await mkdir(path.join(root, ".casper"));
  await writeFile(path.join(root, ".casper/project.yaml"), original);
  await writeFile(path.join(root, ".casper/quick-test.ts"), "throw new Error('real test');\n");
  const guard = new CheckChangeGuard(root, options);
  const tools = guardedFileTools(root, guard);
  const call = (name: string, input: unknown, signal?: AbortSignal) => tools.find((tool) => tool.name === name)!.execute("fixture", input as never, signal, undefined, undefined as never);
  return { root, guard, call, config: () => readFile(path.join(root, ".casper/project.yaml"), "utf8"), script: () => readFile(path.join(root, ".casper/quick-test.ts"), "utf8") };
}

test("actual native edit asks with final old → new and persists only the approved configured command", async () => {
  const asked: CheckChange[] = [];
  const project = await setup({ commands: () => ({ test: "bun .casper/quick-test.ts" }), ask: async (change) => { asked.push(change); return "save"; } });
  await project.call("edit", { path: ".casper/project.yaml", edits: [{ oldText: "bun .casper/quick-test.ts", newText: "bun test" }] });
  expect(asked).toEqual([{ file: ".casper/project.yaml", before: original, after: "commands:\n  test: bun test\n" }]);
  expect(await project.config()).toBe("commands:\n  test: bun test\n");
});

test("actual native write to the check script asks, refuses by default, then saves an explicitly approved change", async () => {
  let answer: "save" | undefined;
  const asked: CheckChange[] = [];
  const project = await setup({ commands: () => ({ test: "bun .casper/quick-test.ts" }), ask: async (change) => { asked.push(change); return answer; } });
  await expect(project.call("write", { path: ".casper/quick-test.ts", content: "console.log('skipped');\n" })).rejects.toThrow("needs your OK");
  expect(await project.script()).toBe("throw new Error('real test');\n");
  answer = "save";
  await project.call("write", { path: ".casper/quick-test.ts", content: "console.log('skipped');\n" });
  expect(asked).toHaveLength(2);
  expect(asked[1]?.before).toContain("real test");
  expect(asked[1]?.after).toContain("skipped");
  expect(asked[1]?.sessionCommands).toBeUndefined();
  expect(await project.script()).toBe("console.log('skipped');\n");
});

for (const tool of ["edit", "write"]) {
  test(`absolute in-project check scripts require approval for native ${tool}`, async () => {
    let answer: "save" | undefined;
    const asked: CheckChange[] = [];
    const project = await setup({ commands: () => ({}), ask: async (change) => { asked.push(change); return answer; } });
    const file = path.join(project.root, "check.ts");
    const before = "throw new Error('real check');\n", after = "console.log('skip');\n";
    await writeFile(file, before);
    await writeFile(path.join(project.root, ".casper/project.yaml"), `commands:\n  test: bun ${JSON.stringify(file)}\n`);
    const input = tool === "edit" ? { path: "check.ts", edits: [{ oldText: before, newText: after }] } : { path: "check.ts", content: after };
    await expect(project.call(tool, input)).rejects.toThrow("needs your OK");
    expect(await readFile(file, "utf8")).toBe(before);
    answer = "save";
    await project.call(tool, input);
    expect(asked).toEqual([{ file: "check.ts", before, after }, { file: "check.ts", before, after }]);
    expect(await readFile(file, "utf8")).toBe(after);
  });
}

test("no approval channel, No, cancellation and concurrent saves leave checks untouched", async () => {
  const project = await setup();
  await expect(project.call("write", { path: ".casper/project.yaml", content: "commands: { test: 'true' }" })).rejects.toThrow("needs your OK");
  expect(await project.config()).toBe(original);
  const stopped = new AbortController();
  const cancelling = new CheckChangeGuard(project.root, { commands: () => ({}), ask: async () => { stopped.abort(); return "save"; } });
  await expect(cancelling.write(path.join(project.root, ".casper/project.yaml"), "commands: { test: 'true' }", stopped.signal)).rejects.toThrow();
  expect(await project.config()).toBe(original);
  const concurrent = new CheckChangeGuard(project.root, { commands: () => ({}), ask: async () => { await writeFile(path.join(project.root, ".casper/project.yaml"), "commands: { test: 'false' }"); return "save"; } });
  await expect(concurrent.write(path.join(project.root, ".casper/project.yaml"), "commands: { test: 'true' }")).rejects.toThrow("changed while approval");
  expect(await project.config()).toContain("false");
});

for (const choice of ["session", "save"] as const) {
  test(`${choice} command change uses the person's box and updates both current-task registries`, async () => {
    const project = await setup();
    const model = { project: { root: project.root }, commands: { test: "bun .casper/quick-test.ts" } } as ProjectModel;
    const task = new VerificationTask(VerifierRegistry.forProject(model), project.root);
    const verificationTask = new VerificationTask(VerifierRegistry.forProject(model), project.root);
    const boxes: unknown[][] = [];
    const app = { interactive: true, closing: false, approvalQueue: Promise.resolve(), output: { write() {} },
      terminal: { approve: async (...args: unknown[]) => { boxes.push(args); return CHECK_CHANGE_CHOICES[choice === "save" ? 1 : 2]; } },
      projectContext: { model, verification: { timeoutMs: 30_000 } }, checkTask: task, verificationTask,
    } as unknown as CasperApp;
    const options = checkChangeOptions(app);
    const guard = new CheckChangeGuard(project.root, options);
    const [, write] = guardedFileTools(project.root, guard);
    // Configured checks use cmd.exe on Windows: single quotes would evaluate a string, printing nothing.
    const command = 'bun -e "console.log(42)"';
    const next = `commands:\n  test: ${JSON.stringify(command)}\n`;
    const changed = write!.execute("override", { path: ".casper/project.yaml", content: next }, undefined, undefined, undefined as never);
    const result = await changed;
    if (choice === "session") {
      expect(result.details).toEqual({ sessionOnlyCheck: true });
      expect(result.content).toContainEqual({ type: "text", text: "– kept .casper/project.yaml as it is: session-only check in use. Use the session-only command; do not try to save the file again this task." });
      // Retrying either the config or its script never saves or asks again in this task.
      await write!.execute("retry", { path: ".casper/project.yaml", content: next }, undefined, undefined, undefined as never);
      const [edit] = guardedFileTools(project.root, guard);
      await edit!.execute("retry-script", { path: ".casper/quick-test.ts", edits: [{ oldText: "real test", newText: "different test" }] }, undefined, undefined, undefined as never);
      expect(await project.script()).toContain("real test");
      expect(boxes).toHaveLength(1);
    }
    expect(boxes[0]?.[0]).toContain("Old → new");
    expect(boxes[0]?.[0]).toContain("quick-test.ts");
    expect(boxes[0]?.[0]).toContain("console.log(42)");
    expect(boxes[0]?.[1]).toBe(CHECK_CHANGE_QUESTION);
    expect(boxes[0]?.[2]).toEqual(CHECK_CHANGE_CHOICES);
    expect(await project.config()).toBe(choice === "save" ? next : original);
    for (const current of [task, verificationTask]) {
      const [result] = await current.run(["test"]);
      expect(result).toMatchObject({ status: "pass", exitCode: 0 });
      expect(result?.stdout.trim()).toBe("42");
    }
    const fresh = { project: { root: project.root }, commands: { test: "bun .casper/quick-test.ts" } } as ProjectModel;
    applySessionCheckOverrides(app, fresh);
    expect(fresh.commands.test).toBe(command);
    const other = { ...fresh, project: { root: path.join(project.root, "other") }, commands: { test: "other" } } as ProjectModel;
    applySessionCheckOverrides(app, other);
    expect(other.commands.test).toBe("other");
    await task.close();
    await verificationTask.close();
  });
}

test("session-only suppresses concurrent/repeated check saves only until the next task", async () => {
  let task = {}, boxes = 0;
  const asked = Promise.withResolvers<void>(), answer = Promise.withResolvers<void>();
  const project = await setup({ commands: () => ({ test: "bun .casper/quick-test.ts" }), taskKey: () => task,
    ask: async change => {
      if (++boxes !== 1) return undefined;
      expect(change.sessionCommands).toEqual({ test: "bun test" });
      asked.resolve(); await answer.promise;
      return "session";
    }, useSessionCommands() {} });
  const next = "commands:\n  test: bun test\n";
  const command = project.call("write", { path: ".casper/project.yaml", content: next });
  // Native writes mkdir before entering the guard's queue: Promise.all's array order is not arrival order.
  // Hold the command's approval open, then start the competing script save before granting session-only.
  await asked.promise;
  const script = project.call("write", { path: ".casper/quick-test.ts", content: "skip" });
  answer.resolve();
  const results = await Promise.all([command, script]);
  for (const result of results) expect(result.details).toEqual({ sessionOnlyCheck: true });
  expect(boxes).toBe(1);
  expect(await project.config()).toBe(original);
  expect(await project.script()).toContain("real test");
  task = {};
  await expect(project.call("write", { path: ".casper/project.yaml", content: next })).rejects.toThrow("needs your OK");
  expect(boxes).toBe(2);
});

test("the real app box declines No, Enter/no answer and noninteractive runs", async () => {
  for (const answer of ["No", undefined]) {
    const project = await setup();
    const app = { interactive: true, closing: false, approvalQueue: Promise.resolve(), output: { write() {} }, terminal: { approve: async () => answer },
      projectContext: { model: { commands: {} } } } as unknown as CasperApp;
    await expect(new CheckChangeGuard(project.root, checkChangeOptions(app)).write(path.join(project.root, ".casper/project.yaml"), "commands: { test: 'true' }")).rejects.toThrow("needs your OK");
    expect(await project.config()).toBe(original);
  }
  const project = await setup();
  const app = { interactive: false, closing: false, approvalQueue: Promise.resolve(), projectContext: { model: { commands: {} } } } as unknown as CasperApp;
  await expect(new CheckChangeGuard(project.root, checkChangeOptions(app)).write(path.join(project.root, ".casper/project.yaml"), "commands: { test: 'true' }")).rejects.toThrow("needs your OK");
  expect(await project.config()).toBe(original);
});

test("unrelated config settings do not ask, and a new saved command's script is protected immediately", async () => {
  const project = await setup();
  await project.call("write", { path: ".casper/project.yaml", content: original + "conventions: [keep it small]\n" });
  expect(await project.config()).toContain("conventions");
  await writeFile(path.join(project.root, "check.ts"), "original");
  await writeFile(path.join(project.root, ".casper/project.yaml"), "verify:\n  checks:\n    smoke:\n      run: bun check.ts\n");
  await expect(project.call("write", { path: "check.ts", content: "skip" })).rejects.toThrow("needs your OK");
  expect(await readFile(path.join(project.root, "check.ts"), "utf8")).toBe("original");
});

test("shell mutation routes are refused before ordinary shell approval or execution", async () => {
  const project = await setup();
  let ran = false, approved = false;
  const ops = casperBashOperations({ wrap: async (command) => ({ command }), approve: async () => { approved = true; return undefined; } },
    { exec: async () => { ran = true; return { exitCode: 0 }; } }, project.guard);
  for (const command of ["echo skip > .casper/quick-test.ts", "rm -rf .casper", "python -c 'open(\".casper/project.yaml\",\"w\").write(\"\")'"]) {
    await expect(ops.exec(command, project.root, { onData() {} })).rejects.toThrow("Use native edit/write");
  }
  expect(ran).toBe(false); expect(approved).toBe(false);
  expect(await project.guard.shellReason("cat .casper/quick-test.ts")).toBeUndefined();
  expect(await project.guard.shellReason("bun .casper/quick-test.ts")).toBeUndefined();
  expect(await project.config()).toBe(original);
});

test("the check-rewrite guard never refuses a plain read of configured checks or their parent folders", async () => {
  const project = await setup();
  const commands = [
    "cd ~/.casper/agent && cat auth.json",
    'cat "$HOME/.casper/agent/auth.json"',
    "cat .casper/project.yaml .casper/quick-test.ts",
    "head -n 10 .casper/quick-test.ts | tail -n 5",
    "grep -n test .casper/project.yaml",
    "sed -n '1,10p' .casper/quick-test.ts",
    "cat < .casper/quick-test.ts",
    "python -c 'print(open(\".casper/project.yaml\").read())'",
    "python -c 'print(\"write\"); print(open(\".casper/project.yaml\").read())'",
    "python -c 'import sys; sys.stdout.write(\".casper/project.yaml\")'",
    "echo cp .casper/quick-test.ts",
    "echo rm .casper",
    "echo 'write .casper/project.yaml'",
  ];
  for (const command of commands) expect({ command, reason: await project.guard.shellReason(command) }).toEqual({ command, reason: undefined });
});

test("the check-rewrite guard stops writes to configured checks, not commands that only read them as inputs", async () => {
  const project = await setup();
  for (const command of [
    "cat .casper/quick-test.ts > output.txt",
    "python -c 'open(\"output.txt\",\"w\").write(open(\".casper/project.yaml\").read())'",
    "cp .casper/quick-test.ts output.txt",
    "cp .casper/quick-test.ts --target-directory=output",
    "cp --target-directory=output .casper/quick-test.ts",
    "cp -toutput .casper/quick-test.ts",
    "cp .casper/quick-test.ts output.txt && cat output.txt",
    "cd .casper && cp quick-test.ts ../output.txt",
    "cd -- .casper && cp quick-test.ts ../output.txt",
    "sh -c 'cd .casper && cp quick-test.ts ../output.txt'",
    "cd output && echo skip > quick-test.ts",
    "sh -c 'cd output && cat quick-test.ts'; echo skip > output.txt",
    "install .casper/quick-test.ts output.txt",
    "dd if=.casper/quick-test.ts of=output.txt",
    "echo '> .casper/quick-test.ts'",
    "echo .casper/project.yaml > output.txt",
  ]) expect({ command, reason: await project.guard.shellReason(command) }).toEqual({ command, reason: undefined });
  for (const command of [
    "cat output.txt > .casper/quick-test.ts",
    "cd .casper && echo skip > quick-test.ts",
    "cd -- .casper && echo skip > quick-test.ts",
    "cd -P -- .casper && echo skip > quick-test.ts",
    "sh -c 'cd .casper && echo skip > quick-test.ts'",
    "cd .casper && cp ../output.txt quick-test.ts",
    "printf skip >>.casper/quick-test.ts",
    "echo skip >| .casper/quick-test.ts",
    "echo skip >& .casper/quick-test.ts",
    "echo skip &> .casper/quick-test.ts",
    "python -c 'open(\".casper/quick-test.ts\",\"w\").close()'",
    "python -c 'open(\".casper/quick-test.ts\",\"r+\").close()'",
    "sed -n 'w .casper/quick-test.ts' output.txt",
    "sed -n 's/real/skipped/w .casper/quick-test.ts' output.txt",
    "tee .casper/quick-test.ts < output.txt",
    "sed -i 's/real/skipped/' .casper/quick-test.ts",
    "dd if=output.txt of=.casper/quick-test.ts",
    "mv output.txt .casper/quick-test.ts",
    "cp output.txt .casper/quick-test.ts",
    "rm -rf .casper",
  ]) expect({ command, refused: (await project.guard.shellReason(command))?.includes("Use native edit/write") }).toEqual({ command, refused: true });
  expect(await project.script()).toContain("real test");
});

test("recursive shell copies cannot reach execution or ordinary approval through a check's parent directory", async () => {
  const project = await setup();
  await writeFile(path.join(project.root, ".casper/project.yaml"), "commands:\n  test: bun check.ts\n");
  await writeFile(path.join(project.root, "check.ts"), "real check");
  await mkdir(path.join(project.root, "replacement"));
  await writeFile(path.join(project.root, "replacement/check.ts"), "skip");
  let ran = false, approved = false;
  const ops = casperBashOperations({ wrap: async (command) => ({ command }), approve: async () => { approved = true; return undefined; } },
    { exec: async () => { ran = true; return { exitCode: 0 }; } }, project.guard);
  for (const command of ["cp -r replacement/. .", "cp -r replacement/. ~+", "cp -r replacement/. ~/project", "cp -a replacement/. ./", "cp -R replacement/. .", "cp -r -t. replacement/.", "cp -Rt. replacement/.", "cp -r --target-directory=. replacement/.", "cp -r --target-dir=. replacement/.", "env cp -r replacement/. .", "sh -c 'cp -r replacement/. .'", "cd replacement && cp -r . .."]) {
    await expect(ops.exec(command, project.root, { onData() {} })).rejects.toThrow("Use native edit/write");
  }
  expect(ran).toBe(false);
  expect(approved).toBe(false);
  expect(await readFile(path.join(project.root, "check.ts"), "utf8")).toBe("real check");
  expect(await project.guard.shellReason("cp source.txt output.txt")).toBeUndefined();
});

test("missing, quoted and test-folder check scripts remain guarded at their write boundary", async () => {
  const commands: Record<string, string> = { test: 'bun "checks/check suite.ts"', smoke: "bun tests/check.ts" };
  const project = await setup({ commands: () => commands, ask: async () => undefined });
  commands.absolute = `bun ${JSON.stringify(path.join(project.root, "missing check.ts"))}`;
  for (const file of ["checks/check suite.ts", "tests/check.ts", "missing check.ts"]) {
    await expect(project.call("write", { path: file, content: "skip" })).rejects.toThrow("needs your OK");
    expect(await readFile(path.join(project.root, file), "utf8").catch(() => "absent")).toBe("absent");
  }
});

test("native write aliases cannot bypass protection of named check scripts", async () => {
  if (process.platform === "win32") return; // Windows symlink privileges are not assumed.
  const project = await setup();
  await symlink(path.join(project.root, ".casper/quick-test.ts"), path.join(project.root, "alias.ts"));
  await expect(project.call("write", { path: "alias.ts", content: "skip" })).rejects.toThrow("needs your OK");
  expect(await project.guard.shellReason("echo skip > alias.ts")).toContain("Use native edit/write");
  expect(await project.script()).toContain("real test");
});
