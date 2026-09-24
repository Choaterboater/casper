import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { findProjectCandidates, hasProjectSignals } from "../src/project/inspect";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types";

setDefaultTimeout(15_000);
// The ask flow renders only on a rich terminal; this suite must not depend on the ambient TERM.
const ambientTerm = process.env.TERM;
const ambientNoColor = process.env.NO_COLOR;
process.env.TERM = "xterm-256color";
delete process.env.NO_COLOR;

function restoreEnv() {
  if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm;
  if (ambientNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = ambientNoColor;
}

afterAll(restoreEnv);

test("hasProjectSignals detects git and project markers, false for empty dirs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-signals-"));
  try {
    const withPackage = path.join(root, "pkg");
    const withGit = path.join(root, "git");
    const empty = path.join(root, "empty");
    await mkdir(withPackage);
    await mkdir(withGit);
    await mkdir(empty);
    await writeFile(path.join(withPackage, "package.json"), "{}");
    await mkdir(path.join(withGit, ".git"));
    expect(await hasProjectSignals(withPackage)).toBe(true);
    expect(await hasProjectSignals(withGit)).toBe(true);
    expect(await hasProjectSignals(empty)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("findProjectCandidates finds marked dirs two levels down and skips heavy dirs", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-candidates-"));
  try {
    const app = path.join(home, "Documents", "MyApp");
    const skipped = path.join(home, "Documents", "node_modules", "hidden-pkg");
    await mkdir(app, { recursive: true });
    await mkdir(skipped, { recursive: true });
    await mkdir(path.join(home, "Documents", ".hidden-project"));
    await writeFile(path.join(app, "package.json"), "{}");
    await writeFile(path.join(skipped, "package.json"), "{}");
    const candidates = await findProjectCandidates(home, { homeDir: home });
    expect(candidates).toContain(app);
    expect(candidates).not.toContain(skipped);
    expect(candidates.some(dir => dir.includes(".hidden-project"))).toBe(false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

function interactiveHarness(home: string, project: string) {
  const runtime: AgentRuntime = {
    async start(): Promise<RuntimeSession> {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async () => {},
      };
    },
    async dispose() {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  let pending: { test: (output: string) => boolean; resolve: () => void } | undefined;
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 110, rows: 30, write(text: string) {
    output += text;
    if (pending?.test(output)) { pending.resolve(); pending = undefined; }
  } });
  const until = (test: (output: string) => boolean) => {
    if (test(output)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    pending = { test, resolve };
    return promise;
  };
  const app = new CasperApp({
    input, output: writer, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  return { app, input, until, output: () => output };
}

test("launching from the home folder asks which project to open and opens the choice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-folder-ask-"));
  const home = path.join(root, "home");
  const project = path.join(home, "Documents", "MyApp");
  await mkdir(path.join(home, "Documents"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "package.json"), "{}");
  const harness = interactiveHarness(home, project);
  const interactive = harness.app.runInteractive(home);
  try {
    await harness.until(text => Bun.stripANSI(text).includes("Work in which project?"));
    // Arrow down to the detected candidate and confirm it.
    harness.input.write("\x1b[B");
    harness.input.write("\r");
    await harness.until(text => /\bproject\s+MyApp\b/.test(Bun.stripANSI(text)));
    await harness.until(text => Bun.stripANSI(text).includes("idle"));
  } finally {
    harness.input.write("/exit\r");
    await interactive;
    await harness.app.close();
    harness.input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("escaping the folder question keeps the home folder as the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-folder-skip-"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const harness = interactiveHarness(home, home);
  const interactive = harness.app.runInteractive(home);
  try {
    await harness.until(text => Bun.stripANSI(text).includes("Work in which project?"));
    harness.input.write("\x1b");
    await harness.until(text => new RegExp(`\\bproject\\s+${path.basename(home)}\\b`).test(Bun.stripANSI(text)));
    await harness.until(text => Bun.stripANSI(text).includes("idle"));
  } finally {
    harness.input.write("/exit\r");
    await interactive;
    harness.input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("folder selection rejects sibling paths that only share the home prefix", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-folder-outside-"));
  const home = path.join(root, "home");
  const sibling = path.join(root, "home-other");
  await mkdir(home, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(path.join(sibling, "package.json"), "{}");
  const harness = interactiveHarness(home, home);
  const interactive = harness.app.runInteractive(home);
  try {
    await harness.until(text => Bun.stripANSI(text).includes("Work in which project?"));
    harness.input.write("../home-other\r");
    await harness.until(text => Bun.stripANSI(text).includes("../home-other is outside your home directory"));
    await harness.until(text => new RegExp(`\\bproject\\s+${path.basename(home)}\\b`).test(Bun.stripANSI(text)));
  } finally {
    harness.input.write("/exit\r");
    await interactive;
    harness.input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
