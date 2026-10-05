import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { NewProjectOptions, NewProjectResult } from "../src/new/scaffold";
import { tildePath } from "../src/new/scaffold";
import { parseCliArgs } from "../src/cli-args";
import { terminalNewProject } from "../src/cli-main";
import { COMMANDS } from "../src/tui/commands";
import { FULL_HELP_TEXT, HELP_TEXT } from "../src/tui/help";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types";

setDefaultTimeout(20_000);
// The rich cases need the ask panel; this suite must not depend on the ambient TERM.
const ambientTerm = process.env.TERM;
const ambientNoColor = process.env.NO_COLOR;
process.env.TERM = "xterm-256color";
delete process.env.NO_COLOR;
afterAll(() => {
  if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm;
  if (ambientNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = ambientNoColor;
});

const REQUEST = "build a tool that lists Mist APs per site";
/** The footer says idle again after the last work: the app reads commands (an earlier "idle" doesn't count). */
const settled = (text: string) => text.lastIndexOf("idle") > Math.max(text.lastIndexOf("working"), text.lastIndexOf("waiting for you"));

interface Harness {
  app: CasperApp;
  input: PassThrough;
  until(test: (visible: string) => boolean): Promise<void>;
  visible(): string;
  /** Every createProject call, in order. */
  created: NewProjectOptions[];
  /** The cwd each runtime session started in. */
  starts: string[];
  prompts: string[];
  /** Model calls outside the conversation (the checklist). */
  completes: number;
}

/** A fake scaffold that makes the folder with a project marker, so Casper can open it. */
function fakeCreate(created: NewProjectOptions[], status: NewProjectResult["status"] = "ready") {
  return async (options: NewProjectOptions): Promise<NewProjectResult> => {
    created.push(options);
    const dir = path.join(options.parent, options.name);
    const home = options.homeDir!;
    if (status !== "not_created") {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "pyproject.toml"), `[project]\nname = "${options.name}"\n`);
    }
    options.onStep?.("  uv init …");
    return { status, exitCode: status === "ready" ? 0 : 1, dir, displayDir: tildePath(dir, home), name: options.name,
      template: { id: options.template, version: 1, kind: "Python project", title: "Python tool" }, checks: [], notes: [], kept: [],
      ...(status === "ready" ? { commit: "abc1234" } : { reason: status === "created" ? "tests failed." : "uv is missing." }) };
  };
}

/** rich: TTY in and out. plain: typed at a terminal that can't draw the panel. piped: lines from a pipe. */
type Surface = "rich" | "plain" | "piped";

function harness(home: string, options: { surface?: Surface; newProject?: { template?: string; name?: string }; status?: NewProjectResult["status"];
  conversation?: { continue: true } } = {}): Harness {
  const surface = options.surface ?? "rich";
  const rich = surface === "rich";
  // The request names Mist; these tests are about the build question, so the network server's setup was already
  // answered "Not now" (tests/mcp-network-setup.test.ts covers that question).
  mkdirSync(path.join(home, ".casper"), { recursive: true });
  writeFileSync(path.join(home, ".casper", "network-setup.json"), "{\"answer\":\"not-now\"}\n");
  const created: NewProjectOptions[] = [];
  const starts: string[] = [];
  const prompts: string[] = [];
  const state = { completes: 0 };
  const runtime: AgentRuntime = {
    async start(start): Promise<RuntimeSession> {
      starts.push(start.cwd);
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: start.cwd, isStreaming: false }),
        setTools: () => {},
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async (text) => { prompts.push(text); },
        complete: async () => { state.completes++; return { text: "1. It works", usage: null }; },
      } as RuntimeSession;
    },
    async dispose() {},
  };
  const input = surface === "piped" ? new PassThrough() : Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let output = "";
  let pending: { test: (visible: string) => boolean; resolve: () => void } | undefined;
  const visible = () => Bun.stripANSI(output);
  const writer = Object.assign(new EventEmitter(), { isTTY: rich, columns: 220, rows: 40, write(text: string) {
    output += text;
    if (pending?.test(visible())) { pending.resolve(); pending = undefined; }
    return true;
  } });
  const until = (test: (visible: string) => boolean) => {
    if (test(visible())) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    // A wait that never ends fails with the screen, so the failure says what was on it.
    const timer = setTimeout(() => reject(new Error(`Still waiting; the screen was:\n${visible().slice(-3000)}`)), 15_000);
    pending = { test, resolve: () => { clearTimeout(timer); resolve(); } };
    return promise;
  };
  const app = new CasperApp({
    input, output: writer, runtimeFactory: () => runtime, sessionHomeDir: home, autoVerify: false,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    createProject: fakeCreate(created, options.status),
    ...(options.newProject ? { newProject: options.newProject } : {}),
    ...(options.conversation ? { conversation: options.conversation } : {}),
  });
  return { app, input, until, visible, created, starts, prompts, get completes() { return state.completes; } };
}

