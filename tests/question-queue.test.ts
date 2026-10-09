import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { CasperApp } from "../src/app";
import { askToolFor, recordedApproval } from "../src/app/approvals";
import { createSessionSandbox, runtimeShell } from "../src/app/sandbox";
import { NO, YES_ONCE } from "../src/app/safe-choices";
import { spendGate } from "../src/app/spend-gate";
import { sandboxHost } from "../src/app/wiring";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { SandboxStore } from "../src/sandbox/store";
import { SpendGuard } from "../src/task/spend";
import { InteractiveTerminal } from "../src/tui/terminal";
import { fakeEngine } from "./support/sandbox-fakes";
import { removeTempDir } from "./support/temp-dir";
import { waitUntil } from "./support/wait";

/**
 * Questions that come at the same time (two of the AI's shell commands, a shell question and an MCP box, a box and the
 * spend pause) are asked one after another. A question nobody was shown is never answered No for them.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-question-queue-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(home); await mkdir(project);
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  return { home, project, context };
}

/** The app fields the questions read, around a terminal. */
function appWith(terminal: unknown, extra: Record<string, unknown> = {}): CasperApp {
  const output = { write: (text: string) => { (terminal as { write(text: string): void }).write(text); } };
  return { interactive: true, closing: false, planning: false, approvalQueue: Promise.resolve(), terminal, output, ...extra } as unknown as CasperApp;
}

/** A terminal like both real ones: one question open at a time; asked while one is open, it answers undefined. */
function oneBoxTerminal() {
  const asked: string[] = [];
  let open: ((answer: string | undefined) => void) | undefined;
  const ask = (question: string) => {
    if (open) return Promise.resolve(undefined);
    asked.push(question);
    return new Promise<string | undefined>((resolve) => { open = (answer) => { open = undefined; resolve(answer); }; });
  };
  return {
    asked, canAsk: true, rich: false, write() {}, endAssistant() {},
    pick: (question: string) => ask(question),
    approve: (_preview: string, question: string) => ask(question),
    answer: (label: string) => open?.(label),
    isOpen: () => open !== undefined,
  };
}

/** Whether a promise has settled yet (an answer given without a question settles at once). */
function settled(promise: Promise<unknown>): () => boolean {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
}

test("two of the AI's shell commands that need your OK at once are both asked, one after the other", async () => {
  const { home, project, context } = await fixture();
  const input = Object.assign(new PassThrough(), { isTTY: true });
  let screen = "";
  const terminal = new InteractiveTerminal(input, { isTTY: false, write: (text: string) => { screen += text; return true; } } as never, () => {}, () => {});
  terminal.start();
  try {
    const host = sandboxHost(appWith(terminal));
    // No sandbox on Windows: the AI's commands that change things ask first.
    const sandbox = createSessionSandbox(host, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
    const shell = runtimeShell(host, sandbox, new SandboxStore(context.stateDirectory));
    const results = Promise.all([shell.approve!("npm install left-pad"), shell.approve!("npm install right-pad")]);
    const done = settled(results);
    expect(await waitUntil(() => screen.includes("left-pad"))).toBe(true);
    input.write("2\n");
    await waitUntil(() => screen.includes("right-pad") || done());
    input.write("2\n");
    // Both ran on your Yes, this once; neither was refused in your name.
    expect(await results).toEqual([undefined, undefined]);
    // Two boxes, one after the other; a Yes, this once leaves no line of its own (the command's own line shows it ran).
    expect(screen.match(/Run this command\?  npm install (?:left|right)-pad\n/g)).toHaveLength(2);
    expect(screen).not.toContain("→ Yes, this once");
  } finally {
    terminal.close();
    input.destroy();
  }
});

test("an MCP box that comes while a shell question is open waits for it, and is asked, not denied", async () => {
  const { home, project, context } = await fixture();
  const terminal = oneBoxTerminal();
  const app = appWith(terminal);
  const host = sandboxHost(app);
  const sandbox = createSessionSandbox(host, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(host, sandbox, new SandboxStore(context.stateDirectory));
  const command = shell.approve!("npm install left-pad");
  expect(await waitUntil(() => terminal.isOpen())).toBe(true);
  const box = recordedApproval(app, "", "Allow this change?", [{ label: NO }, { label: YES_ONCE }]);
  const boxDone = settled(box);
  // The box gets its turn to ask (pending work runs) while the shell question is still open.
  await new Promise((resolve) => setImmediate(resolve));
  terminal.answer(YES_ONCE);
  expect(await command).toBeUndefined();
  await waitUntil(() => terminal.isOpen() || boxDone());
  terminal.answer(YES_ONCE);
  expect(await box).toBe(YES_ONCE);
  expect(terminal.asked).toEqual(["Run this command?  npm install left-pad", "Allow this change?"]);
});

test("the spend pause that comes while a box is open is asked after it, not taken as Stop here", async () => {
  const terminal = oneBoxTerminal();
  const app = appWith(terminal, {
    spendGuard: new SpendGuard({ pauseAt: 5 }),
    session: { getStatus: () => ({ priced: true, billing: "api" }) },
    observations: { spent: () => ({ cost: 6, tokens: 1000 }) },
    subagents: { runs: () => [], stopBuilders() {} },
    events: { ensureLineBreak() {} },
  });
  const box = recordedApproval(app, "", "Allow this change?", [{ label: NO }, { label: YES_ONCE }]);
  expect(await waitUntil(() => terminal.isOpen())).toBe(true);
  const pause = spendGate(app);
  const pauseDone = settled(pause);
  terminal.answer(YES_ONCE);
  expect(await box).toBe(YES_ONCE);
  await waitUntil(() => terminal.isOpen() || pauseDone());
  terminal.answer("Keep going");
  expect(await pause).toBeUndefined();
  expect(terminal.asked).toEqual(["Allow this change?", "This task has used $6.00."]);
});

test("two of the AI's ask questions at once are asked one after the other, not the second answered No", async () => {
  const asked: string[] = [];
  let open: ((answer: string[] | undefined) => void) | undefined;
  const terminal = {
    canAsk: true, rich: true, write() {}, endAssistant() {},
    ask: (question: string) => {
      if (open) return Promise.resolve(undefined);
      asked.push(question);
      return new Promise<string[] | undefined>((resolve) => { open = (answer) => { open = undefined; resolve(answer); }; });
    },
  };
  const tool = askToolFor(appWith(terminal));
  const options = [{ label: "A" }, { label: "B" }];
  const first = tool.execute({ question: "first?", options }, new AbortController().signal);
  const second = tool.execute({ question: "second?", options }, new AbortController().signal);
  expect(await waitUntil(() => open !== undefined)).toBe(true);
  expect(asked).toEqual(["first?"]);
  open!(["A"]);
  expect(await waitUntil(() => asked.length === 2)).toBe(true);
  open!(["B"]);
  const results = await Promise.all([first, second]);
  expect(results.map(r => JSON.parse(r.text).answers)).toEqual([["A"], ["B"]]);
  expect(asked).toEqual(["first?", "second?"]);
});
