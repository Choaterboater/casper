import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext, type ProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { OBSERVED_EDITS_LIMIT } from "../src/task/observations";
import { NO_CHECKS_LINE } from "../src/task/result";
import { removeTempDir } from "./support/temp-dir";

const python = Bun.which("python3");

/** ~/Documents with 21,000 files (too big to compare) and sample-tools inside it: a pyproject and a passing unittest. */
let root = "";
let home = "";
let docs = "";
beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-huge-work-")));
  home = path.join(root, "home");
  docs = path.join(home, "Documents");
  for (let batch = 0; batch < 21; batch++) {
    const folder = path.join(docs, `photos-${batch}`);
    await mkdir(folder, { recursive: true });
    await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(path.join(folder, `${index}.txt`), "")));
  }
  const tools = path.join(docs, "sample-tools");
  await mkdir(path.join(tools, "tests"), { recursive: true });
  await writeFile(path.join(tools, "pyproject.toml"), '[project]\nname = "sample-tools"\n');
  await writeFile(path.join(tools, "sites.py"), "def count():\n    return 2\n");
  await writeFile(path.join(tools, "tests", "test_sites.py"),
    "import unittest\nimport sites\n\nclass T(unittest.TestCase):\n    def test_count(self):\n        self.assertEqual(sites.count(), 3)\n");
}, 180_000);
afterAll(async () => { if (root) await removeTempDir(root); });

/** A model whose edit and write tools write these files, in this order; a file with no text is only reported. */
async function run(request: string, files: Array<[file: string, text?: string]>) {
  const runtime: AgentRuntime = {
    async start(options): Promise<RuntimeSession> {
      return { getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }), getState: () => ({ cwd: docs, isStreaming: false }),
        subscribe: () => () => {}, abort: async () => {}, setTools: () => {},
        prompt: async () => {
          for (const [file, text] of files) {
            if (text !== undefined) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
            await options.afterFileEdit?.(file, new AbortController().signal);
          }
        } };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({ runtimeFactory: () => runtime, sessionHomeDir: home, output: { write: (text: string) => { output += text; } },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context: ProjectContext) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  try {
    await app.runOnce(request, docs);
    return { output, task: app.getLastTaskResult() };
  } finally { await app.close(); }
}

test.skipIf(!python)("in a folder of over 20,000 files, edits that all land in one project inside it run that project's checks and say where the work is", async () => {
  // Scratch in the temp folder first: only the files inside Documents say where the work is.
  const { output, task } = await run("fix the sites count in sample-tools",
    [[path.join(root, "scratch", "draft.txt"), "x"], [path.join(docs, "sample-tools", "sites.py"), "def count():\n    return 3\n"]]);
  expect(output).toContain("• Casper checking: test (checks from sample-tools)");
  expect(output).toContain("[folder] The work is in ~/Documents/sample-tools. To work there: cd ~/Documents/sample-tools && casper\n");
  // Bash changes are still unknown: the work folder comes from what Casper's own tools changed.
  expect(output).toContain("– Changes unknown: not a project folder (over 20,000 files)");
  expect(output).toContain("– Changed (seen by Casper's edit and write tools): sample-tools/sites.py");
  expect(output).not.toContain("Not verified — no checks set up");
  expect(output).not.toContain(NO_CHECKS_LINE);
  expect(task?.verification?.status).toBe("pass");
}, 180_000);

test("in a folder of over 20,000 files, the Changed line leaves out scratch in the temp folders and keeps other files", async () => {
  // Under the system temp folder, outside Documents: scratch the sandbox lets through without asking.
  const scratch = path.join(root, "scratch", "index-template.html");
  // Outside Documents and every temp folder: named in full. Only reported, never written.
  const elsewhere = path.join(path.parse(root).root, "casper-not-scratch", "notes.md");
  // Documents named through a link in the temp folder (as macOS's /tmp is /private/tmp): a file in the folder, not scratch.
  const link = path.join(root, "documents-link");
  await symlink(docs, link, "junction");
  const { output } = await run("write up the lab in lab.md",
    [[path.join(docs, "lab.md"), "# lab\n"], [scratch, "<p>draft</p>\n"], [elsewhere], [path.join(link, "plan.md"), "# plan\n"]]);
  expect(output).toContain("– Changes unknown: not a project folder (over 20,000 files)");
  expect(output).toContain(`– Changed (seen by Casper's edit and write tools): lab.md, ${elsewhere}, plan.md\n`);
  expect(output).not.toContain("index-template.html");
}, 180_000);

test("in a folder of over 20,000 files, when the tools changed more files than Casper keeps, Casper does not say where the work is", async () => {
  // The files past the limit go unlisted and may sit in another project, so the ones listed (all in sample-tools) don't decide.
  const notes = Array.from({ length: OBSERVED_EDITS_LIMIT }, (_, index): [string, string] => [path.join(docs, "sample-tools", "notes", `${index}.md`), "note\n"]);
  const { output } = await run("write the notes, then the summary", [...notes, [path.join(docs, "summary.md"), "# summary\n"]]);
  expect(output).toContain("– Changes unknown: not a project folder (over 20,000 files)");
  expect(output).toContain("– Changed (seen by Casper's edit and write tools): sample-tools/notes/0.md");
  expect(output).not.toContain("checks from sample-tools");
  expect(output).not.toContain("The work is in");
}, 180_000);
