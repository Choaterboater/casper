import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { childProjectOf } from "../src/project/child";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { taskExitCode } from "../src/task/result";
import { receiptEvent } from "../src/app/json-events";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

async function documents(): Promise<{ root: string; home: string; docs: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-child-")); dirs.push(root);
  const home = path.join(root, "home"); const docs = path.join(home, "Documents");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "notes.md"), "lab notes\n");
  return { root, home, docs };
}

async function mistTools(docs: string): Promise<string> {
  const dir = path.join(docs, "sample-tools");
  await mkdir(path.join(dir, "tests"), { recursive: true });
  await mkdir(path.join(dir, "sample_tools"), { recursive: true });
  await writeFile(path.join(dir, "pyproject.toml"), '[project]\nname = "sample-tools"\n');
  await writeFile(path.join(dir, "sample_tools", "sites.py"), "def count():\n    return 1\n");
  await writeFile(path.join(dir, "tests", "test_sites.py"), "import unittest\n");
  return dir;
}

function app(home: string) {
  let output = "";
  const casper = new CasperApp({ runtimeFactory: () => { throw new Error("no runtime"); }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    output: { write(text: string) { output += text; } } });
  return { casper, output: () => output };
}

test("the one child project holding every change is found; spread-out or top-level changes are not", async () => {
  const { home, docs } = await documents();
  const dir = await mistTools(docs);
  const child = await childProjectOf(docs, ["sample-tools/sample_tools/sites.py", "sample-tools/tests/test_sites.py"], home);
  expect(child?.dir).toBe(dir);
  expect(child?.relative).toBe("sample-tools");
  expect(child?.model.commands.test).toContain("-m unittest discover -s tests");
  expect(await childProjectOf(docs, ["sample-tools/tests/test_sites.py", "notes.md"], home)).toBeUndefined();
  expect(await childProjectOf(docs, ["notes.md"], home)).toBeUndefined();
  await mkdir(path.join(docs, "scratch"));
  expect(await childProjectOf(docs, ["scratch/a.txt"], home)).toBeUndefined();
});

test("/verify with nothing to run says so in one line and points at the folder with tests", async () => {
  const { home, docs } = await documents();
  await mistTools(docs);
  const { casper, output } = app(home);
  try {
    const report = await casper.runOnce("/verify", docs);
    // Nothing ran: a script still gets exit 2 (a CI gate never passes on nothing), in plain words, not "Incomplete".
    expect(taskExitCode(report, casper.getLastTaskResult())).toBe(2);
    expect(receiptEvent(report, undefined, 2).verdict).toBe('• Not checked — no tests yet. Say "add tests".');
    const text = output();
    expect(text).toContain("[verify] No checks found in Documents. Tests found in sample-tools: /project sample-tools\n");
    expect(text).not.toContain("has no command");
    expect(text).not.toContain("Incomplete");
  } finally { await casper.close(); }
});

test("/verify with nothing to run and no tests anywhere says how to add one", async () => {
  const { home, docs } = await documents();
  const { casper, output } = app(home);
  try {
    await casper.runOnce("/verify", docs);
    expect(output()).toContain('[verify] No tests in Documents yet. Say "add tests" and Casper writes some.\n');
    expect(output()).not.toContain("Incomplete");
  } finally { await casper.close(); }
});

test("/verify in a project with only tests runs them and says so in one line, not Incomplete", async () => {
  const { home, docs } = await documents();
  const dir = await mistTools(docs);
  await writeFile(path.join(dir, "tests", "test_sites.py"),
    "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertTrue(True)\n");
  const { casper, output } = app(home);
  try {
    const report = await casper.runOnce("/verify", dir);
    expect(output()).toContain("[verify] No typecheck, lint or build command here, so Casper runs test.\n");
    expect(report?.results.map((result) => result.name)).toEqual(["test"]);
    expect(output()).not.toContain("has no command");
    expect(output()).not.toContain("Incomplete");
  } finally { await casper.close(); }
});
