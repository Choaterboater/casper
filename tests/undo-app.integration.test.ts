import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { receiptEvent } from "../src/app/json-events";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { taskExitCode } from "../src/task/result";
import { posixOnly } from "./support/platform";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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
    const task = first.app.getLastTaskResult()!;
    expect(receiptEvent(undefined, task, taskExitCode(undefined, task))).toMatchObject({ task: 1, undo: { available: true, reason: null } });
  } finally { process.chdir(started); await first.app.close(); }
  const later = makeApp(place, []);
  try {
    await later.app.runOnce("/undo", place.project);
    expect(later.output()).toContain("✓ Undone — 1 file is back as it was before task 1: notes.py\n");
    expect(later.output()).toContain("• The conversation is not changed: only files were put back.");
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

test("undo rewinds the conversation when nothing was said since; after a later request it keeps it and tells the model", async () => {
  const place = await folder();
  const s = session(place, [edit("notes.py", "print('two')\n"), edit("b.py", "b = 1\n")]);
  try {
    expect(await s.send("fix the greeting in notes.py")).toContain("Next: 1 Undo · 2 Show diff");
    const undone = await s.send("/undo");
    expect(undone).toContain("✓ Undone — 1 file is back as it was before task 1: notes.py\n• Conversation rewound to before task 1.\nNext: 1 Redo\n");
    expect(s.rewinds).toEqual([[null, "turn-0"]]);
    await s.send("add b.py");
    await s.send("what does notes.py do?");
    const kept = await s.send("/undo 2");
    expect(kept).toContain("• Conversation kept — you've talked since, so Casper told the model the files were put back.");
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
    expect(await s.send("/undo 1")).toContain("Task 1 is already undone. 1 Redo\nNext: 1 Redo\n");
    const redone = await s.send("1");
    expect(redone).toContain("✓ Redone — 1 file is back as task 1 left it: notes.py");
    expect(await readFile(path.join(place.project, "notes.py"), "utf8")).toBe("print('two')\n");
    expect(await s.send("/redo 1")).toContain("Task 1 is not undone, so there is nothing to redo.");
  } finally { await s.close(); }
}, 30_000);

test("the row under the receipt does nothing on Enter; only the typed number runs Undo", async () => {
  const place = await folder();
  const s = session(place, [edit("notes.py", "print('two')\n")]);
  try {
    expect(await s.send("fix the greeting in notes.py")).toContain("Next: 1 Undo · 2 Show diff\n");
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
    expect(partial).toContain("✓ Undone — 1 file is back as it was before task 1: a.py\n• Left as you changed them: notes.py");
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
    expect(later.output()).toMatch(/Task 1 · \d\d:\d\d · fix notes\.py with token <redacted>\n• Not verified — /);
    await later.app.runOnce("/receipt list", place.project);
    expect(later.output()).toMatch(/ {2}1 {2}\d\d:\d\d {2}• Not verified/);
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
    expect(made.output()).toContain("• Undo not available: git is not installed\n");
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
    expect(first.output()).toContain("• Undo can't put back: local.cfg (it was there before the task, but git ignored it then, so Casper has no copy)");
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
    expect(first.output()).toContain("• Undo can't put back: capture.pcap (over 8 MB)");
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
    expect(first.output()).toContain("• Undo can't put back: .env (Casper keeps no copy of secret files), dist/app.js (git ignores it, so Casper keeps no copy)");
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
    expect(first.output()).toContain("• Undo can't put back: capture.pcap (over 8 MB)");
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

test("an undo that put nothing back (you saved the file while Casper asked) can be tried again later", async () => {
  const place = await folder();
  const s = session(place, [async (project) => { await writeFile(path.join(project, "notes.py"), "print('two')\n"); await writeFile(path.join(project, "a.py"), "a = 1\n"); }]);
  try {
    await s.send("fix the greeting in notes.py and add a.py");
    await writeFile(path.join(place.project, "notes.py"), "print('mine')\n");
    await s.send("/undo", /Type 1 or 2: $/);
    await writeFile(path.join(place.project, "a.py"), "a = 2\n");
    const answered = await s.send("2");
    expect(answered).toContain("• Nothing was put back for task 1.");
    expect(answered).toContain("• Not put back: a.py (it changed just now; Casper left it as it is)");
    expect(answered).not.toContain("Next: 1 Redo");
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
    expect(await s.send("2")).toContain("• Nothing was put back for task 1.");
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
    expect(event.verdict).toBe("• Not verified — Casper ran no checks");
  } finally { await later.app.close(); }
}, 30_000);
