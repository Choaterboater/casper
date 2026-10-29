import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectInfo } from "../src/project/inspect";
import { loadProjectModel } from "../src/project/model";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
async function project(files: Record<string, string>): Promise<ProjectInfo> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-node-")); dirs.push(root);
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  return { root, name: path.basename(root), isGit: false } as ProjectInfo;
}
async function model(files: Record<string, string>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-node-home-")); dirs.push(home);
  return loadProjectModel(await project(files), { homeDir: home });
}
const scripts = (entries: Record<string, string>) => JSON.stringify({ name: "demo", scripts: entries });
const bunTest = "import { expect, test } from 'bun:test';\ntest('adds', () => expect(1 + 1).toBe(2));\n";

// A benchmark run: in 11 of 24 projects the check was a `check` script (or bun tests and no script), so Casper ran
// nothing, said "no tests yet. Say "add tests"" over a project with tests, and gave the model no casper_check.
test("a check script that runs the tests is the test check when there is no test script", async () => {
  const found = await model({ "package.json": scripts({ check: "bun test" }), "src/calculate.js": "export const add = (a, b) => a - b;\n", "tests/calculate.test.js": bunTest });
  expect(found.commands).toEqual({ test: "bun run check" });
  expect(found.testsWithoutCommand).toBeUndefined();
  // One that calls other scripts is judged by what they run: here the tests, through `unit`.
  expect((await model({ "bun.lock": "", "package.json": scripts({ check: "bun run lint && bun run unit", lint: "eslint .", unit: "bun test" }) })).commands)
    .toEqual({ test: "bun run check", lint: "bun run lint" });
  // A check of its own that Casper can't read is still the project's check: it runs as the test check.
  expect((await model({ "package-lock.json": "{}", "package.json": scripts({ check: "node scripts/check.mjs" }) })).commands).toEqual({ test: "npm run check" });
});

test("a check script that only type-checks or only lints fills that check, never a test it doesn't run", async () => {
  expect((await model({ "package-lock.json": "{}", "package.json": scripts({ check: "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json" }) })).commands)
    .toEqual({ typecheck: "npm run check" });
  expect((await model({ "bun.lock": "", "package.json": scripts({ check: "biome check ." }) })).commands).toEqual({ lint: "bun run check" });
  expect((await model({ "package-lock.json": "{}", "package.json": scripts({ check: "tsc --noEmit && eslint ." }) })).commands).toEqual({ typecheck: "npm run check" });
});

test("the project's own test, typecheck and lint scripts still win; a check script fills only an empty one", async () => {
  expect((await model({ "package-lock.json": "{}", "package.json": scripts({ test: "vitest run", check: "tsc --noEmit" }) })).commands)
    .toEqual({ test: "npm run test", typecheck: "npm run check" });
  expect((await model({ "package-lock.json": "{}", "package.json": scripts({ test: "vitest run", typecheck: "tsc --noEmit", check: "tsc -p ." }) })).commands)
    .toEqual({ test: "npm run test", typecheck: "npm run typecheck" });
  expect((await model({ "package-lock.json": "{}", "package.json": scripts({ test: "vitest run", check: "node scripts/check.mjs" }) })).commands)
    .toEqual({ test: "npm run test" });
});

test("bun tests with no test or check script run with bun test: in a Bun project, or wherever they import bun:test", async () => {
  expect((await model({ "bun.lock": "", "package.json": scripts({ dev: "bun run src/index.ts" }), "tests/add.test.ts": bunTest })).commands.test).toBe("bun test");
  // Bun's own file names, next to the code too.
  expect((await model({ "bun.lock": "", "package.json": "{}", "src/add.spec.ts": "test('a', () => {});\n" })).commands.test).toBe("bun test");
  // An npm lockfile, or no package.json at all (a tsconfig and its tests): the bun:test import says what runs them.
  expect((await model({ "package-lock.json": "{}", "package.json": "{}", "tests/add.test.ts": bunTest })).commands.test).toBe("bun test");
  expect((await model({ "tsconfig.json": "{}", "src/invoice.ts": "export const total = 1;\n", "tests/invoice.test.ts": bunTest })).commands.test).toBe("bun test");
  // No test files, no command; dependencies' tests are not the project's.
  expect((await model({ "bun.lock": "", "package.json": "{}", "src/index.ts": "" })).commands.test).toBeUndefined();
  expect((await model({ "bun.lock": "", "package.json": "{}", "node_modules/dep/a.test.ts": bunTest })).commands.test).toBeUndefined();
});

