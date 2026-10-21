import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { DEFAULT_SYSTEM_PROMPT_APPEND, LEAN_SYSTEM_PROMPT_APPEND } from "../src/app/prompt";
import { browserDefaults } from "../src/browser/discovery";
import { findLookCommand, findLookPage, formatLookPrompt, LOOK_COMMANDS, lookList, lookRequest, MAX_LOOK_BODY_BYTES, parseLookArgs, type LookPage } from "../src/look/commands";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeSession, RuntimeStartOptions } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { classifyTask } from "../src/task/classify";
import { canonicalLine, findCommand } from "../src/tui/commands";
import { commandProblem, FULL_HELP_TEXT } from "../src/tui/help";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function folder(name: string): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), `casper-look-${name}-`));
  cleanup.push(() => removeTempDir(base));
  return base;
}

const NAMES = ["critique", "audit", "guidelines", "polish", "layout", "type", "colour", "quieter", "adapt", "harden", "clarify"];
const REPORTS = ["critique", "audit", "guidelines"];
const URL_PAGE: LookPage = { kind: "url", url: "http://127.0.0.1:5173/" };
/** Each command's file starts with its own heading. */
const heading = (name: string) => `# ${name[0]!.toUpperCase()}${name.slice(1)}\n`;

test("the eleven commands, each with a small file of its own that credits its source and says it was changed", () => {
  expect(LOOK_COMMANDS.map(({ name }) => name)).toEqual(NAMES);
  expect(LOOK_COMMANDS.filter(({ fixes }) => !fixes).map(({ name }) => name)).toEqual(REPORTS);
  for (const command of LOOK_COMMANDS) {
    expect({ name: command.name, small: Buffer.byteLength(command.body) <= MAX_LOOK_BODY_BYTES }).toEqual({ name: command.name, small: true });
    expect(command.body.startsWith(heading(command.name))).toBe(true);
    if (command.name === "guidelines") {
      expect(command.body).toContain("Adapted and trimmed from vercel-labs/web-interface-guidelines command.md (MIT, Copyright (c)\n2025 Vercel Labs). Changed: shortened and rewritten for Casper.");
    } else {
      expect(command.body).toContain("Adapted and trimmed from pbakaus/impeccable reference/");
      expect(command.body).toContain("(Apache-2.0, Copyright 2025\nPaul Bakaus). Changed: shortened and rewritten for Casper.");
    }
    // Report commands change nothing; fixing ones end by looking again.
    if (command.fixes) expect(command.body).toMatch(/[Rr]eplay[^\n]*(\n[^\n]*)?screenshot/);
    else expect(command.body).toContain("Report only: change no files.");
  }
  const body = (name: string) => findLookCommand(name)!.body;
  for (const line of ["390 wide and at 1280 wide", "Nielsen's 10 heuristics 0 to 4", "P0 to P3", "3 questions"]) expect(body("critique")).toContain(line);
  for (const line of ["`diagnostics`", "`inspect`", "`no-horizontal-overflow`", "`no-overlap` of the header and the main content",
    "Accessibility", "Performance", "Theming", "Responsive", "Integrity", "out of 20"]) expect(body("audit")).toContain(line);
  for (const line of ["390 and at 1280 wide", "`diagnostics`", "`no-horizontal-overflow`", "`no-overlap`", "44 by 44px", "Interaction", "Forms",
    "`prefers-reduced-motion`", "`env(safe-area-inset-*)`", "Content", "Performance", "Theming", "URL state", "rule, where (file:line or selector),\n   fix"]) expect(body("guidelines")).toContain(line);
  expect(body("polish").indexOf("broken")).toBeLessThan(body("polish").indexOf("missing states"));
  expect(body("polish").indexOf("missing states")).toBeLessThan(body("polish").indexOf("hierarchy and responsive"));
  expect(body("polish").indexOf("hierarchy and responsive")).toBeLessThan(body("polish").indexOf("visual:"));
  expect(body("polish").indexOf("visual:")).toBeLessThan(body("polish").indexOf("cleanup:"));
  for (const name of ["colour", "quieter"]) expect(body(name)).toContain("Theme tokens only");
  expect(body("colour")).toContain("for light and for dark");
  for (const line of ["390, 768 and 1280 wide", "44 by 44px", "`no-overlap`"]) expect(body("adapt")).toContain(line);
  for (const line of ["200-character string", "empty", "loading", "error", "record a check"]) expect(body("harden")).toContain(line);
  expect(body("clarify")).toContain("Wording only");
});

