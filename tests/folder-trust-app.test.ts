import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { projectStateDirectory } from "../src/project/model";
import { folderTrust, folderTrustDefaults } from "../src/project/trust";
import type { AgentRuntime } from "../src/runtime/types";
import { routineCommand } from "../src/sandbox/routine";
import { SkillRegistry } from "../src/skills/registry";
import { formatReceipt, type TaskResult } from "../src/task/result";
import { trustRequest } from "../src/app/trust-words";
import { folderTrustText } from "../src/app/commands";
import { richApp, type RichAppSetup } from "./support/app";
import { removeTempDir } from "./support/temp-dir";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
// The suite trusts every folder (tests/support/preload.ts); these tests read the saved answers, as Casper does.
const suiteLookup = folderTrustDefaults.lookup;
beforeAll(() => { folderTrustDefaults.lookup = folderTrust; });
afterAll(() => {
  folderTrustDefaults.lookup = suiteLookup;
  if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm;
});

const PACKAGE = JSON.stringify({ name: "cloned", scripts: { test: "bun test" } });

function fakeRuntime(working?: Promise<void>) {
  const prompts: string[] = [];
  const started = Promise.withResolvers<void>();
  const runtime: AgentRuntime = {
    async start() {
      return {
        setTools: () => {},
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: "", isStreaming: working !== undefined }),
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async (text: string) => { prompts.push(text); started.resolve(); await working; },
      };
    },
    async dispose() {},
  };
  return { runtime, prompts, started: started.promise };
}

const trustSaved = async (root: string, home: string) => Bun.file(path.join(projectStateDirectory(root, home), "trust.json")).exists();

async function opened(setup: RichAppSetup, working?: Promise<void>) {
  const fake = fakeRuntime(working);
  const app = await richApp(() => fake.runtime, {}, setup);
  return { app, fake };
}

test("a folder Casper hasn't seen asks once, naming what would run; Not now runs no checks and saves nothing", async () => {
  const { app } = await opened({ trusted: false, files: { "package.json": PACKAGE } });
  try {
    await app.until((text) => text.includes("Trust ") && text.includes("It would run:"));
    expect(app.screen()).toMatch(/It would run: [^\n]*bun[^\n]*test/);
    app.input.write("1");
    await app.until((text) => text.includes("[trust] Not trusted: you can read and edit here"));
    await app.until((text) => text.includes("idle"));
    expect(app.screen()).toContain("off: this folder isn't trusted; say \"trust this folder\" to run its checks");
    expect(await trustSaved(app.project, app.home)).toBe(false);
    app.input.write("/verify\r");
    await app.until((text) => text.includes("[verify] Not run: this folder isn't trusted"));
  } finally { await app.close(); }
}, 30_000);

test("Trust this folder saves it; the plain words take it back and trust it again, with no model call", async () => {
  const { app, fake } = await opened({ trusted: false, files: { "package.json": PACKAGE } });
  try {
    await app.until((text) => text.includes("It would run:"));
    app.input.write("2");
    await app.until((text) => text.includes("[trust] Trusted"));
    expect(await trustSaved(app.project, app.home)).toBe(true);
    await app.until((text) => text.includes("idle"));
    app.input.write("stop trusting this folder\r");
    await app.until((text) => text.includes("[trust] Handled here, no model call: /trust off does the same."));
    await app.until((text) => text.includes("[trust] Not trusted:"));
    expect(await trustSaved(app.project, app.home)).toBe(false);
    app.input.write("trust this folder\r");
    await app.until((text) => text.includes("[trust] Handled here, no model call: /trust does the same."));
    await app.until((text) => text.split("[trust] Trusted").length === 3);
    expect(await trustSaved(app.project, app.home)).toBe(true);
    expect(fake.prompts).toEqual([]);
  } finally { await app.close(); }
}, 30_000);

test("a folder you trusted opens with no question", async () => {
  const { app } = await opened({ files: { "package.json": PACKAGE } });
  try {
    await app.until((text) => text.includes("idle"));
    expect(app.screen()).not.toContain("It would run:");
    expect(app.screen()).not.toContain("isn't trusted");
  } finally { await app.close(); }
}, 30_000);

test("a repository inside a trusted folder is its own project: it asks for itself", async () => {
  const { app } = await opened({ trusted: false, trustParent: true, git: true, files: { "package.json": PACKAGE } });
  try {
    await app.until((text) => text.includes("It would run:"));
    app.input.write("1");
    await app.until((text) => text.includes("[trust] Not trusted:"));
  } finally { await app.close(); }
}, 30_000);

test("a plain folder inside a trusted folder is covered by it", async () => {
  const { app } = await opened({ trusted: false, trustParent: true, files: { "package.json": PACKAGE } });
  try {
    await app.until((text) => text.includes("idle"));
    expect(app.screen()).not.toContain("It would run:");
  } finally { await app.close(); }
}, 30_000);

test("the home folder is never asked about and never trusted: no checks, and words can't trust it", async () => {
  const { app } = await opened({ trusted: false, openHome: true });
  try {
    await app.until((text) => text.includes("idle"));
    expect(app.screen()).not.toContain("It would run:");
    expect(app.screen()).not.toMatch(/Trust ~\?/);
    app.input.write("/verify\r");
    await app.until((text) => text.includes("[verify] Not run: Casper never trusts your home folder"));
    app.input.write("trust this folder\r");
    await app.until((text) => text.includes("[trust] Casper never trusts your home folder"));
    expect(await trustSaved(app.home, app.home)).toBe(false);
  } finally { await app.close(); }
}, 30_000);

