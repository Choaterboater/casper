import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { findProjectCandidates, hasProjectSignals } from "../src/project/inspect";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types";
import { cleanEnv } from "./support/env";

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

test("findProjectCandidates also looks one level into common code folders under home", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-candidates-"));
  try {
    const expected: string[] = [];
    for (const [container, name, marker] of [["Projects", "app1", ".git"], ["code", "app2", ".git"], ["src", "app3", "package.json"],
      ["dev", "app4", "Cargo.toml"], ["repos", "app5", ".git"], ["workspace", "app6", "go.mod"]] as const) {
      const dir = path.join(home, container, name);
      await mkdir(dir, { recursive: true });
      if (marker === ".git") await mkdir(path.join(dir, marker)); else await writeFile(path.join(dir, marker), "");
      expected.push(dir);
    }
    await mkdir(path.join(home, "Documents", "docapp"), { recursive: true });
    await writeFile(path.join(home, "Documents", "docapp", "package.json"), "{}");
    await mkdir(path.join(home, "direct", ".git"), { recursive: true });
    // Only named code folders are opened; any other home subfolder is still checked just for itself.
    await mkdir(path.join(home, "Downloads", "unpacked", ".git"), { recursive: true });
    const candidates = await findProjectCandidates(home, { homeDir: home, limit: 20 });
    expect(candidates).toEqual([...expected, path.join(home, "Documents", "docapp"), path.join(home, "direct")].sort((a, b) => a.localeCompare(b)));
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
    // The detected project is first, so Enter opens it.
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
    await harness.app.close();
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
    // Enter while Casper is still starting keeps /exit as a draft; wait until it reads commands.
    await harness.until(text => Bun.stripANSI(text).includes("idle"));
  } finally {
    harness.input.write("/exit\r");
    await interactive;
    await harness.app.close();
    harness.input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("without a rich terminal the home-folder hint gives a command that actually works", async () => {
  // Real path: the launch folder is compared with HOME as given (macOS tmp is a symlink).
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-folder-plain-")));
  try {
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/cli.ts")], {
      cwd: home, env: cleanEnv({ HOME: home, CASPER_PROFILE: "default" }), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    // `casper <folder>` opens that folder: no cd, no restart.
    expect(stdout).toContain("[folder] Opened in your home folder. To work in a project: casper ~/Projects/myapp");
    expect(stdout).not.toContain("restart");
    expect(stdout).not.toContain("pass a path");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("launching from a folder of projects asks which one to open; a project or a git subfolder never asks", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-folder-repos-")));
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  await mkdir(home, { recursive: true });
  await mkdir(path.join(work, "repo-a", ".git"), { recursive: true });
  await mkdir(path.join(work, "repo-b"), { recursive: true });
  await writeFile(path.join(work, "repo-b", "requirements.txt"), "pytest\n");
  await mkdir(path.join(work, "notes"), { recursive: true });
  const harness = interactiveHarness(home, work);
  const interactive = harness.app.runInteractive(work);
  try {
    await harness.until(text => Bun.stripANSI(text).includes("This folder holds several projects. Work in which one?"));
    const visible = Bun.stripANSI(harness.output());
    expect(visible).toContain("3 .  stay in work");
    expect(visible).toContain("1 repo-a");
    expect(visible).toContain("2 repo-b");
    harness.input.write("2");
    await harness.until(text => /\bproject\s+repo-b\b/.test(Bun.stripANSI(text)));
    // The question's record keeps the choice.
    expect(Bun.stripANSI(harness.output())).toContain("✓ repo-b");
    await harness.until(text => Bun.stripANSI(text).includes("idle"));
  } finally {
    harness.input.write("/exit\r");
    await interactive;
    await harness.app.close();
    harness.input.destroy();
  }
  // A folder that is a project itself opens directly.
  await writeFile(path.join(work, "package.json"), "{}");
  const direct = interactiveHarness(home, work);
  const running = direct.app.runInteractive(work);
  try {
    await direct.until(text => Bun.stripANSI(text).includes("idle"));
    expect(Bun.stripANSI(direct.output())).not.toContain("several projects");
  } finally {
    direct.input.write("/exit\r");
    await running;
    await direct.app.close();
    direct.input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("a typed folder name that isn't there offers Stay first, then Make it here with the /new questions", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-folder-missing-")));
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  await mkdir(home, { recursive: true });
  await mkdir(path.join(work, "repo-a", ".git"), { recursive: true });
  await mkdir(path.join(work, "repo-b", ".git"), { recursive: true });
  const harness = interactiveHarness(home, work);
  const interactive = harness.app.runInteractive(work);
  try {
    await harness.until(text => Bun.stripANSI(text).includes("Work in which one?"));
    harness.input.write("sample-tools\r");
    await harness.until(text => Bun.stripANSI(text).includes("sample-tools isn't a folder in work. Make it?"));
    const visible = Bun.stripANSI(harness.output());
    expect(visible).toContain("1 Stay in work");
    expect(visible).toContain("2 Make sample-tools here");
    // Enter stays, and the message names the folder instead of ".".
    harness.input.write("\r");
    await harness.until(text => Bun.stripANSI(text).includes("[folder] Staying in work."));
    await harness.until(text => /\bproject\s+work\b/.test(Bun.stripANSI(text)));
    await harness.until(text => Bun.stripANSI(text).includes("idle"));
  } finally {
    harness.input.write("/exit\r");
    await interactive;
    await harness.app.close();
    harness.input.destroy();
  }
  // Choice 2 goes on to the /new questions, with the typed name, in this folder.
  const again = interactiveHarness(home, work);
  const running = again.app.runInteractive(work);
  try {
    await again.until(text => Bun.stripANSI(text).includes("Work in which one?"));
    again.input.write("sample-tools\r");
    await again.until(text => Bun.stripANSI(text).includes("Make it?"));
    again.input.write("2");
    await again.until(text => Bun.stripANSI(text).includes("What are you building?"));
    again.input.write("\x1b");
    await again.until(text => /\bproject\s+work\b/.test(Bun.stripANSI(text)));
    await again.until(text => Bun.stripANSI(text).includes("idle"));
  } finally {
    again.input.write("/exit\r");
    await running;
    await again.app.close();
    again.input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("/project <name> opens a project folder inside this one before the model starts, or offers to make it", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-project-cmd-")));
  const home = path.join(root, "home");
  const docs = path.join(home, "Documents");
  await mkdir(path.join(docs, "sample-tools", "tests"), { recursive: true });
  await writeFile(path.join(docs, "sample-tools", "pyproject.toml"), '[project]\nname = "sample-tools"\n');
  await writeFile(path.join(docs, "notes.md"), "notes\n");
  // Documents holds a project, so Casper asks at launch; Esc keeps Documents.
  const harness = interactiveHarness(home, docs);
  const interactive = harness.app.runInteractive(docs);
  try {
    await harness.until(text => Bun.stripANSI(text).includes("Work in which one?"));
    harness.input.write("\x1b");
    await harness.until(text => Bun.stripANSI(text).includes("idle"));
    // A name that isn't there: Stay first, and Enter stays.
    harness.input.write("/project netbox-sync\r");
    await harness.until(text => Bun.stripANSI(text).includes("netbox-sync isn't a folder in Documents. Make it?"));
    expect(Bun.stripANSI(harness.output())).toContain("1 Stay in Documents");
    harness.input.write("\r");
    await harness.until(text => Bun.stripANSI(text).includes("[folder] Staying in Documents."));
    // The project's name opens it.
    harness.input.write("/project sample-tools\r");
    await harness.until(text => Bun.stripANSI(text).includes("[folder] Working in ~/Documents/sample-tools"));
  } finally {
    harness.input.write("/exit\r");
    await interactive;
    await harness.app.close();
    harness.input.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("/project <name> once the conversation started says the command to use", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-project-late-")));
  const home = path.join(root, "home");
  const docs = path.join(home, "Documents");
  await mkdir(path.join(docs, "sample-tools"), { recursive: true });
  await writeFile(path.join(docs, "sample-tools", "pyproject.toml"), '[project]\nname = "sample-tools"\n');
  let output = "";
  const app = new CasperApp({ runtimeFactory: () => ({
    async start(): Promise<RuntimeSession> {
      return { getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }), getState: () => ({ cwd: docs, isStreaming: false }),
        subscribe: () => () => {}, abort: async () => {}, prompt: async () => {} };
    },
    async dispose() {},
  }), sessionHomeDir: home,
  loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
  loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
  output: { write(text: string) { output += text; } } });
  try {
    await app.start(docs);
    await app.ensureRuntime();
    await app.runOnce("/project sample-tools", docs);
    expect(output).toContain("[folder] This conversation stays in Documents. To work in sample-tools: cd ~/Documents/sample-tools && casper\n");
    await app.runOnce("/project nope", docs);
    expect(output).toContain("[folder] nope isn't a folder in Documents. To start it as a new project: casper new nope\n");
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