/** A temp home with a work folder that is neither a project nor empty (so no startup question). */
async function setup(prefix: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(path.join(work, "notes.txt"), "ideas\n");
  return { root, home, work, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function finish(h: Harness, running: Promise<void>, rich = true) {
  h.input.write(rich ? "/exit\r" : "/exit\n");
  await running;
  await h.app.close();
  h.input.destroy();
}

test("a build request outside a project asks before the model starts; 2 builds it and the model starts in the new folder", async () => {
  const dirs = await setup("casper-new-ask-yes-");
  const h = harness(dirs.home);
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.includes("idle"));
    h.input.write(`${REQUEST}\r`);
    await h.until(text => text.includes("Build this as a new Mist Python project in ~/Projects/mist-aps?"));
    const shown = h.visible();
    expect(shown).toContain("1 Use this folder");
    expect(shown).toContain("2 Yes");
    expect(shown).toContain("3 Other kind");
    // Nothing reached a model before the answer.
    expect(h.starts).toEqual([]);
    expect(h.prompts).toEqual([]);
    h.input.write("2");
    await h.until(text => text.includes("[folder] Working in ~/Projects/mist-aps"));
    await h.until(() => h.prompts.length === 1);
    expect(h.created.map(({ parent, name, template }) => ({ parent, name, template })))
      .toEqual([{ parent: path.join(dirs.home, "Projects"), name: "mist-aps", template: "mist-python" }]);
    expect(h.starts).toEqual([path.join(dirs.home, "Projects", "mist-aps")]);
    expect(h.prompts[0]).toContain(REQUEST);
    // One question before work: the checklist panel (a model call) does not follow it.
    expect(h.completes).toBe(0);
    expect(h.visible()).toContain("Ready: ~/Projects/mist-aps");
    await h.until(settled);
  } finally { await finish(h, running); await dirs.cleanup(); }
});

test("Enter keeps this folder, and the question is not asked again in the session", async () => {
  const dirs = await setup("casper-new-ask-keep-");
  const h = harness(dirs.home);
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.includes("idle"));
    h.input.write(`${REQUEST}\r`);
    await h.until(text => text.includes("Build this as a new Mist Python project"));
    h.input.write("\r");
    await h.until(() => h.prompts.length === 1);
    expect(h.created).toEqual([]);
    expect(h.starts).toEqual([dirs.work]);
    expect(h.completes).toBe(0);
    await h.until(settled);
  } finally { await finish(h, running); await dirs.cleanup(); }
});

test("a typed name instead of a number builds the project under that name", async () => {
  const dirs = await setup("casper-new-ask-name-");
  const h = harness(dirs.home);
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.includes("idle"));
    h.input.write(`${REQUEST}\r`);
    await h.until(text => text.includes("Build this as a new Mist Python project"));
    h.input.write("ap-list\r");
    await h.until(text => text.includes("[folder] Working in ~/Projects/ap-list"));
    await h.until(() => h.prompts.length === 1);
    expect(h.created.map(entry => entry.name)).toEqual(["ap-list"]);
    expect(h.starts).toEqual([path.join(dirs.home, "Projects", "ap-list")]);
    await h.until(settled);
  } finally { await finish(h, running); await dirs.cleanup(); }
});

