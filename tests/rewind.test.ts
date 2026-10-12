import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { earlierPrompts, promptWords } from "../src/app/rewind";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { formatTaskPrompt } from "../src/task/classify";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

test("your words come back from the message Casper sent; Casper's own rounds are not your prompts", () => {
  expect(promptWords("fix the login bug")).toBe("fix the login bug");
  expect(promptWords("Casper human-entered project facts (guidance, not permission).\n- uses bun\n\nCasper initial classification (hints):\n- intent: implement\n\nUser request:\nfix the login bug\n\nand the logout one too\n\nCases your request states (Casper's checklist). Handle every one:\n- a")).toBe("fix the login bug\n\nand the logout one too");
  expect(promptWords("add a flag\n\nDo this yourself: no builders this time.")).toBe("add a flag");
  expect(promptWords("Casper verification repair 1/3.\nRepair the failures below.\nOriginal request:\nfix it")).toBeUndefined();
  expect(promptWords("Casper requirements review.\nThe checks pass.\nOriginal request:\nfix it")).toBeUndefined();
  expect(promptWords("Your last response failed with a provider error. Continue the task from where you stopped.")).toBeUndefined();
  expect(promptWords("User request:\nadd a flag\n\nCasper plan (the user read and accepted it). Follow these steps in order:\n1. a")).toBeUndefined();
  expect(promptWords("Casper flow \"plan\", chosen by the user for this request only. It is guidance.\n--- Flow plan ---\nPlan.\n--- End flow ---\n\nRequest: add a --verbose flag\n\nCases the user listed (put each under Tests:):\n- a"))
    .toBe("/plan add a --verbose flag");
  expect(promptWords("   ")).toBeUndefined();
});

test("the task prompt Casper builds gives back the words as typed", () => {
  const request = "rename the greet function\n\nkeep the old name working";
  const sent = formatTaskPrompt(request, { intent: "implement", mode: "modify" } as Parameters<typeof formatTaskPrompt>[1],
    { commands: {}, frameworks: [], conventions: [] } as unknown as Parameters<typeof formatTaskPrompt>[2]);
  expect(promptWords(`Casper selected skills for this request only.\n--- Skill a ---\nbody\n\n${sent}`)).toBe(request);
});

test("prompts are listed newest first, each with the position just before it", () => {
  const entries = [{ id: "m" }, { id: "u1", prompt: "first" }, { id: "a1" }, { id: "r1", prompt: "Casper proof repair.\nOriginal request:\nfirst" },
    { id: "a2" }, { id: "u2", prompt: "second" }, { id: "a3" }];
  expect(earlierPrompts(entries)).toEqual([{ before: "a2", index: 5, words: "second" }, { before: "m", index: 1, words: "first" }]);
  expect(earlierPrompts([{ id: "u1", prompt: "only" }])).toEqual([{ before: null, index: 0, words: "only" }]);
});

interface Turn { (project: string): Promise<void> }

