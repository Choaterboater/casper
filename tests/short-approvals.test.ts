import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { allowedCommand } from "../src/app/allowed";
import { keepNextItems } from "../src/app/keep-next";
import { createSessionSandbox, runtimeShell, shellQuestion, STOP_ASKING_HINT, type SandboxHost } from "../src/app/sandbox";
import {
  CHECKS_OUTSIDE_CHOICES, githubLoginChoices, HOST_CHOICES, REACH_CHOICES, SHELL_COMMAND_CHOICES, writeChoices, YES_ONCE, YES_SESSION,
} from "../src/app/safe-choices";
import { stopAskingRequest } from "../src/app/stop-asking-words";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { SandboxStore } from "../src/sandbox/store";
import { TerminalSurface } from "../src/tui/surface";
import { fakeEngine } from "./support/sandbox-fakes";
import { removeTempDir } from "./support/temp-dir";

/**
 * Approval boxes ask with three short rows, 1 No · 2 Yes, this once · 3 Yes, for this session, and nothing beside
 * them. No takes the note to the AI; "always for this project" is offered after a session yes, on the Next row; "stop
 * asking" in plain words opens the /permissions all box (docs/adr/0002/45-three-row-approvals.md).
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

const THREE = ["No", "Yes, this once", "Yes, for this session"];

test("every yes-word approval box has the same three short rows and no explanations", () => {
  for (const choices of [HOST_CHOICES, REACH_CHOICES, CHECKS_OUTSIDE_CHOICES, writeChoices("~/x"), githubLoginChoices("git push")]) {
    expect(choices.map((choice) => choice.label)).toEqual(THREE);
    expect(choices.every((choice) => !("description" in choice) || choice.description === undefined)).toBe(true);
  }
  // The shell box keeps a fourth row, /permissions all in one key, beside auto mode's judge (the owner's choice).
  expect(SHELL_COMMAND_CHOICES.map((choice): string => choice.label)).toEqual([...THREE, "Yes to everything this session"]);
  expect(SHELL_COMMAND_CHOICES.every((choice) => !("description" in choice))).toBe(true);
  // Where a session yes can't be given today (a GitHub command that changes things), only 1 and 2.
  expect(githubLoginChoices("gh pr merge", false).map((choice) => choice.label)).toEqual(["No", "Yes, this once"]);
});

function box() {
  const input = new PassThrough();
  const surface = new TerminalSurface({ input, output: { columns: 80, rows: 30, write() {} }, color: false, onEOF() {} }, () => {}, () => {});
  surface.start();
  const render = () => Bun.stripANSI((surface as unknown as { renderAsk(w: number, h: number): string[] }).renderAsk(80, 30).join("\n"));
  const transcript = () => Bun.stripANSI((surface as unknown as { transcript: { render(width: number): string[] } }).transcript.render(120).join("\n"));
  return { input, surface, render, transcript, close() { surface.close(); input.destroy(); } };
}
const settle = () => Bun.sleep(400);

test("the Run this command? box shows four short rows, no note row and no hint; 1 opens the note line on No", async () => {
  const session = box();
  try {
    const answer = session.surface.approve("", shellQuestion("npm test", "I'll run the tests."), [...SHELL_COMMAND_CHOICES]);
    await settle();
    const shown = session.render();
    expect(shown).toContain("❯ 1. No");
    expect(shown).toContain("2. Yes, this once");
    expect(shown).toContain("3. Yes, for this session");
    expect(shown).toContain("4. Yes to everything this session");
    expect(shown).not.toContain("5.");
    expect(shown).not.toContain("until you quit");
    expect(shown).not.toContain("tell the AI what to do instead");
    expect(shown).not.toContain("Enter to choose");
    expect(shown).toContain("The model says: I'll run the tests.");
    // Picking No opens its line; an empty Enter is a plain No.
    session.input.write("1");
    await Bun.sleep(20);
    expect(session.render()).toContain("Enter sends No");
    session.input.write("\r");
    expect(await answer).toBe("No");
  } finally { session.close(); }
});

test("words typed after picking No go to the AI with the No, and never approve", async () => {
  const session = box();
  try {
    const answer = session.surface.approve("", shellQuestion("npm test"), [...SHELL_COMMAND_CHOICES]);
    await settle();
    session.input.write("\r");
    await Bun.sleep(20);
    session.input.write("yes run the fixture instead");
    await Bun.sleep(20);
    expect(session.render()).toContain("❯ 1. No — yes run the fixture instead");
    session.input.write("\r");
    expect(await answer).toBe("No");
    expect(session.transcript()).toContain("No (yes run the fixture instead)");
  } finally { session.close(); }
});

test("Esc on the note line goes back to the list, and 2 still says yes once", async () => {
  const session = box();
  try {
    const answer = session.surface.approve("", shellQuestion("npm test"), [...SHELL_COMMAND_CHOICES]);
    await settle();
    session.input.write("1");
    await Bun.sleep(20);
    session.input.write("\x1b");
    await Bun.sleep(80);
    expect(session.render()).not.toContain("Enter sends No");
    session.input.write("2");
    expect(await answer).toBe(YES_ONCE);
  } finally { session.close(); }
});

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-short-approvals-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(home); await mkdir(project);
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  return { home, project, context };
}

function host(answers: Array<string | undefined>): SandboxHost & { written: string[] } {
  const written: string[] = [];
  return { canAsk: () => true, pick: async () => answers.shift(), write: (text) => { written.push(text); }, planning: () => false, written };
}

test("a session yes is offered to keep on the Next row, once, and /allowed keep saves exactly that command", async () => {
  const { home, project, context } = await fixture();
  const terminal = host([YES_SESSION]);
  const sandbox = createSessionSandbox(terminal, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const store = sandbox.store!;
  const shell = runtimeShell(terminal, sandbox, new SandboxStore(context.stateDirectory));
  expect(await shell.approve!("npm test --watch=false")).toBeUndefined();
  expect(keepNextItems(store)).toEqual([{ label: "Always allow npm test --watch=false in this project", command: "/allowed keep 1" }]);
  // Offered once: the next task's row doesn't repeat it.
  expect(keepNextItems(store)).toEqual([]);
  expect(await store.allowsCommand("npm test --watch=false", "npm test --watch=false")).toBe(false);
  const out: string[] = [];
  await allowedCommand("/allowed keep 1", store, (text) => out.push(text));
  expect(out.join("")).toContain("✓ allowed always in this project: npm test --watch=false");
  expect(await store.allowsCommand("npm test --watch=false", "npm test --watch=false")).toBe(true);
  // Kept already, or a number that isn't there: nothing more is saved.
  out.length = 0;
  await allowedCommand("/allowed keep 1", store, (text) => out.push(text));
  expect(out.join("")).toContain("already");
  out.length = 0;
  await allowedCommand("/allowed keep 7", store, (text) => out.push(text));
  expect(out.join("")).toContain("There is no 7");
  await sandbox.close();
});

test("a host allowed for the session is offered to keep, and keeping it remembers the host for the project", async () => {
  const { home, project, context } = await fixture();
  const engine = fakeEngine();
  const terminal = host([YES_SESSION]);
  const sandbox = createSessionSandbox(terminal, context, { root: () => project, home, seams: { engine, problem: () => undefined, platform: "linux" } });
  await sandbox.wrap("true", { cwd: project });
  expect(await engine.ask!("api.example.com", 443)).toBe(true);
  expect(keepNextItems(sandbox.store!)).toEqual([{ label: "Always allow api.example.com in this project", command: "/allowed keep 1" }]);
  await allowedCommand("/allowed keep 1", sandbox.store!, () => {});
  expect(await sandbox.store!.hosts()).toContain("api.example.com");
  await sandbox.close();
});

test("the stop-asking tip names the fourth row and the plain words", () => {
  expect(STOP_ASKING_HINT).toContain("4 Yes to everything this session");
  expect(STOP_ASKING_HINT).toContain('"stop asking"');
});

test("\"stop asking\" alone on the line opens the /permissions all box; anything longer is a request", () => {
  for (const line of ["stop asking", "Stop asking me.", "please stop asking", "don't ask again", "dont ask me again", "stop asking me for permission"]) {
    expect(stopAskingRequest(line)).toBe(true);
  }
  for (const line of ["stop asking about the tests and fix them", "why do you keep asking", "don't ask the user again in the code", "stop", "x"]) {
    expect(stopAskingRequest(line)).toBe(false);
  }
  expect(stopAskingRequest("stop asking", ["pasted"])).toBe(false);
});

test("only the person's own key or typed /allowed keep can keep a yes: nothing else reads the keep list", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const root = path.join(import.meta.dir, "..", "src");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (file.endsWith(".ts") && /\.keepable\b|readonly keepable\b/.test(readFileSync(file, "utf8"))) found.push(path.relative(root, file).split(path.sep).join("/"));
    }
  };
  walk(root);
  // The store holds it, keep-next offers it on the Next row (a key there submits /allowed keep <n>), and /allowed keeps it.
  expect(found.sort()).toEqual(["app/allowed.ts", "app/keep-next.ts", "sandbox/store.ts"]);
});
