import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { changedTestFiles, hasChangedTestPhase } from "../src/verify/changed-tests";
import { VerificationTask } from "../src/verify/task";
import { VerifierRegistry } from "../src/verify/registry";
import { loadProjectContext } from "../src/project/context";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(files: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-changed-tests-")));
  cleanup.push(() => removeTempDir(root));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

const graph = {
  "src/value.ts": "export const value = 1;",
  "src/barrel.ts": "export { value } from './value';",
  "src/cycle.ts": "import './barrel'; import './cycle';",
  "tests/direct.test.ts": "import '../src/value';",
  "tests/transitive.test.ts": "import '../src/cycle';",
  "tests/dynamic.test.ts": "await import('../src/value');",
  "tests/require.test.ts": "require('../src/value');",
  "tests/unrelated.test.ts": "// import '../src/value'\nconst fake = \"import '../src/value'\";",
  "tests/fixtures/fixture.test.ts": "import '../../src/value';",
};

test("changed selection includes literal direct, transitive, re-exported, cyclic, require and dynamic importers only", async () => {
  const root = await fixture(graph);
  expect(await changedTestFiles(root, ["src/value.ts"])).toEqual([
    "tests/direct.test.ts", "tests/dynamic.test.ts", "tests/require.test.ts", "tests/transitive.test.ts",
  ]);
  expect(await changedTestFiles(root, ["tests/unrelated.test.ts"])).toEqual(["tests/unrelated.test.ts"]);
  expect(await changedTestFiles(root, ["README.md"])).toEqual([]);
  expect(await changedTestFiles(root, [])).toEqual([]);
  expect(await changedTestFiles(root, undefined)).toBeUndefined();
  expect(await changedTestFiles(path.join(root, "missing-root"), ["src/value.ts"])).toBeUndefined();
});

test("a deleted source still selects its importers; unknown, aborted or oversized graphs defer rather than running the suite", async () => {
  const root = await fixture(graph);
  await rm(path.join(root, "src/value.ts"));
  expect(await changedTestFiles(root, ["src/value.ts"])).toEqual([
    "tests/direct.test.ts", "tests/dynamic.test.ts", "tests/require.test.ts", "tests/transitive.test.ts",
  ]);
  expect(await changedTestFiles(root, ["src/value.ts"], AbortSignal.abort())).toBeUndefined();
  await writeFile(path.join(root, "tests/large.test.ts"), " ".repeat(2_000_001));
  expect(await changedTestFiles(root, ["src/value.ts"])).toBeUndefined();
});

test("only known Bun entrypoints get the split; custom runners, flags and shell pipelines keep their exact contract", () => {
  for (const command of ["bun test", "bun .casper/quick-test.ts", "bun ./.casper/quick-test.ts", "bun run .casper/quick-test.ts"]) expect(hasChangedTestPhase(command)).toBe(true);
  for (const command of [undefined, "npm test", "bun run test", "bun tools/custom.ts", "bun test --watch", "bun .casper/quick-test.ts && echo extra", "bun test; echo extra"]) expect(hasChangedTestPhase(command)).toBe(false);
});

async function checkFixture(failFinal = false) {
  const root = await fixture({
    "src/value.ts": "export const value = 1;",
    "tests/related.test.ts": "import { expect, test } from 'bun:test'; import { value } from '../src/value'; test('value', () => expect(value).toBe(1));",
    "tests/unrelated.test.ts": "throw new Error('must not run while iterating');",
    ".casper/project.yaml": "commands:\n  test: bun .casper/quick-test.ts\nverification:\n  scopes:\n    test:\n      inputs: [src, tests]\n",
    ".casper/quick-test.ts": `import { appendFileSync } from 'node:fs'; appendFileSync('final-runs', 'F'); process.exit(${failFinal ? 7 : 0});`,
  });
  const context = await loadProjectContext({ root, cwd: root, name: "fixture", gitBranch: null, isGit: false }, { homeDir: path.join(root, "home") });
  const results: unknown[] = [];
  const task = new VerificationTask(VerifierRegistry.forProject(context.model, 30_000), root, result => results.push(result), async () => ["src/value.ts"]);
  cleanup.push(() => task.close());
  return { root, task, context, results };
}

test("iteration runs only importing files at width four, then runs the untouched configured check once, never reusing a targeted pass", async () => {
  const { root, task } = await checkFixture();
  const config = await readFile(path.join(root, ".casper/project.yaml"), "utf8");
  const script = await readFile(path.join(root, ".casper/quick-test.ts"), "utf8");
  expect((await task.run(["test"]))[0]).toMatchObject({ status: "pass", testPhase: "changed", command: "bun test --parallel=4 ./tests/related.test.ts" });
  expect(await Bun.file(path.join(root, "final-runs")).exists()).toBe(false);
  expect((await task.run(["test"]))[0]?.reused).toBe(true);
  const finishes = await Promise.all([task.finish(), task.finish()]);
  expect(finishes.flat()).toHaveLength(1);
  expect(finishes.flat()[0]).toMatchObject({ status: "pass", command: "bun .casper/quick-test.ts" });
  expect(finishes.flat()[0]?.testPhase).toBeUndefined();
  expect(await task.finish()).toEqual([]);
  expect(await readFile(path.join(root, "final-runs"), "utf8")).toBe("F");
  expect(await readFile(path.join(root, ".casper/project.yaml"), "utf8")).toBe(config);
  expect(await readFile(path.join(root, ".casper/quick-test.ts"), "utf8")).toBe(script);
  expect(await task.changedTestArgv()).toEqual(["bun", "test", "--parallel=4", "./tests/related.test.ts"]);
}, 60_000);

test("final configured failure remains a failure, and a cancelled task starts no final command", async () => {
  const { root, task } = await checkFixture(true);
  expect((await task.run(["test"]))[0]?.status).toBe("pass");
  expect((await task.finish())[0]).toMatchObject({ status: "fail", exitCode: 7, command: "bun .casper/quick-test.ts" });
  const other = await checkFixture();
  other.task.abort();
  expect(await other.task.finish()).toEqual([]);
  expect(await Bun.file(path.join(other.root, "final-runs")).exists()).toBe(false);
  expect(await readFile(path.join(root, "final-runs"), "utf8")).toBe("F");
}, 60_000);

test("no importing tests is an explicit deferred skip, not a pass or a broad iteration run; final still runs", async () => {
  const { root, context } = await checkFixture();
  const task = new VerificationTask(VerifierRegistry.forProject(context.model), root, undefined, async () => ["README.md"]);
  cleanup.push(() => task.close());
  expect((await task.run(["test"]))[0]).toMatchObject({ status: "skip", testPhase: "changed", reason: expect.stringContaining("No import-related tests") });
  expect((await task.finish())[0]?.status).toBe("pass");
  const unchanged = new VerificationTask(VerifierRegistry.forProject(context.model), root, undefined, async () => []);
  cleanup.push(() => unchanged.close());
  expect(await unchanged.finish()).toEqual([]);
}, 60_000);

test("explicit verification without a model task runs the configured test directly", async () => {
  const { root, context } = await checkFixture();
  const task = new VerificationTask(VerifierRegistry.forProject(context.model), root);
  cleanup.push(() => task.close());
  expect((await task.run(["test"]))[0]).toMatchObject({ status: "pass", command: "bun .casper/quick-test.ts" });
  expect(await readFile(path.join(root, "final-runs"), "utf8")).toBe("F");
  expect(await task.finish()).toEqual([]);
}, 60_000);
