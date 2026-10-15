import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { taskExitCode } from "../src/task/result";
import { removeTempDir } from "./support/temp-dir";
import { finishConfiguredTest } from "../src/app/verification";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options: { finalExit?: number; target?: number; modelCheck?: boolean; edit?: boolean; stop?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-check-phases-"));
  cleanup.push(() => removeTempDir(root));
  await mkdir(path.join(root, ".casper"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "tests"));
  const config = "commands:\n  typecheck: bun .casper/typecheck.ts\n  lint: bun .casper/lint.ts\n  test: bun .casper/quick-test.ts\n  build: bun .casper/build.ts\nverification:\n  mode: auto\nrepair:\n  maxAttempts: 0\n";
  await writeFile(path.join(root, ".casper/project.yaml"), config);
  for (const name of ["typecheck", "lint", "quick-test", "build"]) await writeFile(path.join(root, `.casper/${name}.ts`),
    `import { appendFileSync } from 'node:fs'; appendFileSync('${name}-runs', 'x'); process.exit(${name === "quick-test" ? options.finalExit ?? 0 : 0});`);
  await writeFile(path.join(root, "src/value.ts"), "export const value = 1;");
  await writeFile(path.join(root, "tests/value.test.ts"), `import {expect,test} from 'bun:test'; import {value} from '../src/value'; test('value', () => expect(value).toBe(${options.target ?? 2}));`);
  await writeFile(path.join(root, "tests/unrelated.test.ts"), "throw new Error('not an importing test');");
  let tools: RuntimeTool[] = [];
  let start: RuntimeStartOptions;
  const modelResults: unknown[] = [];
  const runtime: AgentRuntime = {
    async start(given) {
      start = given; tools = given.tools ?? [];
      return {
        async prompt() {
          if (options.edit !== false) {
            await writeFile(path.join(root, "src/value.ts"), "export const value = 2;");
            await start.afterFileEdit?.("src/value.ts");
          }
          if (options.modelCheck) {
            modelResults.push(JSON.parse((await tools.find(tool => tool.name === "casper_check")!.execute({ check: "test" })).text));
            expect(await Bun.file(path.join(root, "quick-test-runs")).exists()).toBe(false);
          }
          if (options.stop) app.commandAbort?.abort();
        },
        setTools(next) { tools = next; }, abort: async () => {}, subscribe: () => () => {},
        getState: () => ({ cwd: root, isStreaming: false }),
      };
    }, dispose: async () => {},
  };
  let output = "";
  const homeDir = path.join(root, "home");
  const app = new CasperApp({ runtimeFactory: () => runtime, sessionHomeDir: homeDir,
    output: { write(text) { output += text; } },
    loadProjectContext: info => loadProjectContext(info, { homeDir }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir }),
  });
  cleanup.push(() => app.close());
  return { app, root, config, modelResults, output: () => output };
}

test("model iteration and automatic checks select imports, run typecheck/lint, then record one unchanged configured test before the receipt", async () => {
  const f = await fixture({ modelCheck: true });
  const report = await f.app.runOnce("Refactor the value", f.root);
  expect(f.modelResults).toEqual([expect.objectContaining({ testPhase: "changed", command: "bun test --parallel=4 ./tests/value.test.ts", status: "pass" })]);
  expect(report?.status).toBe("pass");
  expect(report?.results.find(result => result.name === "test")).toMatchObject({ command: "bun .casper/quick-test.ts", status: "pass" });
  expect(report?.results.find(result => result.name === "test")?.testPhase).toBeUndefined();
  expect(report?.rounds.slice(0, -1).flat().some(result => result.name === "build")).toBe(false);
  expect(report?.rounds.at(-1)?.map(result => result.name)).toEqual(["test", "build"]);
  for (const name of ["typecheck", "lint", "quick-test", "build"]) expect(await readFile(path.join(f.root, `${name}-runs`), "utf8")).toBe("x");
  expect(await readFile(path.join(f.root, ".casper/project.yaml"), "utf8")).toBe(f.config);
  expect(f.app.getLastTaskResult()?.verification?.results.find(result => result.name === "test")?.command).toBe("bun .casper/quick-test.ts");
  expect(f.output().lastIndexOf("test")).toBeGreaterThan(f.output().indexOf("Casper checking"));
}, 60_000);

test("proof uses only the related argv in both copies, leaving the full configured selection for one final run", async () => {
  const f = await fixture();
  const report = await f.app.runOnce("Fix the value", f.root);
  expect(report?.status).toBe("pass");
  expect(f.app.getLastTaskResult()?.proof).toMatchObject({ status: "proven", command: "bun test --parallel=4 ./tests/value.test.ts" });
  expect(await readFile(path.join(f.root, "quick-test-runs"), "utf8")).toBe("x");
}, 90_000);

test("the final configured failure decides the receipt and exit code, not an earlier targeted green", async () => {
  const f = await fixture({ finalExit: 7 });
  const report = await f.app.runOnce("Refactor the value", f.root);
  expect(report?.status).toBe("fail");
  expect(taskExitCode(report, f.app.getLastTaskResult())).toBe(1);
  expect(await readFile(path.join(f.root, "quick-test-runs"), "utf8")).toBe("x");
}, 60_000);

test("a final green cannot erase a targeted assertion failure", async () => {
  const f = await fixture({ target: 9 });
  const report = await f.app.runOnce("Refactor the value", f.root);
  expect(report?.status).toBe("fail");
  expect(report?.rounds.flat().some(result => result.testPhase === "changed" && result.status === "fail")).toBe(true);
  expect(report?.results.find(result => result.name === "test")).toMatchObject({ testPhase: "changed", status: "fail" });
  expect(taskExitCode(report, f.app.getLastTaskResult())).toBe(1);
  expect(await readFile(path.join(f.root, "quick-test-runs"), "utf8")).toBe("x");
}, 60_000);

test("an explicit model-selected test still gets the configured final run when no file needed an edit", async () => {
  const f = await fixture({ edit: false, modelCheck: true });
  const report = await f.app.runOnce("Run the tests", f.root);
  expect(f.modelResults).toEqual([expect.objectContaining({ status: "skip", testPhase: "changed" })]);
  expect(report?.results.find(result => result.name === "test")).toMatchObject({ status: "pass", command: "bun .casper/quick-test.ts" });
  expect(await readFile(path.join(f.root, "quick-test-runs"), "utf8")).toBe("x");
}, 60_000);

test("a stopped or unchanged model task starts no automatic final check; explicit /verify still runs the owner's command", async () => {
  const f = await fixture({ edit: false });
  await f.app.runOnce("Inspect the value", f.root);
  expect(await Bun.file(path.join(f.root, "quick-test-runs")).exists()).toBe(false);
  expect((await f.app.runOnce("/verify test"))?.results[0]?.command).toBe("bun .casper/quick-test.ts");
  const stopped = await fixture({ stop: true });
  await stopped.app.runOnce("Refactor the value", stopped.root);
  expect(await Bun.file(path.join(stopped.root, "quick-test-runs")).exists()).toBe(false);
  expect(await finishConfiguredTest(stopped.app)).toBeUndefined();
}, 60_000);