/** A project, a HOME and a fake model whose turns write files; the fake conversation is a tree of entries, as Pi's. */
async function session(turns: Turn[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-rewind-"));
  roots.push(root);
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(home, { recursive: true }); await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "notes.py"), "print('one')\n");
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const all = new Map<string, { id: string; parent: string | null; prompt?: string }>();
  let leaf: string | null = null;
  const branch = (from: string | null = leaf) => {
    const path: Array<{ id: string; prompt?: string }> = [];
    for (let at = from === null ? undefined : all.get(from); at; at = at.parent === null ? undefined : all.get(at.parent)) {
      path.unshift({ id: at.id, ...(at.prompt === undefined ? {} : { prompt: at.prompt }) });
    }
    return path;
  };
  const append = (id: string, prompt?: string) => { all.set(id, { id, parent: leaf, ...(prompt === undefined ? {} : { prompt }) }); leaf = id; };
  let made = 0;
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        getSessionInfo: () => ({ cwd: project, sessionId: "conversation-1", sessionFile: "/dev/null" }),
        conversationMark: () => leaf,
        conversationEntries: (from?: string) => branch(from ?? leaf),
        rewindTo: async (mark: string | null, expected: string | null) => {
          if (leaf !== expected) return false;
          leaf = mark;
          return true;
        },
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async (text: string) => {
          append(`user-${++made}`, text);
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          await turns.shift()?.(project);
          emit({ type: "assistant_text_delta", delta: "Done.\n" });
          emit({ type: "assistant_response_end", stopReason: "stop" });
          append(`reply-${made}`);
        },
      };
    },
    async dispose() {},
  };
  let output = "";
  const waiters: Array<{ test: () => boolean; resolve: () => void }> = [];
  const input = new PassThrough();
  const app = new CasperApp({
    input,
    output: { write: (text: string) => {
      output += text;
      for (const waiter of [...waiters]) if (waiter.test()) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
    } },
    runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const until = (test: () => boolean) => {
    if (test()) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push({ test, resolve });
    return promise;
  };
  const running = app.runInteractive(project);
  const send = async (line: string, done: RegExp = /\n> $/) => {
    const from = output.length;
    input.write(`${line}\n`);
    await until(() => done.test(output.slice(from)));
    return output.slice(from);
  };
  const close = async () => { input.end(); await running; await app.close(); };
  const notes = () => readFile(path.join(project, "notes.py"), "utf8");
  return { send, close, branch: () => branch(), notes, project };
}

const write = (text: string): Turn => async (project) => { await writeFile(path.join(project, "notes.py"), text); };
const ASKED = /Type [^\n]*: $/;

test("/rewind with nothing said yet changes nothing", async () => {
  const s = await session([]);
  try { expect(await s.send("/rewind")).toContain("Nothing to rewind"); }
  finally { await s.close(); }
}, 30_000);

test("/rewind: pick a prompt, then Conversation and files puts the later tasks' files back", async () => {
  const s = await session([write("print('two')\n"), write("print('three')\n")]);
  try {
    await s.send("change notes.py to print two");
    await s.send("change notes.py to print three");
    const list = await s.send("/rewind", ASKED);
    expect(list).toContain("Rewind to just before which prompt?\n  1 change notes.py to print three\n  2 change notes.py to print two\n");
    const files = await s.send("2", ASKED);
    expect(files).toContain("tasks 2, 1 after that prompt changed files.\n  1 Conversation only · the files stay as they are now\n  2 Conversation and files");
    const done = await s.send("2");
    expect(done).toContain("✓ Undone tasks 2, 1 — 1 file is back as before: notes.py");
    expect(done).toContain("✓ Rewound to just before \"change notes.py to print two\".");
    expect(done).toContain("– Your prompt was:\nchange notes.py to print two\n");
    expect(done).toContain("– Nothing is deleted");
    expect(await s.notes()).toBe("print('one')\n");
    expect(s.branch()).toEqual([]);
    // Each task is undone as /undo would leave it: /redo puts them back in order.
    expect(await s.send("/redo 1")).toContain("✓ Redone");
    expect(await s.send("/redo 2")).toContain("✓ Redone");
    expect(await s.notes()).toBe("print('three')\n");
  } finally { await s.close(); }
}, 60_000);

test("/rewind 1 with Conversation only keeps the files; a file changed since refuses the files choice and changes nothing", async () => {
  const s = await session([write("print('two')\n"), write("print('three')\n")]);
  try {
    await s.send("change notes.py to print two");
    await s.send("change notes.py to print three");
    const marks = s.branch().map((entry) => entry.id);
    await s.send("/rewind 1", ASKED);
    const kept = await s.send("1");
    expect(kept).toContain("✓ Rewound to just before \"change notes.py to print three\".");
    expect(kept).toContain("– Files are as they are now: task 2 changed them after that prompt.");
    expect(await s.notes()).toBe("print('three')\n");
    expect(s.branch().map((entry) => entry.id)).toEqual(marks.slice(0, 2));
    expect(await s.send("/rewind 5")).toContain("No prompt 5: this conversation has 1.");
    // A file you changed since: Conversation and files changes nothing at all.
    await writeFile(path.join(s.project, "notes.py"), "print('mine')\n");
    await s.send("/rewind 1", ASKED);
    const refused = await s.send("2");
    expect(refused).toContain("notes.py changed after task 2, so Casper left the files and the conversation as they are.");
    expect(refused).not.toContain("Rewound");
    expect(await s.notes()).toBe("print('mine')\n");
    expect(s.branch().map((entry) => entry.id)).toEqual(marks.slice(0, 2));
  } finally { await s.close(); }
}, 60_000);

test("a task on a branch an earlier /rewind left counts only when it ran after the prompt", async () => {
  const s = await session([write("print('two')\n"), write("print('three')\n"), write("print('four')\n")]);
  try {
    await s.send("change notes.py to print two");
    await s.send("change notes.py to print three");
    await s.send("/rewind 1", ASKED);
    await s.send("1");
    await s.send("change notes.py to print four");
    await s.send("/rewind 1", ASKED);
    const done = await s.send("2");
    expect(done).toContain("✓ Undone task 3 — 1 file is back as before: notes.py");
    expect(await s.notes()).toBe("print('three')\n");
    // Back before the first prompt: task 2, on the branch the first rewind left below it, goes back too.
    await s.send("/rewind 1", ASKED);
    const first = await s.send("2");
    expect(first).toContain("✓ Undone tasks 2, 1 — 1 file is back as before: notes.py");
    expect(await s.notes()).toBe("print('one')\n");
  } finally { await s.close(); }
}, 60_000);
