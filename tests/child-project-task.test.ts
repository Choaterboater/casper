import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext, type ProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";

setDefaultTimeout(30_000);
const ambientTerm = process.env.TERM;
const ambientNoColor = process.env.NO_COLOR;
process.env.TERM = "xterm-256color";
delete process.env.NO_COLOR;
afterAll(() => {
  if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm;
  if (ambientNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = ambientNoColor;
});

const python = Bun.which("python3");

/** ~/Documents with a note, and a model that builds mist-tools inside it: a pyproject and a passing unittest. */
async function lab() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-child-task-")));
  const home = path.join(root, "home");
  const docs = path.join(home, "Documents");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "notes.md"), "lab notes\n");
  const starts: string[] = [];
  let disposed = 0;
  const runtime: AgentRuntime = {
    async start(options): Promise<RuntimeSession> {
      starts.push(options.cwd);
      const listeners = new Set<RuntimeEventListener>();
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: options.cwd, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => {
          const dir = path.join(docs, "mist-tools");
          await mkdir(path.join(dir, "tests"), { recursive: true });
          await writeFile(path.join(dir, "pyproject.toml"), '[project]\nname = "mist-tools"\n');
          await writeFile(path.join(dir, "sites.py"), "def count():\n    return 3\n");
          await writeFile(path.join(dir, "tests", "test_sites.py"),
            "import unittest\nimport sites\n\nclass T(unittest.TestCase):\n    def test_count(self):\n        self.assertEqual(sites.count(), 3)\n");
        },
      };
    },
    async dispose() { disposed++; },
  };
  return { root, home, docs, runtime, starts, disposed: () => disposed };
}

function options(home: string, runtime: AgentRuntime) {
  return {
    runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info: Parameters<typeof loadProjectContext>[0]) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context: ProjectContext) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  };
}

test.skipIf(!python)("work that lands in a project inside the folder runs that project's checks and says where the work is", async () => {
  const { root, home, docs, runtime } = await lab();
  let output = "";
  const app = new CasperApp({ ...options(home, runtime), output: { write: (text: string) => { output += text; } } });
  try {
    await app.runOnce("build a mist tool that counts sites, with tests", docs);
    expect(output).toContain("… Casper checking: test (checks from mist-tools)");
    expect(output).toMatch(/✓ test passed \(checks from mist-tools · python3? -m unittest discover -s tests|✓ test passed \(checks from mist-tools · .*-m unittest discover -s tests/);
    expect(output).not.toContain("Not verified");
    // One-shot can't ask: it says the command to use.
    expect(output).toContain("[folder] The work is in ~/Documents/mist-tools. To work there: cd ~/Documents/mist-tools && casper\n");
    expect(app.getLastTaskResult()?.verification?.status).toBe("pass");
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

function interactive(home: string, runtime: AgentRuntime) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  let pending: { test: (output: string) => boolean; resolve: () => void } | undefined;
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 110, rows: 30, write(text: string) {
    output += text;
    if (pending?.test(output)) { pending.resolve(); pending = undefined; }
  } });
  const until = (check: (output: string) => boolean) => {
    if (check(output)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    pending = { test: check, resolve };
    return promise;
  };
  const app = new CasperApp({ ...options(home, runtime), input, output: writer, verificationMode: "auto" });
  return { app, input, until, output: () => Bun.stripANSI(output) };
}

test.skipIf(!python)("after the receipt: 1 Stay here · 2 Switch there; Enter stays, 2 moves the next request there", async () => {
  const { root, home, docs, runtime, starts, disposed } = await lab();
  const harness = interactive(home, runtime);
  const running = harness.app.runInteractive(docs);
  try {
    await harness.until((text) => Bun.stripANSI(text).includes("idle"));
    harness.input.write("fix the sites count\r");
    await harness.until((text) => Bun.stripANSI(text).includes("The work is in ~/Documents/mist-tools."));
    expect(harness.output()).toContain("1 Stay here");
    expect(harness.output()).toContain("2 Switch there");
    harness.input.write("2");
    await harness.until((text) => Bun.stripANSI(text).includes("[folder] Working in ~/Documents/mist-tools"));
    await harness.until((text) => Bun.stripANSI(text).includes("Your next request starts a new conversation there"));
    expect(disposed()).toBe(1);
    await harness.until((text) => /\bidle\b/.test(Bun.stripANSI(text).split("Your next request")[1] ?? ""));
    harness.input.write("add a test\r");
    await harness.until((text) => /\bidle\b/.test(Bun.stripANSI(text).split("add a test")[1] ?? ""));
    expect(starts).toEqual([docs, path.join(docs, "mist-tools")]);
  } finally {
    harness.input.write("/exit\r");
    await running;
    await harness.app.close();
    harness.input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!python)("Enter at \"The work is in ...\" stays in the folder and keeps the conversation", async () => {
  const { root, home, docs, runtime, starts, disposed } = await lab();
  const harness = interactive(home, runtime);
  const running = harness.app.runInteractive(docs);
  try {
    await harness.until((text) => Bun.stripANSI(text).includes("idle"));
    harness.input.write("fix the sites count\r");
    await harness.until((text) => Bun.stripANSI(text).includes("The work is in ~/Documents/mist-tools."));
    harness.input.write("\r");
    await harness.until((text) => /\bidle\b/.test(Bun.stripANSI(text).split("The work is in").at(-1) ?? ""));
    expect(harness.output()).toContain("✓ Stay here");
    expect(harness.output()).not.toContain("[folder] Working in");
    expect(disposed()).toBe(0);
    expect(starts).toEqual([docs]);
  } finally {
    harness.input.write("/exit\r");
    await running;
    await harness.app.close();
    harness.input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
