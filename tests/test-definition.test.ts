import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { definitionChanges, testDefinition } from "../src/verify/test-definition";
import { removeTempDir } from "./support/temp-dir";

const made: string[] = [];
afterEach(async () => { for (const dir of made.splice(0)) await removeTempDir(dir); });
async function project(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-testdef-"));
  made.push(root);
  for (const [name, text] of Object.entries(files)) await put(root, name, text);
  return root;
}
async function put(root: string, name: string, text: string) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), text);
}
const changed = async (root: string, command: string, edit: Record<string, string>) => {
  const before = await testDefinition(root, command);
  for (const [name, text] of Object.entries(edit)) await put(root, name, text);
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

test("files named inside the package.json script count: a script file, a --config file, the Makefile it runs", async () => {
  const files = {
    "package.json": JSON.stringify({ scripts: { test: "sh scripts/check.sh && jest --config config/jest.ci.js && make unit" } }),
    "scripts/check.sh": "bun test\n", "config/jest.ci.js": "module.exports = {};\n", Makefile: "unit:\n\tbun test\n",
  };
  for (const command of ["bun run test", "npm test"]) {
    const root = await project(files);
    expect(await changed(root, command, { "scripts/check.sh": "exit 0\n" })).toEqual(["scripts/check.sh"]);
    expect(await changed(root, command, { "config/jest.ci.js": "module.exports = { testMatch: [] };\n" })).toEqual(["config/jest.ci.js"]);
    expect(await changed(root, command, { Makefile: "unit:\n\ttrue\n" })).toEqual(["Makefile"]);
  }
});

test("a --config value with no dot or slash counts; a folder the script names does not", async () => {
  const root = await project({ "package.json": JSON.stringify({ scripts: { test: "mocha -c ci-settings src/ ." } }), "ci-settings": "a\n", "src/a.ts": "1\n" });
  expect(await changed(root, "npm test", { "src/b.ts": "2\n", "c.ts": "3\n" })).toEqual([]);
  expect(await changed(root, "npm test", { "ci-settings": "b\n" })).toEqual(["ci-settings"]);
});

test("a file the command only looks at is the code under test, not the definition", async () => {
  const root = await project({ "sum.js": "broken\n", "package.json": JSON.stringify({ scripts: { test: "node scripts/run.js src/sum.js" } }), "scripts/run.js": "1\n", "src/sum.js": "1\n" });
  expect(await changed(root, "grep -q fixed sum.js", { "sum.js": "fixed\n" })).toEqual([]);
  expect(await changed(root, "npm test", { "src/sum.js": "2\n" })).toEqual([]);
  expect(await changed(root, "npm test", { "scripts/run.js": "2\n" })).toEqual(["scripts/run.js"]);
});

test("a conftest.py outside the test folders counts (src layout); one inside them is the tests", async () => {
  const root = await project({ "src/conftest.py": "import sys\n", "tests/conftest.py": "import os\n" });
  expect(await changed(root, "uv run pytest", { "src/conftest.py": "def pytest_sessionfinish(session, exitstatus):\n  session.exitstatus = 0\n" }))
    .toEqual(["src/conftest.py"]);
  expect(await changed(root, "uv run pytest", { "tests/conftest.py": "import json\n" })).toEqual([]);
});

test("vite.config counts when the script runs vitest and there is no vitest.config", async () => {
  const root = await project({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "vite.config.ts": "export default {};\n" });
  expect(await changed(root, "npm test", { "vite.config.ts": "export default { test: { include: [] } };\n" })).toEqual(["vite.config.ts"]);
  const own = await project({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "vite.config.ts": "export default {};\n", "vitest.config.ts": "export default {};\n" });
  expect(await changed(own, "npm test", { "vite.config.ts": "export default { plugins: [] };\n" })).toEqual([]);
});

async function relink(root: string, name: string, destination: string) {
  const link = path.join(root, name);
  await unlink(link).catch(() => undefined);
  await symlink(destination, link);
}

test("retargeting a runner symlink is a change to the test definition", async () => {
  const root = await project({ "scripts/strict.js": "process.exit(1);\n", "scripts/other.js": "process.exit(0);\n" });
  await symlink("strict.js", path.join(root, "scripts", "check.js"));
  const before = await testDefinition(root, "bun scripts/check.js");
  expect(before.has("scripts/check.js")).toBe(true);
  await relink(root, "scripts/check.js", "other.js");
  expect(definitionChanges(before, await testDefinition(root, "bun scripts/check.js"))).toEqual(["scripts/check.js"]);
});

test("editing the file a runner symlink points at is a change; leaving it alone is not", async () => {
  const root = await project({ "scripts/strict.js": "process.exit(1);\n" });
  await symlink("strict.js", path.join(root, "scripts", "check.js"));
  const before = await testDefinition(root, "bun scripts/check.js");
  expect(definitionChanges(before, await testDefinition(root, "bun scripts/check.js"))).toEqual([]);
  await put(root, "scripts/strict.js", "process.exit(0);\n");
  expect(definitionChanges(before, await testDefinition(root, "bun scripts/check.js"))).toEqual(["scripts/check.js"]);
});

test("a broken runner symlink counts when its destination text changes", async () => {
  const root = await project({});
  await mkdir(path.join(root, "scripts"));
  await symlink("missing-a.js", path.join(root, "scripts", "check.js"));
  const before = await testDefinition(root, "bun scripts/check.js");
  expect(before.has("scripts/check.js")).toBe(true);
  expect(definitionChanges(before, await testDefinition(root, "bun scripts/check.js"))).toEqual([]);
  await relink(root, "scripts/check.js", "missing-b.js");
  expect(definitionChanges(before, await testDefinition(root, "bun scripts/check.js"))).toEqual(["scripts/check.js"]);
});

test("a runner symlink pointing outside the project is not read, but retargeting it is still a change", async () => {
  const outside = await project({ "a.js": "one\n", "b.js": "two\n" });
  const root = await project({});
  await mkdir(path.join(root, "scripts"));
  await symlink(path.join(outside, "a.js"), path.join(root, "scripts", "check.js"));
  const before = await testDefinition(root, "bun scripts/check.js");
  await put(outside, "a.js", "edited\n");
  expect(definitionChanges(before, await testDefinition(root, "bun scripts/check.js"))).toEqual([]);
  await relink(root, "scripts/check.js", path.join(outside, "b.js"));
  expect(definitionChanges(before, await testDefinition(root, "bun scripts/check.js"))).toEqual(["scripts/check.js"]);
});

test("an ordinary runner script file still counts when edited", async () => {
  const root = await project({ "scripts/check.js": "process.exit(1);\n" });
  expect(await changed(root, "bun scripts/check.js", { "scripts/check.js": "process.exit(0);\n" })).toEqual(["scripts/check.js"]);
});