test("3 Other kind shows Use this folder, then the kinds, then the name question", async () => {
  const dirs = await setup("casper-new-ask-kind-");
  const h = harness(dirs.home);
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.includes("idle"));
    h.input.write(`${REQUEST}\r`);
    await h.until(text => text.includes("Build this as a new Mist Python project"));
    h.input.write("3");
    await h.until(text => text.includes("What are you building?"));
    expect(h.visible().slice(h.visible().lastIndexOf("What are you building?"))).toContain("1 Use this folder");
    h.input.write("6");
    await h.until(text => text.includes("Name it? (Enter for mist-aps)"));
    h.input.write("\r");
    await h.until(() => h.prompts.length === 1);
    expect(h.created.map(({ name, template }) => ({ name, template }))).toEqual([{ name: "mist-aps", template: "python-cli" }]);
    await h.until(settled);
  } finally { await finish(h, running); await dirs.cleanup(); }
});

test("no question inside a project, and none once the model has started", async () => {
  const dirs = await setup("casper-new-ask-none-");
  await writeFile(path.join(dirs.work, "package.json"), "{}");
  const h = harness(dirs.home);
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.includes("idle"));
    h.input.write(`${REQUEST}\r`);
    // Without the new-project question the checklist is made as usual, quietly, and the task starts.
    await h.until(() => h.prompts.length === 1);
    expect(h.completes).toBe(1);
    expect(h.prompts[0]).toContain("- It works");
    expect(h.visible()).not.toContain("Build this as a new");
    expect(h.created).toEqual([]);
    await h.until(settled);
  } finally { await finish(h, running); await dirs.cleanup(); }

  const outside = await setup("casper-new-ask-started-");
  const started = harness(outside.home);
  const again = started.app.runInteractive(outside.work);
  try {
    await started.until(text => text.includes("idle"));
    started.input.write("hello there\r");
    await started.until(() => started.prompts.length === 1);
    await started.until(settled);
    started.input.write(`${REQUEST}\r`);
    await started.until(() => started.prompts.length === 2);
    expect(started.visible()).not.toContain("Build this as a new");
    expect(started.created).toEqual([]);
    await started.until(settled);
  } finally { await finish(started, again); await outside.cleanup(); }
});

test("a one-shot run can't ask: it keeps the folder, says so, and names the command", async () => {
  const dirs = await setup("casper-new-oneshot-");
  const h = harness(dirs.home, { surface: "piped" });
  try {
    await h.app.runOnce(REQUEST, dirs.work);
    expect(h.visible()).toContain("[new] This reads like a new project. Casper can't ask here, so it works in this folder. To start a project instead: casper new mist-python mist-aps");
    expect(h.visible()).not.toContain("Build this as a new");
    expect(h.created).toEqual([]);
    expect(h.starts).toEqual([dirs.work]);
  } finally { await h.app.close(); h.input.destroy(); await dirs.cleanup(); }
});

test("the plain terminal answers the same question with a typed number", async () => {
  const dirs = await setup("casper-new-plain-");
  const h = harness(dirs.home, { surface: "plain" });
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.includes("> "));
    h.input.write(`${REQUEST}\n`);
    await h.until(text => text.includes("Type 1, 2 or 3: "));
    expect(h.visible()).toContain("Build this as a new Mist Python project in ~/Projects/mist-aps?\n  1 Use this folder\n  2 Yes\n  3 Other kind\n");
    expect(h.starts).toEqual([]);
    h.input.write("2\n");
    await h.until(() => h.prompts.length === 1);
    expect(h.starts).toEqual([path.join(dirs.home, "Projects", "mist-aps")]);
    expect(h.visible()).toContain("[folder] Working in ~/Projects/mist-aps");
    await h.until(text => text.endsWith("> "));
  } finally { await finish(h, running, false); await dirs.cleanup(); }
});

