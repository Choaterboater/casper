import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { receiptEvent } from "../src/app/json-events";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { taskExitCode } from "../src/task/result";
import { UndoStore } from "../src/task/undo";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

interface Turn { (project: string, edited: (file: string) => Promise<unknown>): Promise<void> }

/** A folder, a HOME, and a fake model whose turns write files. The fake conversation records marks, rewinds and notes. */
async function folder(options: { git?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-undo-app-"));
  roots.push(root);
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(home, { recursive: true }); await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "notes.py"), "print('one')\n");
  if (options.git) {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: project, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
    await writeFile(path.join(project, "other.py"), "x = 1\n");
    git("add", "-A"); git("commit", "-qm", "first");
  }
  return { root, home, project };
}

function makeApp(place: { home: string; project: string }, turns: Turn[], options: { interactive?: boolean; input?: PassThrough; sessionId?: string } = {}) {
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const conversation: string[] = [];
  const rewinds: Array<[string | null, string | null]> = [];
  const notes: string[] = [];
  const runtime: AgentRuntime = {
    async start(startOptions) {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: place.project, isStreaming: false }),
        getSessionInfo: () => ({ cwd: place.project, sessionId: options.sessionId ?? "conversation-1", sessionFile: "/dev/null" }),
        conversationMark: () => conversation.at(-1) ?? null,
        rewindTo: async (mark: string | null, expected: string | null) => {
          if ((conversation.at(-1) ?? null) !== expected) return false;
          rewinds.push([mark, expected]);
          conversation.splice(mark === null ? 0 : conversation.indexOf(mark) + 1);
          return true;
        },
        appendContext: async (text: string) => { notes.push(text); conversation.push(`note-${conversation.length}`); },
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => {
          conversation.push(`turn-${conversation.length}`);
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          await turns.shift()?.(place.project, async (file) => startOptions.afterFileEdit?.(file, new AbortController().signal));
          emit({ type: "assistant_text_delta", delta: "Done.\n" });
          emit({ type: "assistant_response_end", stopReason: "stop" });
        },
      };
    },
    async dispose() {},
  };
  let output = "";
  const waiters: Array<{ test: () => boolean; resolve: () => void }> = [];
  const app = new CasperApp({
    ...(options.input ? { input: options.input } : {}),
    output: { write: (text: string) => {
      output += text;
      for (const waiter of [...waiters]) if (waiter.test()) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
    } },
    runtimeFactory: () => runtime, sessionHomeDir: place.home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: place.home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: place.home }),
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
  return { app, rewinds, notes, output: () => output, until };
}

const edit = (file: string, text: string): Turn => async (project) => { await mkdir(path.dirname(path.join(project, file)), { recursive: true }); await writeFile(path.join(project, file), text); };

/** An interactive session on the plain terminal: `send` types a line and waits until Casper is back at the prompt. */
function session(place: { home: string; project: string }, turns: Turn[], sessionId?: string) {
  const input = new PassThrough();
  const made = makeApp(place, turns, { input, ...(sessionId ? { sessionId } : {}) });
  const running = made.app.runInteractive(place.project);
  const send = async (line: string, done: RegExp = /\n> $/) => {
    const from = made.output().length;
    input.write(`${line}\n`);
    await made.until(() => done.test(made.output().slice(from)));
    return made.output().slice(from);
  };
  const close = async () => { input.end(); await running; await made.app.close(); };
  return { ...made, input, send, close };
}

test("one-shot: the receipt says how to undo; casper /undo in a later run puts the file back", async () => {
  const place = await folder();
  const first = makeApp(place, [edit("notes.py", "print('two')\n")]);
  const started = process.cwd();
  try {
    // Started in the project's own folder (here a subfolder of it), the command needs no folder.
    await mkdir(path.join(place.project, "sub"));
    process.chdir(path.join(place.project, "sub"));
    await first.app.runOnce("fix the greeting in notes.py", place.project);
    expect(first.output()).toContain("Undo: casper /undo 1 · Diff: casper /diff 1\n");
    expect(first.output()).not.toContain("branch moved");
    const task = first.app.getLastTaskResult()!;
    expect(receiptEvent(undefined, task, taskExitCode(undefined, task))).toMatchObject({ task: 1, undo: { available: true, reason: null } });
  } finally { process.chdir(started); await first.app.close(); }
  const later = makeApp(place, []);
  try {
    await later.app.runOnce("/undo", place.project);
    expect(later.output()).toContain("✓ Undone — 1 file is back as it was before task 1: notes.py\n");
    expect(later.output()).toContain("– The conversation is not changed: only files were put back.");
    expect(await readFile(path.join(place.project, "notes.py"), "utf8")).toBe("print('one')\n");
  } finally { await later.app.close(); }
}, 30_000);

posixOnly("one-shot in a project named through a link (macOS's temp folder is /private/var): no --cd from inside it", async () => {
  const place = await folder();
  const linked = path.join(place.root, "linked");
  await symlink(place.project, linked);
  const made = makeApp({ home: place.home, project: linked }, [edit("notes.py", "print('two')\n")]);
  const started = process.cwd();
  try {
    process.chdir(linked);
    await made.app.runOnce("fix the greeting in notes.py", linked);
    expect(made.output()).toContain("Undo: casper /undo 1 · Diff: casper /diff 1\n");
  } finally { process.chdir(started); await made.app.close(); }
}, 30_000);

test("/diff shows this task's patch, also in a folder that is not a git repository", async () => {
  const place = await folder();
  const made = makeApp(place, [edit("notes.py", "print('two')\n")]);
  try {
    await made.app.runOnce("fix the greeting in notes.py", place.project);
    await made.app.runOnce("/diff", place.project);
    const out = made.output();
    expect(out).toContain("Changes in task 1\n");
    expect(out).toContain("-print('one')\n+print('two')");
    expect(out).not.toContain("Not a Git repository");
  } finally { await made.app.close(); }
}, 30_000);

test("the receipt names only this task's files, not your own earlier edits; the per-file table stays behind /diff", async () => {
  const place = await folder({ git: true });
  await writeFile(path.join(place.project, "other.py"), "x = 2  # my own edit, not committed\n");
  const made = makeApp(place, [edit("notes.py", "print('two')\n")]);
  try {
    await made.app.runOnce("fix the greeting in notes.py", place.project);
    const out = made.output();
    expect(out).toContain("✓ changed notes.py\n");
    expect(out).not.toContain(" notes.py | 2 +-");
    expect(out).not.toContain("other.py");
    await made.app.runOnce("/diff 1", place.project);
    expect(made.output()).toContain("+print('two')");
    expect(made.output()).not.toContain("my own edit");
  } finally { await made.app.close(); }
}, 30_000);