test("during a task, \"trust this folder\" is done now and never sent to the AI", async () => {
  const gate = Promise.withResolvers<void>();
  const { app, fake } = await opened({ trusted: false, files: { "package.json": PACKAGE } }, gate.promise);
  try {
    await app.until((text) => text.includes("It would run:"));
    app.input.write("1");
    await app.until((text) => text.includes("idle"));
    app.input.write("write a poem\r");
    await fake.started;
    app.input.write("trust this folder\r");
    await app.until((text) => text.includes("[trust] Trusted"));
    expect(fake.prompts).toHaveLength(1);
    expect(app.app.queuedLines).toEqual([]);
    expect(app.screen()).not.toMatch(/sent to Casper|queued · runs when/);
    gate.resolve();
  } finally { gate.resolve(); await app.close(); }
}, 30_000);

test("a run that can't ask is trusted, as Claude Code's -p is: no question, nothing saved", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-trust-oneshot-")));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(project);
  await Bun.write(path.join(project, "package.json"), PACKAGE);
  let text = "";
  const app = new CasperApp({ runtimeFactory: () => fakeRuntime().runtime, sessionHomeDir: home, output: { write: (chunk) => { text += chunk; } },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  try {
    await app.start(project);
    expect(app.folderTrust).toEqual({ trusted: true, from: project });
    expect(text).not.toContain("It would run:");
    expect(await trustSaved(project, home)).toBe(false);
  } finally { await app.close(); await removeTempDir(root); }
});

test("in a folder you haven't trusted, the project's installs, builds, tests and scripts ask; git, reads and file work don't", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-trust-routine-")));
  try {
    await Bun.write(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite", test: "bun test" } }));
    for (const command of ["npm test", "npm ci", "bun install", "make", "npm run dev", "cargo test", "pytest"]) {
      expect([command, routineCommand(command, root)]).toEqual([command, true]);
      expect([command, routineCommand(command, root, { projectCommands: false })]).toEqual([command, false]);
    }
    for (const command of ["git status", "git add a.txt", "git commit -m x", "mkdir build", "mv a.txt b.txt"]) {
      expect([command, routineCommand(command, root, { projectCommands: false })]).toEqual([command, true]);
    }
    // One untrusted project command on a line makes the line ask.
    expect(routineCommand("git add a.txt && npm test", root, { projectCommands: false })).toBe(false);
  } finally { await removeTempDir(root); }
});

test("the receipt and /permissions say why nothing was checked, and how to change it", () => {
  const task = { execution: "completed", changedPaths: ["a.ts"], verificationMode: "off", untrustedFolder: "new" } as unknown as TaskResult;
  expect(formatReceipt(task)).toContain("Not verified — this folder isn't trusted; say \"trust this folder\" to run its checks.");
  const home = { ...task, untrustedFolder: "home" } as TaskResult;
  expect(formatReceipt(home)).toContain("Not verified — Casper never trusts your home folder; open a project folder to run its checks.");
  expect(folderTrustText({ trusted: false, why: "new" })).toContain("This folder isn't trusted: its checks, services and smoke checks don't run");
  expect(folderTrustText({ trusted: true, from: "/x" })).toContain("This folder is trusted");
});

test("the plain words for trusting this folder, and words that aren't", () => {
  for (const line of ["trust this folder", "Trust this folder.", "I trust this repo", "please trust the project", "mark this folder as trusted"]) {
    expect([line, trustRequest(line)]).toEqual([line, "on"]);
  }
  for (const line of ["stop trusting this folder", "untrust this project", "don't trust this folder", "do not trust this repo"]) {
    expect([line, trustRequest(line)]).toEqual([line, "off"]);
  }
  for (const line of ["trust", "trust the user's input in this folder", "do you trust this repo?", "trust this folder and run the tests", "trust this function",
    "why should I trust this folder"]) expect([line, trustRequest(line)]).toEqual([line, undefined]);
  expect(trustRequest("trust this folder", ["pasted"])).toBeUndefined();
});

test("a repository's own skills are used only once you trust the folder; /skills trust points to the folder", async () => {
  const skill = "---\nname: repo-rules\ndescription: How this repository names things\n---\nREPO_RULES_BODY\n";
  const { app } = await opened({ trusted: false, files: { "package.json": PACKAGE, ".claude/skills/repo-rules/SKILL.md": skill } });
  try {
    await app.until((text) => text.includes("It would run:"));
    app.input.write("1");
    await app.until((text) => text.includes("idle"));
    const repo = () => app.app.skillRegistry!.list().find((item) => item.name === "repo-rules")!;
    expect(repo()).toMatchObject({ source: "project", trust: "untrusted" });
    app.input.write("/skills\r");
    await app.until((text) => text.includes("not used until you trust this folder"));
    app.input.write(`/skills trust ${repo().id}\r`);
    await app.until((text) => text.includes("is this folder's own skill: it is used while you trust the folder"));
    app.input.write("trust this folder\r");
    await app.until((text) => text.includes("[trust] Trusted"));
    expect(repo()).toMatchObject({ trust: "trusted" });
  } finally { await app.close(); }
}, 30_000);