test("piped input can't answer: the session keeps the folder and names the command", async () => {
  const dirs = await setup("casper-new-piped-");
  const h = harness(dirs.home, { surface: "piped" });
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.endsWith("> "));
    h.input.write(`${REQUEST}\n`);
    await h.until(() => h.prompts.length === 1);
    expect(h.visible()).toContain("[new] This reads like a new project. Casper can't ask here, so it works in this folder. To start a project instead: casper new mist-python mist-aps");
    expect(h.visible()).not.toContain("Build this as a new");
    expect(h.starts).toEqual([dirs.work]);
    await h.until(text => text.endsWith("> "));
  } finally { await finish(h, running, false); await dirs.cleanup(); }

  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-new-empty-piped-")));
  const empty = path.join(root, "demo");
  await mkdir(path.join(root, "home"), { recursive: true });
  await mkdir(empty);
  const piped = harness(path.join(root, "home"), { surface: "piped" });
  const again = piped.app.runInteractive(empty);
  try {
    await piped.until(text => text.endsWith("> "));
    expect(piped.visible()).toContain("[folder] This folder is empty. To start a new project in ~/Projects: casper new");
    expect(piped.visible()).not.toContain("Start a new project here?");
  } finally { await finish(piped, again, false); await rm(root, { recursive: true, force: true }); }
});

test("a project that can't be built sends nothing to the model", async () => {
  const dirs = await setup("casper-new-fail-");
  const h = harness(dirs.home, { status: "not_created" });
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.includes("idle"));
    h.input.write(`${REQUEST}\r`);
    await h.until(text => text.includes("Build this as a new Mist Python project"));
    h.input.write("2");
    await h.until(text => text.includes("Nothing was sent to the model."));
    expect(h.visible()).toContain("Not created: uv is missing.");
    expect(h.starts).toEqual([]);
    expect(h.prompts).toEqual([]);
  } finally { await finish(h, running); await dirs.cleanup(); }
});

test("starting in an empty folder offers a new project there, named after the folder", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-new-empty-")));
  const home = path.join(root, "home");
  const empty = path.join(root, "demo-app");
  await mkdir(home, { recursive: true });
  await mkdir(empty);
  const h = harness(home);
  const running = h.app.runInteractive(empty);
  try {
    await h.until(text => text.includes("This folder is empty. Start a new project here?"));
    expect(h.visible()).toContain("1 Not now");
    expect(h.visible()).not.toContain("My own");
    h.input.write("5");
    await h.until(text => text.includes("idle"));
    expect(h.created.map(({ parent, name, template }) => ({ parent, name, template }))).toEqual([{ parent: root, name: "demo-app", template: "python-cli" }]);
    expect(h.visible()).toMatch(/\bproject\s+demo-app\b/);
  } finally { await finish(h, running); await rm(root, { recursive: true, force: true }); }
});

test("in an empty folder, Enter (1 Not now) on the plain terminal builds nothing", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-new-empty-plain-")));
  const home = path.join(root, "home");
  const empty = path.join(root, "scratch");
  await mkdir(home, { recursive: true });
  await mkdir(empty);
  const h = harness(home, { surface: "plain" });
  const running = h.app.runInteractive(empty);
  try {
    await h.until(text => text.includes("This folder is empty. Start a new project here?"));
    await h.until(text => /Type 1(, \d)* or \d: /.test(text));
    expect(h.visible()).toContain("  1 Not now · just work in this folder\n");
    h.input.write("\n");
    await h.until(text => text.endsWith("> "));
    expect(h.created).toEqual([]);
    // Not now already answered it: a build request goes straight to work in this folder.
    h.input.write(`${REQUEST}\n`);
    await h.until(() => h.prompts.length === 1);
    expect(h.visible()).not.toContain("Build this as a new");
    expect(h.starts).toEqual([empty]);
    await h.until(text => text.endsWith("> "));
  } finally { await finish(h, running, false); await rm(root, { recursive: true, force: true }); }
});