for (const operation of ["commit", "amend", "cherry-pick"] as const) test(`a task's ${operation} keeps its changed files on the receipt and in Undo`, async () => {
  const place = await folder({ git: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: place.project,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
  let picked = "";
  if (operation === "cherry-pick") {
    const base = git("rev-parse", "HEAD");
    git("switch", "-qc", "pick-source");
    await writeFile(path.join(place.project, "notes.py"), "print('two')\n");
    await writeFile(path.join(place.project, "new.py"), "new = True\n");
    git("add", "."); git("commit", "-qm", "picked change");
    picked = git("rev-parse", "HEAD");
    git("switch", "-qc", "task", base);
  }
  const made = makeApp(place, [async (project) => {
    if (operation === "cherry-pick") git("cherry-pick", picked);
    else {
      await writeFile(path.join(project, "notes.py"), "print('two')\n");
      await writeFile(path.join(project, "new.py"), "new = True\n");
      git("add", ".");
      git("commit", ...(operation === "amend" ? ["--amend", "--no-edit"] : ["-qm", "task change"]));
    }
  }]);
  try {
    await made.app.runOnce("fix the task files", place.project);
    expect(made.app.getLastTaskResult()!.changedPaths).toEqual(["new.py", "notes.py"]);
    expect(made.app.getLastTaskResult()!.branchMoved).not.toBe(true);
    expect(receiptEvent(undefined, made.app.getLastTaskResult()!, 0).changed).toEqual(["new.py", "notes.py"]);
    await made.app.runOnce("/receipt 1", place.project);
    expect(made.output()).toContain("new.py");
    await made.app.runOnce("/diff 1", place.project);
    expect(made.output()).toContain("+print('two')");
    const head = git("rev-parse", "HEAD");
    await made.app.runOnce("/undo 1", place.project);
    expect(await readFile(path.join(place.project, "notes.py"), "utf8")).toBe("print('one')\n");
    expect(await readdir(place.project)).not.toContain("new.py");
    expect(git("rev-parse", "HEAD")).toBe(head); // Undo restores files, never rewrites commits.
  } finally { await made.app.close(); }
}, 30_000);

for (const commitRestoration of [false, true]) test(`task-committed files restored to starting bytes still count (restoration committed: ${commitRestoration})`, async () => {
  const place = await folder({ git: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: place.project,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
  const made = makeApp(place, [async (project) => {
    await writeFile(path.join(project, "notes.py"), "print('two')\n");
    await writeFile(path.join(project, "new.py"), "new = True\n");
    git("add", "."); git("commit", "-qm", "task change");
    await writeFile(path.join(project, "notes.py"), "print('one')\n");
    await rm(path.join(project, "new.py"));
    if (commitRestoration) { git("add", "."); git("commit", "-qm", "restore starting bytes"); }
  }]);
  try {
    await made.app.runOnce("change the task files", place.project);
    const task = made.app.getLastTaskResult()!;
    expect(task.changedPaths).toEqual(["new.py", "notes.py"]);
    expect(receiptEvent(undefined, task, 0).changed).toEqual(["new.py", "notes.py"]);
    expect(task.undo).toEqual({ available: false, reason: "no files changed" });
    expect(task.branchMoved).not.toBe(true);
    const from = made.output().length;
    await made.app.runOnce("/receipt 1", place.project);
    expect(made.output().slice(from)).toContain("new.py");
    expect(made.output().slice(from)).toContain("notes.py");
    expect(await readFile(path.join(place.project, "notes.py"), "utf8")).toBe("print('one')\n");
  } finally { await made.app.close(); }
}, 30_000);

for (const restoreStart of [false, true]) test(`a task commit then a nonconflicting same-file merge remains counted and blocked from Undo (restored: ${restoreStart})`, async () => {
  const place = await folder({ git: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: place.project,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
  const original = "task = 0\n\nunchanged = 0\n\nincoming = 0\n";
  await writeFile(path.join(place.project, "notes.py"), original);
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("switch", "-qc", "incoming");
  await writeFile(path.join(place.project, "notes.py"), original.replace("incoming = 0", "incoming = 1"));
  git("add", "."); git("commit", "-qm", "incoming change");
  git("switch", "-qc", "task", base);
  const combined = original.replace("task = 0", "task = 1").replace("incoming = 0", "incoming = 1");
  const made = makeApp(place, [async (project) => {
    await writeFile(path.join(project, "notes.py"), original.replace("task = 0", "task = 1"));
    await writeFile(path.join(project, "other.py"), "x = 2\n");
    git("add", "."); git("commit", "-qm", "task change");
    git("merge", "--no-edit", "incoming");
    expect(await readFile(path.join(project, "notes.py"), "utf8")).toBe(combined);
    if (restoreStart) await writeFile(path.join(project, "notes.py"), original);
  }]);
  try {
    await made.app.runOnce("fix the task files", place.project);
    const task = made.app.getLastTaskResult()!;
    expect(task.changedPaths).toEqual(["notes.py", "other.py"]);
    expect(receiptEvent(undefined, task, 0).changed).toEqual(["notes.py", "other.py"]);
    expect(task.undo).toMatchObject({ available: true, left: [{ path: "notes.py", why: "git and the task both changed it; Casper cannot safely separate them" }] });
    const head = git("rev-parse", "HEAD");
    await made.app.runOnce("/receipt 1", place.project);
    expect(made.output()).toContain("notes.py");
    await made.app.runOnce("/undo 1", place.project);
    expect(await readFile(path.join(place.project, "notes.py"), "utf8")).toBe(restoreStart ? original : combined);
    expect(await readFile(path.join(place.project, "other.py"), "utf8")).toBe("x = 1\n");
    expect(made.output()).toContain("notes.py (git and the task both changed it; Casper cannot safely separate them)");
    await made.app.runOnce("/redo 1", place.project);
    expect(await readFile(path.join(place.project, "notes.py"), "utf8")).toBe(restoreStart ? original : combined);
    expect(await readFile(path.join(place.project, "other.py"), "utf8")).toBe("x = 2\n");
    expect(git("rev-parse", "HEAD")).toBe(head);
  } finally { await made.app.close(); }
}, 30_000);

const branchMoveLine = "– The branch moved during this task: changes git brought in are not counted, and undo leaves them alone";

async function movingTask(kind: "fast-forward" | "rebase", options: { count?: number; overlap?: boolean; missingHead?: boolean; restoreStart?: boolean; move?: "merge" | "pull" | "checkout" | "reset" | "switch"; crlf?: boolean } = {}) {
  const place = await folder({ git: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: place.project, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim();
  const count = options.count ?? 1;
  for (let i = 0; i < count; i++) await writeFile(path.join(place.project, `a${i}.ts`), "before\n");
  await writeFile(path.join(place.project, "removed.ts"), "old committed file\n");
  await writeFile(path.join(place.project, "b0.ts"), "old committed file\n");
  git("add", "."); git("commit", "-qm", "base");
  // As on a Windows machine: git writes text it checks out with CR LF.
  git("config", "core.autocrlf", options.crlf ? "true" : "false");
  const base = git("rev-parse", "HEAD");
  git("switch", "-qc", "incoming");
  for (let i = 0; i < (count === 17 ? 40 : 2); i++) await writeFile(path.join(place.project, `b${i}.ts`), "incoming\n");
  if (options.overlap) await writeFile(path.join(place.project, "a0.ts"), "incoming\n");
  git("rm", "-q", "removed.ts");
  git("add", "."); git("commit", "-qm", "incoming");
  git("switch", "-qc", "task", base);
  if (kind === "rebase") {
    await writeFile(path.join(place.project, "local.ts"), "earlier commit\n");
    git("add", "."); git("commit", "-qm", "earlier task");
  }
  const made = makeApp(place, [async (project) => {
    for (let i = 0; i < count; i++) await writeFile(path.join(project, `a${i}.ts`), "task edit\n");
    // An overlapping edit is reapplied after git, as a conflict resolution or a later edit would be.
    if (options.overlap) git("stash", "push", "-qm", "pending edit");
    if (options.move === "reset") {
      git("reset", "--hard", "incoming");
      for (let i = 0; i < count; i++) await writeFile(path.join(project, `a${i}.ts`), "task edit\n");
    } else if (options.move === "checkout" || options.move === "switch") git(options.move, "incoming");
    else if (options.move === "merge") git("merge", "--no-ff", "--no-edit", "incoming");
    else if (options.move === "pull") git("pull", "--ff-only", ".", "incoming");
    else if (kind === "rebase") git("rebase", "--autostash", "incoming");
    else git("merge", "--ff-only", "incoming");
    if (options.overlap) {
      for (let i = 0; i < count; i++) await writeFile(path.join(project, `a${i}.ts`), i === 0 ? "incoming\ntask edit\n" : "task edit\n");
    }
    if (options.restoreStart) await writeFile(path.join(project, "a0.ts"), "before\n");
    if (options.missingHead) git("update-ref", "-d", "refs/heads/task");
  }]);
  try { await made.app.runOnce("fix the task files", place.project); }
  catch (error) { await made.app.close(); throw error; }
  return { ...made, place, git };
}

test("mid-task rebase counts 17 task files, not the 58-file folder delta", async () => {
  const made = await movingTask("rebase", { count: 17 });
  try {
    expect(made.app.getLastTaskResult()!.changedPaths).toEqual(Array.from({ length: 17 }, (_, i) => `a${i}.ts`).sort());
    expect(made.output()).toContain("17 files changed");
    expect(made.output()).not.toContain("58 files changed");
  } finally { await made.app.close(); }
}, 30_000);

test("/diff after rebase shows the task patch, not another PR's incoming files", async () => {
  const made = await movingTask("rebase");
  try {
    await made.app.runOnce("/diff 1", made.place.project);
    expect(made.output()).toContain("+task edit");
    expect(made.output()).not.toContain("diff --git a/b0.ts");
    expect(made.output()).not.toContain("+incoming");
  } finally { await made.app.close(); }
}, 30_000);

for (const kind of ["fast-forward", "rebase"] as const) test(`Undo after ${kind} restores only the task file and preserves incoming committed files`, async () => {
  const made = await movingTask(kind);
  try {
    expect(made.app.getLastTaskResult()!.changedPaths).toEqual(["a0.ts"]);
    expect(made.output()).toContain("✓ changed a0.ts\n");
    await made.app.runOnce("/diff 1", made.place.project);
    expect(made.output()).toContain("+task edit");
    expect(made.output()).not.toContain("+incoming");
    await made.app.runOnce("/undo 1", made.place.project);
    expect(await readFile(path.join(made.place.project, "a0.ts"), "utf8")).toBe("before\n");
    for (let i = 0; i < 2; i++) expect(await readFile(path.join(made.place.project, `b${i}.ts`), "utf8")).toBe("incoming\n");
    expect(await readdir(made.place.project)).not.toContain("removed.ts");
    await made.app.runOnce("/redo 1", made.place.project);
    expect(await readFile(path.join(made.place.project, "a0.ts"), "utf8")).toBe("task edit\n");
    expect(await readFile(path.join(made.place.project, "b0.ts"), "utf8")).toBe("incoming\n");
  } finally { await made.app.close(); }
}, 30_000);

test("a file changed by both git and the task counts, diffs against new HEAD, and Undo leaves it with a reason", async () => {
  const made = await movingTask("fast-forward", { overlap: true, count: 2 });
  try {
    expect(made.app.getLastTaskResult()!.changedPaths).toEqual(["a0.ts", "a1.ts"]);
    await made.app.runOnce("/diff 1", made.place.project);
    const patch = made.output().slice(made.output().indexOf("Changes in task 1"));
    expect(patch).toContain("+task edit");
    expect(patch).not.toContain("+incoming");
    await made.app.runOnce("/undo 1", made.place.project);
    expect(await readFile(path.join(made.place.project, "a0.ts"), "utf8")).toBe("incoming\ntask edit\n");
    expect(await readFile(path.join(made.place.project, "a1.ts"), "utf8")).toBe("before\n");
    expect(made.output()).toContain("a0.ts (git and the task both changed it; Casper cannot safely separate them)");
  } finally { await made.app.close(); }
}, 30_000);

test("Undo refuses rather than guessing when the ending HEAD cannot be compared", async () => {
  const made = await movingTask("fast-forward", { missingHead: true });
  try {
    expect(made.output().split("The branch moved during this task")).toHaveLength(2);
    const undo = made.app.getLastTaskResult()!.undo!;
    expect(undo.available).toBe(false);
    if (!undo.available) expect(undo.reason).toContain("cannot separate the task's edits from git's changes");
    await expect(made.app.runOnce("/undo 1", made.place.project)).rejects.toThrow("cannot separate the task's edits from git's changes");
    expect(await readFile(path.join(made.place.project, "a0.ts"), "utf8")).toBe("task edit\n");
    expect(await readFile(path.join(made.place.project, "b0.ts"), "utf8")).toBe("incoming\n");
  } finally { await made.app.close(); }
}, 30_000);

test("a moved branch adds one plain receipt line, including the saved receipt", async () => {
  const made = await movingTask("fast-forward");
  try {
    expect(made.output().split(branchMoveLine)).toHaveLength(2);
    const start = made.output().length;
    await made.app.runOnce("/receipt 1", made.place.project);
    expect(made.output().slice(start).split(branchMoveLine)).toHaveLength(2);
  } finally { await made.app.close(); }
}, 30_000);

for (const move of ["merge", "pull", "checkout", "reset", "switch"] as const) test(`${move} during a task excludes incoming changes from receipt, diff, and Undo`, async () => {
  const made = await movingTask("fast-forward", { move });
  try {
    expect(made.app.getLastTaskResult()!.changedPaths).toEqual(["a0.ts"]);
    expect(made.output()).toContain(branchMoveLine);
    await made.app.runOnce("/diff 1", made.place.project);
    expect(made.output()).toContain("+task edit");
    expect(made.output()).not.toContain("diff --git a/b0.ts");
    await made.app.runOnce("/undo 1", made.place.project);
    expect(await readFile(path.join(made.place.project, "b0.ts"), "utf8")).toBe("incoming\n");
    expect(await readFile(path.join(made.place.project, "a0.ts"), "utf8")).toBe("before\n");
  } finally { await made.app.close(); }
}, 30_000);

test("with Windows line endings (core.autocrlf), files git brought in are still git's: not counted, and Undo leaves them", async () => {
  const made = await movingTask("fast-forward", { crlf: true });
  try {
    expect(await readFile(path.join(made.place.project, "b0.ts"), "utf8")).toBe("incoming\r\n");
    expect(made.app.getLastTaskResult()!.changedPaths).toEqual(["a0.ts"]);
    expect(made.output()).not.toContain("git and the task both changed it");
    await made.app.runOnce("/undo 1", made.place.project);
    expect(made.output()).not.toContain("git and the task both changed it");
    expect(await readFile(path.join(made.place.project, "b0.ts"), "utf8")).toBe("incoming\r\n");
    expect(await readFile(path.join(made.place.project, "a0.ts"), "utf8")).toBe("before\n");
  } finally { await made.app.close(); }
}, 30_000);

test("an overlap restored to its starting bytes still counts and diffs against new HEAD", async () => {
  const made = await movingTask("fast-forward", { overlap: true, restoreStart: true });
  try {
    expect(made.app.getLastTaskResult()!.changedPaths).toEqual(["a0.ts"]);
    await made.app.runOnce("/diff 1", made.place.project);
    expect(made.output()).toContain("-incoming\n+before");
    await made.app.runOnce("/undo 1", made.place.project);
    expect(made.output()).toContain("git and the task both changed it; Casper cannot safely separate them");
    expect(await readFile(path.join(made.place.project, "a0.ts"), "utf8")).toBe("before\n");
  } finally { await made.app.close(); }
}, 30_000);

/** Text as git stores it: a Windows checkout writes CR LF (core.autocrlf), which is still the same file. */
const lf = (text: string) => text.replace(/\r\n/g, "\n");

async function olderTaskIncoming(redo = false, failCopy = false, moveAgain = false) {
  const place = await folder({ git: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: place.project }).toString().trim();
  if (redo) {
    await writeFile(path.join(place.project, "notes.py"), "print('zero')\n");
    git("add", "."); git("commit", "-qm", "earlier committed greeting");
  }
  const base = git("rev-parse", "HEAD");
  git("switch", "-qc", "incoming");
  if (moveAgain) await writeFile(path.join(place.project, "other.py"), "incoming\n");
  else await writeFile(path.join(place.project, "notes.py"), redo ? "print('one')\n" : "print('two')\n");
  git("add", "."); git("commit", "-qm", "incoming greeting");
  git("switch", "-qc", "task", base);
  if (redo) await writeFile(path.join(place.project, "notes.py"), "print('one')\n");
  const snapshot = UndoStore.prototype.snapshot;
  const made = makeApp(place, [edit("notes.py", "print('two')\n"), async (project) => {
    // Git now brings in exactly the bytes the earlier task wrote.
    git("stash", "push", "-qm", "earlier task edit");
    git("merge", "--ff-only", "incoming");
    await writeFile(path.join(project, "a.ts"), "task\n");
    if (failCopy) UndoStore.prototype.snapshot = async () => ({ unavailable: "the ending copy could not be saved" });
    if (moveAgain) UndoStore.prototype.snapshot = async function (signal) {
      await writeFile(path.join(project, "notes.py"), "print('two')\n");
      git("add", "notes.py"); git("commit", "-qm", "second incoming change");
      return snapshot.call(this, signal);
    };
  }]);
  try {
    await made.app.runOnce("fix notes.py", place.project);
    if (redo) await made.app.runOnce("/undo 1", place.project);
    await made.app.runOnce("add a.ts", place.project);
  } catch (error) { await made.app.close(); throw error; }
  finally { UndoStore.prototype.snapshot = snapshot; }
  return { ...made, place };
}

test("explicit Undo of an older task leaves bytes a later task brought in from git", async () => {
  const made = await olderTaskIncoming();
  try {
    await made.app.runOnce("/undo 1", made.place.project);
    expect(lf(await readFile(path.join(made.place.project, "notes.py"), "utf8"))).toBe("print('two')\n");
    expect(made.output()).toContain("git brought it in during a later task; Casper left it alone");
  } finally { await made.app.close(); }
}, 30_000);

test("incoming protection survives a later task's failed ending snapshot", async () => {
  const made = await olderTaskIncoming(false, true);
  try {
    expect(made.app.getLastTaskResult()!.undo?.available).toBe(false);
    await made.app.runOnce("/undo 1", made.place.project);
    expect(lf(await readFile(path.join(made.place.project, "notes.py"), "utf8"))).toBe("print('two')\n");
    expect(made.output()).toContain("git brought it in during a later task; Casper left it alone");
  } finally { await made.app.close(); }
}, 30_000);

test("a second branch movement during the ending snapshot makes older Undo refuse", async () => {
  const made = await olderTaskIncoming(false, false, true);
  try {
    expect(made.app.getLastTaskResult()!.undo?.available).toBe(false);
    await expect(made.app.runOnce("/undo 1", made.place.project)).rejects.toThrow("a later task's branch changes cannot be read");
    expect(lf(await readFile(path.join(made.place.project, "notes.py"), "utf8"))).toBe("print('two')\n");
  } finally { await made.app.close(); }
}, 30_000);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("receipt enumeration failure makes older Undo refuse rather than guess", async () => {
  const made = await olderTaskIncoming();
  const stateRoot = path.join(made.place.home, ".casper", "projects");
  const [state] = await readdir(stateRoot);
  const receipts = path.join(stateRoot, state!, "receipts");
  try {
    await chmod(receipts, 0o300); // Files are still searchable by name, but the directory cannot be listed.
    await expect(made.app.runOnce("/undo 1", made.place.project)).rejects.toThrow("saved branch changes cannot be read");
    expect(lf(await readFile(path.join(made.place.project, "notes.py"), "utf8"))).toBe("print('two')\n");
  } finally { await chmod(receipts, 0o700); await made.app.close(); }
}, 30_000);

test("an unreadable later receipt makes older Undo refuse rather than guess", async () => {
  const made = await olderTaskIncoming();
  try {
    const stateRoot = path.join(made.place.home, ".casper", "projects");
    const [state] = await readdir(stateRoot);
    await writeFile(path.join(stateRoot, state!, "receipts", "2.json"), "unreadable");
    await expect(made.app.runOnce("/undo 1", made.place.project)).rejects.toThrow("a later task's branch changes cannot be read");
    expect(lf(await readFile(path.join(made.place.project, "notes.py"), "utf8"))).toBe("print('two')\n");
  } finally { await made.app.close(); }
}, 30_000);

test("Redo of an older task leaves bytes a later task brought in from git", async () => {
  const made = await olderTaskIncoming(true);
  try {
    await made.app.runOnce("/redo 1", made.place.project);
    expect(lf(await readFile(path.join(made.place.project, "notes.py"), "utf8"))).toBe("print('one')\n");
    expect(made.output()).toContain("git brought it in during a later task; Casper left it alone");
  } finally { await made.app.close(); }
}, 30_000);

test("rewinding older tasks cannot undo bytes that a later task brought in from git", async () => {
  const made = await olderTaskIncoming();
  const { place } = made;
  try {
    const tasks = await made.app.taskUndo.tasksAfter("conversation-1", () => true);
    await made.app.taskUndo.undoTasks(tasks.sort((a, b) => b.n - a.n));
    expect(lf(await readFile(path.join(place.project, "notes.py"), "utf8"))).toBe("print('two')\n");
    expect(await readdir(place.project)).not.toContain("a.ts");
    expect(made.output()).toContain("git brought it in during a later task; Casper left it alone");
  } finally { await made.app.close(); }
}, 30_000);

for (const kind of ["undo", "redo"] as const) test(`setting ${kind} leaves a settings file that a later task brought in from git`, async () => {
  const place = await folder({ git: true });
  place.project = await realpath(place.project); // The fake session and pre-session setting receipt use the same root.
  const file = ".casper/project.yaml";
  await mkdir(path.join(place.project, ".casper"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: place.project }).toString().trim();
  await writeFile(path.join(place.project, file), kind === "redo" ? "# zero\n" : "# one\n");
  git("add", "."); git("commit", "-qm", "base setting");
  const base = git("rev-parse", "HEAD");
  git("switch", "-qc", "incoming");
  const incoming = kind === "redo" ? "# one\n" : "# two\n";
  await writeFile(path.join(place.project, file), incoming);
  git("add", "."); git("commit", "-qm", "incoming setting");
  git("switch", "-qc", "task", base);
  await writeFile(path.join(place.project, file), "# one\n");
  const made = makeApp(place, [async (project) => {
    git("stash", "push", "-qm", "earlier setting");
    git("merge", "--ff-only", "incoming");
    await writeFile(path.join(project, "a.ts"), "task\n");
  }]);
  try {
    await made.app.start(place.project);
    const n = await made.app.taskUndo.recordSetting(made.app.activeWorkspaceRoot(), "remember a setting", { file, line: "setting", before: "# one\n", after: "# two\n" });
    expect(n).toBe(1);
    await writeFile(path.join(place.project, file), "# two\n");
    if (kind === "redo") await made.app.runOnce("/undo 1", place.project);
    await made.app.runOnce("add a.ts", place.project);
    await expect(made.app.runOnce(`/${kind} 1`, place.project)).rejects.toThrow("git brought .casper/project.yaml in during a later task");
    expect(lf(await readFile(path.join(place.project, file), "utf8"))).toBe(incoming);
  } finally { await made.app.close(); }
}, 30_000);

test("branch-movement rules are documented for Undo, receipts, and the unreleased roadmap", async () => {
  const undo = await readFile(new URL("../docs/UNDO.md", import.meta.url), "utf8");
  const verification = await readFile(new URL("../docs/VERIFICATION.md", import.meta.url), "utf8");
  const release = await readFile(new URL("../docs/RELEASE.md", import.meta.url), "utf8");
  const site = await readFile(new URL("../site/roadmap.html", import.meta.url), "utf8");
  expect(undo).toContain("**Leave git's incoming changes alone.**");
  expect(undo).toContain("Undo refuses rather than guessing");
  expect(verification).toContain(branchMoveLine);
  expect(release).toContain("### Task-only receipts after branch movement");
  expect(release.indexOf("### Task-only receipts after branch movement")).toBeLessThan(release.indexOf("## v0.2.34:"));
  expect(site.slice(site.indexOf('id="v0235"'), site.indexOf('id="v0234"'))).toContain("Undo leaves git's incoming changes alone");
});

test("switching branches at the same HEAD still adds the receipt line without claiming files", async () => {
  const place = await folder({ git: true });
  const made = makeApp(place, [async (project) => { execFileSync("git", ["switch", "-qc", "another-branch"], { cwd: project }); }]);
  try {
    await made.app.runOnce("switch to another branch", place.project);
    expect(made.app.getLastTaskResult()!.changedPaths).toEqual([]);
    expect(made.output().split(branchMoveLine)).toHaveLength(2);
    await made.app.runOnce("/diff 1", place.project);
    expect(made.output()).toContain("No changes in task 1.");
    await expect(made.app.runOnce("/undo 1", place.project)).rejects.toThrow("nothing to undo");
  } finally { await made.app.close(); }
}, 30_000);

test("a normal task with no edits and no HEAD movement still has no receipt", async () => {
  const place = await folder({ git: true });
  const made = makeApp(place, [async () => {}]);
  try {
    await made.app.runOnce("explain notes.py", place.project);
    expect(made.app.getLastTaskResult()!.changedPaths).toEqual([]);
    expect(made.app.getLastTaskResult()!.receipt).toBeUndefined();
    expect(made.output()).not.toContain("branch moved");
    expect(made.output()).not.toContain("Undo:");
  } finally { await made.app.close(); }
}, 30_000);

test("a normal git task keeps its receipt, diff, and Undo without a branch-moved line", async () => {
  const place = await folder({ git: true });
  const made = makeApp(place, [edit("notes.py", "print('two')\n")]);
  try {
    await made.app.runOnce("fix notes.py", place.project);
    expect(made.app.getLastTaskResult()!.changedPaths).toEqual(["notes.py"]);
    expect(made.output()).toContain("✓ changed notes.py\n");
    expect(made.output()).not.toContain("branch moved");
    await made.app.runOnce("/diff 1", place.project);
    expect(made.output()).toContain("-print('one')\n+print('two')");
    await made.app.runOnce("/undo 1", place.project);
    expect(await readFile(path.join(place.project, "notes.py"), "utf8")).toBe("print('one')\n");
  } finally { await made.app.close(); }
}, 30_000);

test("undo rewinds the conversation when nothing was said since; after a later request it keeps it and tells the model", async () => {
  const place = await folder();
  const s = session(place, [edit("notes.py", "print('two')\n"), edit("b.py", "b = 1\n")]);
  try {
    expect(await s.send("fix the greeting in notes.py")).toContain("Next: 1 Show diff · 2 Undo");
    const undone = await s.send("/undo");
    expect(undone).toContain("✓ Undone — 1 file is back as it was before task 1: notes.py\n– Conversation rewound to before task 1.\nNext: 2 Redo\n");
    expect(s.rewinds).toEqual([[null, "turn-0"]]);
    await s.send("add b.py");
    await s.send("what does notes.py do?");
    const kept = await s.send("/undo 2");
    expect(kept).toContain("– Conversation kept — you've talked since, so Casper told the model the files were put back.");
    expect(s.rewinds).toHaveLength(1);
    expect(s.notes).toEqual(["The user undid task 2. These files are back as they were before it: b.py."]);
    expect(await readdir(place.project)).not.toContain("b.py");
  } finally { await s.close(); }
}, 30_000);

test("redo puts the task's files back; a second undo says it is already undone", async () => {
  const place = await folder();
  const s = session(place, [edit("notes.py", "print('two')\n")]);
  try {
    await s.send("fix the greeting in notes.py");
    await s.send("/undo");
    expect(await s.send("/undo 1")).toContain("Task 1 is already undone. 2 Redo\nNext: 2 Redo\n");
    const redone = await s.send("2");
    expect(redone).toContain("✓ Redone — 1 file is back as task 1 left it: notes.py");
    expect(await readFile(path.join(place.project, "notes.py"), "utf8")).toBe("print('two')\n");
    expect(await s.send("/redo 1")).toContain("Task 1 is not undone, so there is nothing to redo.");
  } finally { await s.close(); }
}, 30_000);

test("the row under the receipt does nothing on Enter; only the typed number runs Undo", async () => {
  const place = await folder();
  const s = session(place, [edit("notes.py", "print('two')\n")]);
  try {
    expect(await s.send("fix the greeting in notes.py")).toContain("Next: 1 Show diff · 2 Undo\n");
    // Enter on the empty prompt: nothing runs, and the row is used up.
    const from = s.output().length;
    s.input.write("\n");
    await s.send("/status");
    expect(s.output().slice(from)).not.toContain("Undone");
    expect(await readFile(path.join(place.project, "notes.py"), "utf8")).toBe("print('two')\n");
    // A lone number typed later is an ordinary line, not a pick from a row that is gone.
    expect(await s.send("/undo 1")).toContain("✓ Undone");
  } finally { await s.close(); }
}, 30_000);

test("a file you changed after the task: Enter at the question keeps everything; 2 undoes the other files", async () => {
  const place = await folder();
  const s = session(place, [async (project) => { await writeFile(path.join(project, "notes.py"), "print('two')\n"); await writeFile(path.join(project, "a.py"), "a = 1\n"); }]);
  try {
    await s.send("fix the greeting in notes.py and add a.py");
    await writeFile(path.join(place.project, "notes.py"), "print('mine')\n");
    const asked = await s.send("/undo", /Type 1 or 2: $/);
    expect(asked).toContain("notes.py changed after task 1.\n  1 Cancel · nothing is changed\n  2 Undo the other 1 file · the files you changed since stay as they are\n");
    expect(await s.send("")).toContain("Nothing was changed.");
    expect(await readdir(place.project)).toContain("a.py");
    await s.send("/undo", /Type 1 or 2: $/);
    const partial = await s.send("2");
    expect(partial).toContain("✓ Undone — 1 file is back as it was before task 1: a.py\n– Left as you changed them: notes.py");
    expect(await readFile(path.join(place.project, "notes.py"), "utf8")).toBe("print('mine')\n");
    expect(await readdir(place.project)).not.toContain("a.py");
  } finally { await s.close(); }
}, 30_000);

test("one-shot: a file changed after the task makes /undo change nothing and fail", async () => {
  const place = await folder();
  const first = makeApp(place, [edit("notes.py", "print('two')\n")]);
  try { await first.app.runOnce("fix the greeting", place.project); } finally { await first.app.close(); }
  await writeFile(path.join(place.project, "notes.py"), "print('mine')\n");
  const later = makeApp(place, []);
  try {
    await expect(later.app.runOnce("/undo", place.project)).rejects.toThrow("notes.py changed after task 1, so Casper left everything as it is.");
    expect(await readFile(path.join(place.project, "notes.py"), "utf8")).toBe("print('mine')\n");
    await expect(later.app.runOnce("/undo 7", place.project)).rejects.toThrow("No receipt 7. /receipt list shows recent ones.");
  } finally { await later.app.close(); }
}, 30_000);

test("one-shot: /diff, /receipt and /undo with a task that doesn't exist, or a bad number, fail (exit 1) instead of passing", async () => {
  const place = await folder();
  const first = makeApp(place, [edit("notes.py", "print('two')\n")]);
  try { await first.app.runOnce("fix the greeting", place.project); } finally { await first.app.close(); }
  const later = makeApp(place, []);
  try {
    await expect(later.app.runOnce("/diff 7", place.project)).rejects.toThrow("No receipt 7. /receipt list shows recent ones.");
    await expect(later.app.runOnce("/receipt 7", place.project)).rejects.toThrow("No receipt 7. /receipt list shows recent ones.");
    await expect(later.app.runOnce("/diff x", place.project)).rejects.toThrow("Usage: /diff [task number | list]");
    await expect(later.app.runOnce("/receipt x", place.project)).rejects.toThrow("Usage: /receipt [task number | list]");
    await expect(later.app.runOnce("/undo x", place.project)).rejects.toThrow("Usage: /undo [task number]");
    await later.app.runOnce("/diff 1", place.project);
  } finally { await later.app.close(); }
}, 30_000);

test("nothing to undo yet is said plainly", async () => {
  const place = await folder();
  const s = session(place, []);
  try { expect(await s.send("/undo")).toContain("Nothing to undo in this folder yet."); }
  finally { await s.close(); }
}, 30_000);

test("receipts are kept across restarts, with no check output and secrets hidden", async () => {
  const place = await folder();
  const first = makeApp(place, [edit("notes.py", "print('two')\n")]);
  try { await first.app.runOnce("fix notes.py with token ghp_abcdefghijklmnopqrstuvwxyz0123456789", place.project); } finally { await first.app.close(); }
  const later = makeApp(place, []);
  try {
    await later.app.runOnce("/receipt 1", place.project);
    expect(later.output()).toMatch(/Task 1 · \d\d:\d\d · fix notes\.py with token <redacted>\n– Not checked — no tests yet/);
    await later.app.runOnce("/receipt list", place.project);
    expect(later.output()).toMatch(/ {2}1 {2}\d\d:\d\d {2}– Not checked — no tests yet/);
    await expect(later.app.runOnce("/receipt 9", place.project)).rejects.toThrow("No receipt 9. /receipt list shows recent ones.");
    const stateRoot = path.join(place.home, ".casper", "projects");
    const [projectState] = await readdir(stateRoot);
    const saved = await readFile(path.join(stateRoot, projectState!, "receipts", "1.json"), "utf8");
    expect(saved).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(saved).toContain("<redacted>");
    if (process.platform !== "win32") expect((await stat(path.join(stateRoot, projectState!, "receipts", "1.json"))).mode & 0o777).toBe(0o600);
  } finally { await later.app.close(); }
}, 30_000);

posixOnly("with git missing, the receipt says undo is not available and why", async () => {
  const place = await folder();
  const made = makeApp(place, [edit("notes.py", "print('two')\n")]);
  const saved = process.env.PATH;
  try {
    await made.app.start(place.project);
    process.env.PATH = path.join(place.root, "no-git-here");
    await made.app.runOnce("fix the greeting", place.project);
    expect(made.output()).toContain("– Undo not available: git is not installed\n");
    expect(made.output()).not.toContain("Undo: casper");
  } finally { process.env.PATH = saved; await made.app.close(); }
}, 30_000);

test("a file git ignored before the task is never deleted by undo, even when the task stopped ignoring it", async () => {
  const place = await folder();
  await writeFile(path.join(place.project, ".gitignore"), "local.cfg\n");
  await writeFile(path.join(place.project, "local.cfg"), "my own settings\n");
  const first = makeApp(place, [edit(".gitignore", "# nothing ignored\n")]);
  try {
    await first.app.runOnce("stop ignoring files", place.project);
    // The receipt names the task's own file; local.cfg was there before, so it is named as one undo can't reach.
    expect(first.output()).toContain("✓ changed .gitignore\n");
    expect(first.output()).not.toContain("local.cfg |");
    expect(first.output()).toContain("– Undo can't put back: local.cfg (it was there before the task, but git ignored it then, so Casper has no copy)");
  } finally { await first.app.close(); }
  const later = makeApp(place, []);
  try {
    await later.app.runOnce("/undo", place.project);
    expect(later.output()).toContain("✓ Undone — 1 file is back as it was before task 1: .gitignore\n");
    expect(await readFile(path.join(place.project, "local.cfg"), "utf8")).toBe("my own settings\n");
    expect(await readFile(path.join(place.project, ".gitignore"), "utf8")).toBe("local.cfg\n");
  } finally { await later.app.close(); }
}, 30_000);

test("a file over 8 MB before the task is never deleted by undo when the task made it small", async () => {
  const place = await folder();
  await writeFile(path.join(place.project, "capture.pcap"), Buffer.alloc(8 * 1024 * 1024 + 1, 7));
  const first = makeApp(place, [async (project) => { await writeFile(path.join(project, "capture.pcap"), "trimmed\n"); await writeFile(path.join(project, "notes.py"), "print('two')\n"); }]);
  try {
    await first.app.runOnce("trim the capture", place.project);
    expect(first.output()).toContain("– Undo can't put back: capture.pcap (over 8 MB)");
  } finally { await first.app.close(); }
  const later = makeApp(place, []);
  try {
    await later.app.runOnce("/undo", place.project);
    expect(later.output()).toContain("✓ Undone — 1 file is back as it was before task 1: notes.py\n");
    expect(await readFile(path.join(place.project, "capture.pcap"), "utf8")).toBe("trimmed\n");
  } finally { await later.app.close(); }
}, 30_000);

test("files the task's tools edited that git ignores are named on the receipt as ones undo can't put back", async () => {
  const place = await folder();
  await writeFile(path.join(place.project, ".gitignore"), "dist/\n.env\n");
  const first = makeApp(place, [async (project, edited) => {
    await mkdir(path.join(project, "dist"), { recursive: true });
    await writeFile(path.join(project, "dist", "app.js"), "built\n"); await edited("dist/app.js");
    await writeFile(path.join(project, ".env"), "TOKEN=abc\n"); await edited(path.join(project, ".env"));
    await writeFile(path.join(project, "notes.py"), "print('two')\n"); await edited("notes.py");
  }, async (project, edited) => {
    await writeFile(path.join(project, "dist", "app.js"), "built again\n"); await edited("dist/app.js");
    await writeFile(path.join(project, "notes.py"), "print('three')\n"); await edited("notes.py");
  }]);
  try {
    await first.app.runOnce("build it", place.project);
    expect(first.output()).toContain("– Undo can't put back: .env (Casper keeps no copy of secret files), dist/app.js (git ignores it, so Casper keeps no copy)");
    // Named once per session: the next receipt for the same file leaves it out.
    const seen = first.output().length;
    await first.app.runOnce("build it again", place.project);
    expect(first.output().slice(seen)).toContain("✓ changed");
    expect(first.output().slice(seen)).not.toContain("Undo can't put back");
  } finally { await first.app.close(); }
}, 30_000);

test("/status says how much disk the undo copies take, and where", async () => {
  const place = await folder();
  const made = makeApp(place, [edit("notes.py", "print('two')\n")]);
  try {
    await made.app.runOnce("/status", place.project);
    expect(made.output()).toContain(" undo      no copies yet (a copy is made before each task; /undo, /diff)\n");
    await made.app.runOnce("fix the greeting", place.project);
    await made.app.runOnce("/status", place.project);
    expect(made.output()).toMatch(/ undo {6}copies of recent tasks take \d+(?:\.\d)? (?:KB|MB) in ~\/\.casper\/projects\/project-[0-9a-f]+\/undo\.git \(\/undo, \/diff\)\n/);
  } finally { await made.app.close(); }
}, 30_000);

test("one-shot with --cd: the undo command names the task's folder, so it never undoes another project's task", async () => {
  const place = await folder();
  const elsewhere = path.join(place.root, "elsewhere");
  await mkdir(elsewhere);
  const made = makeApp(place, [edit("notes.py", "print('two')\n")]);
  const started = process.cwd();
  try {
    process.chdir(elsewhere);
    await made.app.runOnce("fix the greeting in notes.py", place.project);
    expect(made.output()).toContain(`Undo: casper --cd ${place.project} /undo 1 · Diff: casper --cd ${place.project} /diff 1\n`);
  } finally { process.chdir(started); await made.app.close(); }
}, 30_000);

// cmd and Windows PowerShell never expand ~, and --cd doesn't either, so ~/code/app would be "not a folder".
test.if(process.platform === "win32")("Windows one-shot with --cd: a folder under the home folder is named in full, not as ~/...", async () => {
  const place = await folder();
  const elsewhere = path.join(place.root, "elsewhere");
  await mkdir(elsewhere);
  const started = process.cwd();
  try {
    process.chdir(elsewhere);
    for (const [name, shown] of [["app", (dir: string) => dir], ["My Lab", (dir: string) => `"${dir}"`]] as const) {
      const project = path.join(place.home, "code", name);
      await mkdir(project, { recursive: true });
      await writeFile(path.join(project, "notes.py"), "print('one')\n");
      const made = makeApp({ home: place.home, project }, [edit("notes.py", "print('two')\n")]);
      try {
        await made.app.runOnce("fix the greeting in notes.py", project);
        expect(made.output()).toContain(`Undo: casper --cd ${shown(project)} /undo 1 · Diff: casper --cd ${shown(project)} /diff 1\n`);
      } finally { await made.app.close(); }
    }
  } finally { process.chdir(started); }
}, 30_000);

test("a file the task made over 8 MB is not counted as deleted: undo puts back the other files and leaves it", async () => {
  const place = await folder();
  await writeFile(path.join(place.project, "capture.pcap"), "small\n");
  const first = makeApp(place, [async (project) => {
    await writeFile(path.join(project, "capture.pcap"), Buffer.alloc(8 * 1024 * 1024 + 1, 7));
    await writeFile(path.join(project, "notes.py"), "print('two')\n");
  }]);
  try {
    await first.app.runOnce("grow the capture", place.project);
    expect(first.output()).toContain("– Undo can't put back: capture.pcap (over 8 MB)");
    expect(first.output()).not.toContain("capture.pcap |");
  } finally { await first.app.close(); }
  const later = makeApp(place, []);
  try {
    await later.app.runOnce("/undo", place.project);
    expect(later.output()).toContain("✓ Undone — 1 file is back as it was before task 1: notes.py\n");
    expect((await stat(path.join(place.project, "capture.pcap"))).size).toBe(8 * 1024 * 1024 + 1);
  } finally { await later.app.close(); }
}, 30_000);

test("files in a folder the task made into its own repository are not counted as deleted", async () => {
  const place = await folder();
  await mkdir(path.join(place.project, "lib"));
  await writeFile(path.join(place.project, "lib", "a.py"), "a = 1\n");
  const first = makeApp(place, [async (project) => {
    execFileSync("git", ["init", "-q"], { cwd: path.join(project, "lib") });
    await writeFile(path.join(project, "notes.py"), "print('two')\n");
  }]);
  try {
    await first.app.runOnce("make lib its own repo", place.project);
    expect(first.output()).not.toContain("lib/a.py |");
  } finally { await first.app.close(); }
  const later = makeApp(place, []);
  try {
    await later.app.runOnce("/undo", place.project);
    expect(later.output()).toContain("✓ Undone — 1 file is back as it was before task 1: notes.py\n");
    expect(await readFile(path.join(place.project, "lib", "a.py"), "utf8")).toBe("a = 1\n");
  } finally { await later.app.close(); }
}, 30_000);

test("a file the task changed inside a nested repository is named as one undo can't put back", async () => {
  const place = await folder();
  const lib = path.join(place.project, "lib");
  await mkdir(lib);
  await writeFile(path.join(lib, "a.py"), "a = 1\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: lib, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t"); git("add", "-A"); git("commit", "-qm", "first");
  const nested = "– Undo can't put back: lib/a.py (a nested repository)";
  const first = makeApp(place, [async (project, edited) => {
    await writeFile(path.join(project, "lib", "a.py"), "a = 2\n"); await edited("lib/a.py");
    await writeFile(path.join(project, "notes.py"), "print('two')\n"); await edited("notes.py");
  }]);
  try {
    await first.app.runOnce("change a in lib", place.project);
    expect(first.output()).toContain(nested);
    const seen = first.output().length;
    await first.app.runOnce("/diff 1", place.project);
    expect(first.output().slice(seen)).toContain("+print('two')");
    expect(first.output().slice(seen)).toContain(nested);
  } finally { await first.app.close(); }
  const later = makeApp(place, []);
  try {
    await later.app.runOnce("/undo 1", place.project);
    expect(later.output()).toContain("✓ Undone — 1 file is back as it was before task 1: notes.py\n");
    expect(later.output()).toContain(nested);
    expect(await readFile(path.join(lib, "a.py"), "utf8")).toBe("a = 2\n");
    expect(await readFile(path.join(place.project, "notes.py"), "utf8")).toBe("print('one')\n");
  } finally { await later.app.close(); }
}, 30_000);

test("a nested repository with many changed files (a clone) is named once, so the receipt stays small", async () => {
  const place = await folder();
  const once = (text: string) => {
    expect(text).toContain("– Undo can't put back: vendor/x (a nested repository)\n");
    expect(text.split("(a nested repository)")).toHaveLength(2);
  };
  const first = makeApp(place, [async (project, edited) => {
    const clone = path.join(project, "vendor", "x");
    await mkdir(clone, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: clone });
    for (let index = 0; index < 20; index++) await writeFile(path.join(clone, `part${index}.py`), `n = ${index}\n`);
    await writeFile(path.join(project, "notes.py"), "print('two')\n"); await edited("notes.py");
  }]);
  try {
    await first.app.runOnce("clone x and fix notes", place.project);
    once(first.output());
    const seen = first.output().length;
    await first.app.runOnce("/diff 1", place.project);
    expect(first.output().slice(seen)).toContain("+print('two')");
    once(first.output().slice(seen));
  } finally { await first.app.close(); }
  const stateRoot = path.join(place.home, ".casper", "projects");
  const [projectState] = await readdir(stateRoot);
  const saved = JSON.parse(await readFile(path.join(stateRoot, projectState!, "receipts", "1.json"), "utf8"));
  expect(saved.undo.left).toEqual([{ path: "vendor/x", why: "nested repo" }]);
  expect(saved.task.undo.left).toEqual([{ path: "vendor/x", why: "a nested repository" }]);
  const later = makeApp(place, []);
  try {
    await later.app.runOnce("/undo 1", place.project);
    expect(later.output()).toContain("✓ Undone — 1 file is back as it was before task 1: notes.py\n");
    once(later.output());
    expect(await readFile(path.join(place.project, "vendor", "x", "part0.py"), "utf8")).toBe("n = 0\n");
  } finally { await later.app.close(); }
}, 30_000);

test("an undo that put nothing back (you saved the file while Casper asked) can be tried again later", async () => {
  const place = await folder();
  const s = session(place, [async (project) => { await writeFile(path.join(project, "notes.py"), "print('two')\n"); await writeFile(path.join(project, "a.py"), "a = 1\n"); }]);
  try {
    await s.send("fix the greeting in notes.py and add a.py");
    await writeFile(path.join(place.project, "notes.py"), "print('mine')\n");
    await s.send("/undo", /Type 1 or 2: $/);
    await writeFile(path.join(place.project, "a.py"), "a = 2\n");
    const answered = await s.send("2");
    expect(answered).toContain("– Nothing was put back for task 1.");
    expect(answered).toContain("– Not put back: a.py (it changed just now; Casper left it as it is)");
    expect(answered).not.toContain("Next: 2 Redo");
    await writeFile(path.join(place.project, "a.py"), "a = 1\n");
    await writeFile(path.join(place.project, "notes.py"), "print('two')\n");
    const again = await s.send("/undo 1");
    expect(again).not.toContain("already undone");
    expect(again).toContain("✓ Undone — 2 files are back as they were before task 1: a.py, notes.py");
  } finally { await s.close(); }
}, 30_000);

test("a redo that put nothing back leaves the task undone, so redo can be tried again", async () => {
  const place = await folder();
  const s = session(place, [async (project) => { await writeFile(path.join(project, "notes.py"), "print('two')\n"); await writeFile(path.join(project, "a.py"), "a = 1\n"); }]);
  try {
    await s.send("fix the greeting in notes.py and add a.py");
    await s.send("/undo 1");
    await writeFile(path.join(place.project, "notes.py"), "print('mine')\n");
    await s.send("/redo 1", /Type 1 or 2: $/);
    await writeFile(path.join(place.project, "a.py"), "a = 9\n");
    expect(await s.send("2")).toContain("– Nothing was put back for task 1.");
    await rm(path.join(place.project, "a.py"));
    await writeFile(path.join(place.project, "notes.py"), "print('one')\n");
    expect(await s.send("/redo 1")).toContain("✓ Redone — 2 files are back as task 1 left them: a.py, notes.py");
  } finally { await s.close(); }
}, 30_000);

test("one-shot --json: the receipt after casper /undo names the files it put back, never 'unchanged'", async () => {
  const place = await folder();
  const first = makeApp(place, [edit("notes.py", "print('two')\n")]);
  try { await first.app.runOnce("fix the greeting", place.project); } finally { await first.app.close(); }
  const later = makeApp(place, []);
  try {
    const report = await later.app.runOnce("/undo 1", place.project);
    const task = later.app.getLastTaskResult();
    const event = receiptEvent(report, task, taskExitCode(report, task));
    expect(event.changed).toEqual(["notes.py"]);
    expect(event.outcome).toBe("not_verified");
    expect(event.verdict).toBe("– Not verified — Casper ran no checks");
  } finally { await later.app.close(); }
}, 30_000);