test("parsing: a command, a page or link after it, a number from the list, other spellings, and mistakes", () => {
  expect(parseLookArgs("")).toEqual({ list: true });
  expect(parseLookArgs("  ")).toEqual({ list: true });
  expect(parseLookArgs("critique")).toEqual({ command: findLookCommand("critique")! });
  expect(parseLookArgs("adapt /settings")).toEqual({ command: findLookCommand("adapt")!, target: "/settings" });
  expect(parseLookArgs("POLISH http://127.0.0.1:5173/")).toEqual({ command: findLookCommand("polish")!, target: "http://127.0.0.1:5173/" });
  expect(parseLookArgs("4")).toEqual({ command: findLookCommand("polish")! });
  expect(parseLookArgs("color")).toEqual({ command: findLookCommand("colour")! });
  expect(parseLookArgs("typeset")).toEqual({ command: findLookCommand("type")! });
  expect(parseLookArgs("vercel")).toEqual({ command: findLookCommand("guidelines")! });
  const unknown = parseLookArgs("bogus");
  expect("problem" in unknown && unknown.problem).toStartWith("[look] There is no /look bogus. Usage: /look <command> [page or url]");
  expect("problem" in unknown && unknown.problem).toContain(" 1. critique");
  expect("problem" in parseLookArgs("12")).toBe(true);
  expect("problem" in parseLookArgs("audit /a /b")).toBe(true);
  // The list is numbered, one command a line.
  expect(lookList().split("\n").slice(1).map((line) => line.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual(NAMES.map((name, i) => `${i + 1}. ${name}`));
});

test("the command table, the alias spellings and /help all know /look", () => {
  const spec = findCommand("look")!;
  expect(spec.subcommands!.map(({ name }) => name)).toEqual(NAMES);
  expect(canonicalLine("/look color /x")).toBe("/look colour /x");
  expect(canonicalLine("/look vercel")).toBe("/look guidelines");
  for (const line of ["/look", "/look critique", "/look bogus", "/look adapt /settings"]) expect(commandProblem(line)).toBeUndefined();
  for (const name of NAMES) expect(FULL_HELP_TEXT).toMatch(new RegExp(`/look [a-z|]*\\b${name}\\b`));
});

test("each command's prompt carries its own file and no other, and none is in the fixed prompt", () => {
  for (const command of LOOK_COMMANDS) {
    const prompt = formatLookPrompt(command, URL_PAGE);
    expect(prompt).toContain(`--- Look ${command.name} ---\n${command.body.trim()}\n--- End look ---`);
    for (const other of LOOK_COMMANDS.filter(({ name }) => name !== command.name)) expect(prompt).not.toContain(heading(other.name));
    expect(prompt).toContain(command.fixes ? "Finish with a replay of your checks and fresh screenshots" : "Change no files.");
    for (const system of [DEFAULT_SYSTEM_PROMPT_APPEND, LEAN_SYSTEM_PROMPT_APPEND]) {
      expect(system).not.toContain(command.body.trim().split("\n").at(-1)!);
      expect(system).not.toContain("/look");
    }
  }
});

test("the request names the browser, reads as a review for a report and a change for a fix, and names its target", () => {
  const critique = lookRequest(findLookCommand("critique")!, URL_PAGE);
  expect(critique).toContain("in the browser");
  expect(classifyTask(critique).mode).toBe("read");
  const polish = lookRequest(findLookCommand("polish")!, { kind: "server", label: "bun run dev", path: "/settings" });
  expect(polish).toContain("`/settings`");
  expect(classifyTask(polish).mode).toBe("modify");
});

test("the page is found the way the page checks find it, and a project with none says so", async () => {
  const empty = await folder("empty");
  expect(await findLookPage(empty, {}, "http://127.0.0.1:3000/x")).toEqual({ kind: "url", url: "http://127.0.0.1:3000/x" });
  expect(await findLookPage(empty, {}, "file:///etc/hosts")).toEqual({ reason: expect.stringContaining("is not a web link") });
  expect(await findLookPage(empty, {})).toEqual({ reason: expect.stringContaining("There is no page here to look at") });

  const plain = await folder("plain");
  await writeFile(path.join(plain, "index.html"), "<!doctype html><title>x</title>\n");
  expect(await findLookPage(plain, {})).toEqual({ kind: "files", file: "index.html", path: "/" });
  expect(await findLookPage(plain, {}, "about.html")).toEqual({ kind: "files", file: "index.html", path: "/about.html" });

  const vite = await folder("vite");
  await writeFile(path.join(vite, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "7.0.0" } }));
  expect(await findLookPage(vite, { packageManager: "bun" })).toEqual({ reason: expect.stringContaining("node_modules is missing") });
  await mkdir(path.join(vite, "node_modules"));
  expect(await findLookPage(vite, { packageManager: "bun" }, "/settings")).toEqual({ kind: "server", label: "bun run dev", path: "/settings" });
  const prompt = formatLookPrompt(findLookCommand("adapt")!, { kind: "server", label: "bun run dev", path: "/settings" });
  expect(prompt).toContain("Start the project's dev server (bun run dev) with the browser tool's serve, then open /settings on it.");
});