test("the home-folder question ends with New project, which asks the kind and the name", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-new-home-")));
  const home = path.join(root, "home");
  await mkdir(path.join(home, "Documents", "MyApp"), { recursive: true });
  await writeFile(path.join(home, "Documents", "MyApp", "package.json"), "{}");
  const h = harness(home);
  const running = h.app.runInteractive(home);
  try {
    await h.until(text => text.includes("Work in which project?"));
    expect(h.visible()).toContain("3 New project");
    h.input.write("3");
    await h.until(text => text.includes("What are you building?"));
    h.input.write("3");
    await h.until(text => text.includes("Name it? (Enter for "));
    h.input.write("site-mcp\r");
    await h.until(text => text.includes("idle"));
    expect(h.created.map(({ parent, name, template }) => ({ parent, name, template })))
      .toEqual([{ parent: path.join(home, "Projects"), name: "site-mcp", template: "network-mcp" }]);
    expect(h.visible()).toMatch(/\bproject\s+site-mcp\b/);
  } finally { await finish(h, running); await rm(root, { recursive: true, force: true }); }
});

test("casper new at a terminal builds the project and opens Casper there; Esc builds nothing and exits 1", async () => {
  const dirs = await setup("casper-new-cli-");
  const h = harness(dirs.home, { newProject: { template: "python-cli", name: "ping-tool" } });
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.includes("idle"));
    expect(h.visible()).not.toContain("What are you building?");
    expect(h.created.map(({ parent, name }) => ({ parent, name }))).toEqual([{ parent: path.join(dirs.home, "Projects"), name: "ping-tool" }]);
    expect(h.visible()).toMatch(/\bproject\s+ping-tool\b/);
    expect(h.app.newProjectExitCode).toBeUndefined();
  } finally { await finish(h, running); }

  const esc = harness(dirs.home, { newProject: {} });
  const escRunning = esc.app.runInteractive(dirs.work);
  try {
    await esc.until(text => text.includes("What are you building?"));
    esc.input.write("\x1b");
    await escRunning;
    expect(esc.visible()).toContain("Nothing was created.");
    expect(esc.app.newProjectExitCode).toBe(1);
    expect(esc.starts).toEqual([]);
  } finally { await esc.app.close(); esc.input.destroy(); await dirs.cleanup(); }
});

test("/new lists the templates, and once the model has started it builds but keeps this conversation's folder", async () => {
  const dirs = await setup("casper-new-slash-");
  const h = harness(dirs.home);
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.includes("idle"));
    h.input.write("/new --list\r");
    await h.until(text => text.includes("python-cli ") && settled(text));
    h.input.write("hello there\r");
    await h.until(() => h.prompts.length === 1);
    await h.until(settled);
    h.input.write("/new python-cli ping-tool\r");
    await h.until(text => text.includes("To work in it, run: casper ~/Projects/ping-tool"));
    expect(h.visible()).toContain(`[folder] This conversation stays in ${dirs.work}.`);
    expect(h.created.map(entry => entry.name)).toEqual(["ping-tool"]);
    expect(h.starts).toEqual([dirs.work]);
    await h.until(settled);
  } finally { await finish(h, running); await dirs.cleanup(); }
});

test("/new after the model started never drops a typed request silently: it says it didn't run and how to run it", async () => {
  const dirs = await setup("casper-new-slash-typed-");
  const h = harness(dirs.home);
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.includes("idle"));
    h.input.write("hello there\r");
    await h.until(() => h.prompts.length === 1);
    await h.until(settled);
    h.input.write("/new\r");
    await h.until(text => text.includes("What are you building?"));
    h.input.write("a nightly backup of my switch configs\r");
    await h.until(text => text.includes("Name it? (Enter for "));
    h.input.write("\r");
    await h.until(text => text.includes("To work in it, run: casper ~/Projects/"));
    await h.until(text => text.includes("[new] Your request didn't run here."));
    expect(h.visible()).toMatch(/\[new\] Your request didn't run here\. Run casper ~\/Projects\/[a-z0-9-]+ and type it there\./);
    expect(h.prompts.length).toBe(1);
    await h.until(settled);
  } finally { await finish(h, running); await dirs.cleanup(); }
});

test("/new before the model starts opens the new project as the workspace", async () => {
  const dirs = await setup("casper-new-slash-open-");
  const h = harness(dirs.home);
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.includes("idle"));
    h.input.write("/new mist-python aps\r");
    await h.until(text => text.includes("[folder] Working in ~/Projects/aps"));
    await h.until(settled);
    h.input.write("hello there\r");
    await h.until(() => h.prompts.length === 1);
    expect(h.starts).toEqual([path.join(dirs.home, "Projects", "aps")]);
    await h.until(settled);
  } finally { await finish(h, running); await dirs.cleanup(); }
});

