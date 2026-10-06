import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { definitionChanges, testDefinition } from "../src/verify/test-definition";
import { removeTempDir } from "./support/temp-dir";

const made: string[] = [];
afterEach(async () => { for (const dir of made.splice(0)) await removeTempDir(dir); });
async function project(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-testdef-"));
  made.push(root);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  return root;
}
const changed = async (root: string, command: string, edit: Record<string, string>) => {
  const before = await testDefinition(root, command);
  for (const [name, text] of Object.entries(edit)) await writeFile(path.join(root, name), text);
  return definitionChanges(before, await testDefinition(root, command));
};

test("rewriting the package.json script the test command runs is a change to its definition", async () => {
  const root = await project({ "package.json": JSON.stringify({ scripts: { test: "bun test", build: "tsc" } }) });
  expect(await changed(root, "bun run test", { "package.json": JSON.stringify({ scripts: { test: "echo all good", build: "tsc" } }) }))
    .toEqual(["package.json scripts.test"]);
});

test("a pre-script or a script the test script runs counts too; other scripts and dependencies do not", async () => {
  const root = await project({ "package.json": JSON.stringify({ scripts: { test: "npm run unit", unit: "jest", dev: "vite" }, dependencies: {} }) });
  expect(await changed(root, "npm test", { "package.json": JSON.stringify({ scripts: { test: "npm run unit", unit: "true", dev: "vite --host", pretest: "x" }, dependencies: { a: "1" } }) }))
    .toEqual(["package.json scripts.pretest", "package.json scripts.unit"]);
});

test("runner settings: bunfig.toml [test], pytest settings in pyproject.toml, a root conftest.py", async () => {
  const root = await project({ "bunfig.toml": "[install]\nexact = true\n", "pyproject.toml": "[project]\nname = \"x\"\n" });
  expect(await changed(root, "bun test", { "bunfig.toml": "[install]\nexact = false\n" })).toEqual([]);
  expect(await changed(root, "bun test", { "bunfig.toml": "[test]\npreload = [\"./setup.ts\"]\n" })).toEqual(["bunfig.toml [test]"]);
  expect(await changed(root, "uv run pytest", { "pyproject.toml": "[project]\nname = \"y\"\n" })).toEqual([]);
  expect(await changed(root, "uv run pytest", { "pyproject.toml": "[project]\nname = \"y\"\n[tool.pytest.ini_options]\naddopts = \"-k nothing\"\n" }))
    .toEqual(["pyproject.toml [tool.pytest]"]);
  expect(await changed(root, "uv run pytest", { "conftest.py": "import sys\n" })).toEqual(["conftest.py"]);
});

test("a script file the command names counts; a test file it names is the tests themselves", async () => {
  const root = await project({ "run-tests.sh": "bun test\n" });
  expect(await changed(root, "sh run-tests.sh", { "run-tests.sh": "true\n" })).toEqual(["run-tests.sh"]);
  expect(await changed(root, "./run-tests.sh", { "run-tests.sh": "exit 0\n" })).toEqual(["run-tests.sh"]);
  const tests = await project({});
  expect(await changed(tests, "sh tests/check.sh", {})).toEqual([]);
});