test("Node's own test runner: tests that import node:test, with no script, run with node --test", async () => {
  const nodeTest = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('adds', () => assert.equal(1 + 1, 2));\n";
  // A browser app with no root package.json and test/*.test.mjs (as a project with a cad/ package and an HTML front end).
  const app = await model({ "index.html": "<!doctype html>", "cad/package.json": "{}", "test/otto.test.mjs": nodeTest,
    "test/engine.test.mjs": "const { test } = require('node:test');\n" });
  expect(app.commands.test).toBe('node --test "**/*.test.mjs"');
  expect(app.testsWithoutCommand).toBeUndefined();
  expect((await model({ "package-lock.json": "{}", "package.json": "{}", "tests/add.test.js": nodeTest })).commands.test).toBe('node --test "**/*.test.js"');
  // Plain node --test also runs every .js/.mjs under test/ (helpers, fixtures) and counts each as a test: the pattern
  // names only the test files' own endings.
  const helpers = await model({ "test/a.test.mjs": nodeTest, "test/b_test.cjs": nodeTest, "test/helpers/h.mjs": "export const x = 1;\n",
    "test/fixtures/f.js": "export const y = 1;\n" });
  expect(helpers.commands.test).toBe('node --test "**/*.test.mjs" "**/*_test.cjs"');
  // bun:test still wins where it is imported, and a script still wins over both.
  expect((await model({ "tsconfig.json": "{}", "tests/a.test.ts": "import { test } from 'bun:test';\n", "tests/b.test.mjs": nodeTest })).commands.test).toBe("bun test");
  expect((await model({ "package-lock.json": "{}", "package.json": scripts({ test: "node --test test/" }), "test/a.test.mjs": nodeTest })).commands.test).toBe("npm run test");
});

test("tests Casper finds but has no command for are said as that, not as no tests", async () => {
  // Jest-style tests in an npm project with no script: nothing says what runs them.
  const jest = await model({ "package-lock.json": "{}", "package.json": "{}", "__tests__/add.test.js": "test('a', () => expect(1).toBe(1));\n" });
  expect(jest.commands.test).toBeUndefined();
  expect(jest.testsWithoutCommand).toBe(true);
  // pytest-style tests in a project that doesn't list pytest.
  const pytest = await model({ "pyproject.toml": '[project]\nname = "x"\n', "tests/test_a.py": "def test_a():\n    assert True\n" });
  expect(pytest.commands.test).toBeUndefined();
  expect(pytest.testsWithoutCommand).toBe(true);
  // A project with a test command, or with no tests at all, has no such flag.
  expect((await model({ "package-lock.json": "{}", "package.json": scripts({ test: "jest" }), "__tests__/add.test.js": "" })).testsWithoutCommand).toBeUndefined();
  expect((await model({ "package-lock.json": "{}", "package.json": "{}", "src/add.js": "" })).testsWithoutCommand).toBeUndefined();
});

test("a test folder or a test file in it added later rebuilds the cached detection", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-node-home-")); dirs.push(home);
  const info = await project({ "bun.lock": "", "package.json": "{}", "src/add.ts": "export const add = (a: number, b: number) => a + b;\n" });
  expect((await loadProjectModel(info, { homeDir: home })).commands.test).toBeUndefined();
  await mkdir(path.join(info.root, "tests"));
  await writeFile(path.join(info.root, "tests/add.test.ts"), bunTest);
  expect((await loadProjectModel(info, { homeDir: home })).commands.test).toBe("bun test");

  const later = await project({ "package-lock.json": "{}", "package.json": "{}", "tests/helpers.js": "export {};\n" });
  expect((await loadProjectModel(later, { homeDir: home })).testsWithoutCommand).toBeUndefined();
  await writeFile(path.join(later.root, "tests/add.test.js"), "test('a', () => {});\n");
  expect((await loadProjectModel(later, { homeDir: home })).testsWithoutCommand).toBe(true);
});