test("casper new opens the app only for a person at a terminal; --list and scripts stay standalone", () => {
  expect(terminalNewProject(parseCliArgs(["new"]), true)).toEqual({ list: false });
  expect(terminalNewProject(parseCliArgs(["new", "python-cli", "demo"]), true)).toEqual({ template: "python-cli", name: "demo", list: false });
  expect(terminalNewProject(parseCliArgs(["new", "--list"]), true)).toBeUndefined();
  expect(terminalNewProject(parseCliArgs(["new"]), false)).toBeUndefined();
  expect(terminalNewProject(parseCliArgs(["build", "a", "tool"]), true)).toBeUndefined();
});

test("/new is in the command palette and the full help; casper new is in the short help", () => {
  expect(COMMANDS.find(command => command.name === "new")?.description).toBe("Start a new project in ~/Projects (no model)");
  expect(HELP_TEXT).toContain("casper new [name]");
  expect(FULL_HELP_TEXT).toContain("/new [name]                       Start a new project in ~/Projects (no model)");
  expect(FULL_HELP_TEXT).toContain("/new <template> <name>");
  expect(FULL_HELP_TEXT).toContain("casper new [kind] [name]");
});

test("typed no or yes answers the build question and is never a project name", async () => {
  const dirs = await setup("casper-new-ask-typed-no-");
  const h = harness(dirs.home);
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.includes("idle"));
    h.input.write(`${REQUEST}\r`);
    await h.until(text => text.includes("Build this as a new Mist Python project"));
    h.input.write("no\r");
    await h.until(() => h.prompts.length === 1);
    expect(h.created).toEqual([]);
    expect(h.starts).toEqual([dirs.work]);
    await h.until(settled);
  } finally { await finish(h, running); await dirs.cleanup(); }

  const again = await setup("casper-new-ask-typed-yes-");
  const yes = harness(again.home, { surface: "plain" });
  const yesRunning = yes.app.runInteractive(again.work);
  try {
    await yes.until(text => text.includes("> "));
    yes.input.write(`${REQUEST}\n`);
    await yes.until(text => text.includes("Type 1, 2 or 3: "));
    yes.input.write("y\n");
    await yes.until(() => yes.prompts.length === 1);
    expect(yes.created.map(entry => entry.name)).toEqual(["mist-aps"]);
    await yes.until(text => text.endsWith("> "));
  } finally { await finish(yes, yesRunning, false); await again.cleanup(); }
});

test("a number that isn't a choice asks again instead of becoming a name", async () => {
  const dirs = await setup("casper-new-ask-range-");
  const h = harness(dirs.home, { surface: "plain" });
  const running = h.app.runInteractive(dirs.work);
  try {
    await h.until(text => text.includes("> "));
    h.input.write(`${REQUEST}\n`);
    await h.until(text => text.includes("Type 1, 2 or 3: "));
    h.input.write("4\n");
    await h.until(text => text.includes("[new] Pick a number from 1 to 3.") && text.endsWith("Type 1, 2 or 3: "));
    expect(h.visible()).not.toContain("Names use lowercase");
    h.input.write("1\n");
    await h.until(() => h.prompts.length === 1);
    expect(h.created).toEqual([]);
    expect(h.starts).toEqual([dirs.work]);
    await h.until(text => text.endsWith("> "));
  } finally { await finish(h, running, false); await dirs.cleanup(); }
});

test("casper --continue in an empty folder resumes there without the new-project question", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-new-empty-continue-")));
  const home = path.join(root, "home");
  const empty = path.join(root, "demo");
  await mkdir(home, { recursive: true });
  await mkdir(empty);
  const h = harness(home, { conversation: { continue: true } });
  const running = h.app.runInteractive(empty);
  try {
    await h.until(text => text.includes("idle"));
    expect(h.visible()).not.toContain("Start a new project here?");
    expect(h.visible()).toMatch(/\bproject\s+demo\b/);
  } finally { await finish(h, running); await rm(root, { recursive: true, force: true }); }
});