class Runtime implements AgentRuntime {
  readonly prompts: string[] = [];
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    const listeners = new Set<RuntimeEventListener>();
    const prompts = this.prompts;
    return {
      async prompt(text: string) {
        prompts.push(text);
        for (const listener of listeners) { listener({ type: "assistant_text_delta", delta: "ok" }); listener({ type: "message_end" }); }
      },
      setTools() {}, async abort() {},
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

async function app(options: { installed?: boolean; config?: string } = {}) {
  const base = await folder("app");
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(project, { recursive: true });
  if (options.config) await writeFile(path.join(home, ".casper/config.yaml"), options.config);
  const previous = browserDefaults.installed;
  browserDefaults.installed = async () => options.installed ?? true;
  cleanup.push(() => { browserDefaults.installed = previous; });
  const runtime = new Runtime();
  let output = "";
  const casper = new CasperApp({
    runtimeFactory: () => runtime, output: { write: (text) => { output += text; } }, sessionHomeDir: home, verificationMode: "off",
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  cleanup.push(() => casper.close());
  return { run: (line: string) => casper.runOnce(line, project), runtime, output: () => output };
}

test("in the app: /look sends only the chosen command's file; with no page, no browser or a wrong word it says so and sends nothing", async () => {
  const casper = await app();
  await casper.run("/look");
  expect(casper.output()).toContain(" 1. critique");
  await casper.run("/look bogus");
  expect(casper.output()).toContain("[look] There is no /look bogus.");
  await casper.run("/look critique");
  expect(casper.output()).toContain("[look] There is no page here to look at");
  expect(casper.runtime.prompts).toHaveLength(0);

  await casper.run("/look critique http://127.0.0.1:5173/");
  expect(casper.output()).toContain("[look] critique: http://127.0.0.1:5173/ (a report; no files change)");
  await casper.run("/look polish http://127.0.0.1:5173/");
  expect(casper.runtime.prompts).toHaveLength(2);
  const [critique, polish] = casper.runtime.prompts as [string, string];
  expect(critique).toContain(findLookCommand("critique")!.body.trim());
  expect(polish).toContain(findLookCommand("polish")!.body.trim());
  for (const other of NAMES.filter((name) => name !== "critique")) expect(critique).not.toContain(heading(other));
  for (const other of NAMES.filter((name) => name !== "polish")) expect(polish).not.toContain(heading(other));
  // An ordinary request afterwards carries none of it.
  await casper.run("rename add to sum in src/math.ts");
  expect(casper.runtime.prompts[2]).not.toContain("--- Look");

  const missing = await app({ installed: false });
  await missing.run("/look audit http://127.0.0.1:5173/");
  expect(missing.output()).toContain("[look] /look needs Chrome, Chromium or Edge");
  expect(missing.runtime.prompts).toHaveLength(0);

  const off = await app({ config: "browser: off\n" });
  await off.run("/look audit http://127.0.0.1:5173/");
  expect(off.output()).toContain("[look] The AI's browser is off");
  expect(off.runtime.prompts).toHaveLength(0);
});

test("the notices credit impeccable for the /look text and say what was changed", async () => {
  const notices = await Bun.file(new URL("../THIRD_PARTY_NOTICES.txt", import.meta.url)).text();
  const entry = notices.split("pbakaus/impeccable (Apache-2.0) — the /look command instructions")[1]!.split("\n=====")[0]!;
  for (const line of ["https://github.com/pbakaus/impeccable", "critique.md", "clarify.md", "Changes: each was shortened",
    "Copyright 2025 Paul Bakaus", "reference/ios.md, reference/android.md) are\nnot used"]) expect(entry).toContain(line);
});
