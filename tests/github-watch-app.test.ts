import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { githubWatches, githubWatchesFor } from "../src/app/github-watch";
import { openWorkspaceBeforeRuntime } from "../src/app/workspace";
import { githubTool } from "../src/github/tool";
import { wakeText, type PullRead, type PullState } from "../src/github/watch";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

const state = (extra: Partial<PullState> = {}): PullState => ({ failing: [], running: 1, passing: 1, total: 2, mergeable: "mergeable", review: "none", comments: 0, reviews: 0, ...extra });

async function until(test: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !test(); i++) await Bun.sleep(5);
  if (!test()) throw new Error(`timed out waiting for ${what}`);
}

/** Casper at a plain terminal, a model that records each request (one holds until released), a fake watch timer.
 * `config`: the user's ~/.casper/config.yaml. */
async function fixture(config?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-watch-app-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper/project.yaml"), "verification:\n  mode: off\n");
  await writeFile(path.join(project, "notes.txt"), "An empty folder would ask about a new project.\n");
  if (config) await writeFile(path.join(home, ".casper/config.yaml"), config);
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const prompts: string[] = [];
  const hooks: { onPrompt?: (text: string) => void | Promise<void> } = {};
  const gate = Promise.withResolvers<void>();
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async (text: string) => {
          prompts.push(text);
          await hooks.onPrompt?.(text);
          if (text.includes("hold open")) await gate.promise;
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          emit({ type: "assistant_text_delta", delta: "Looked.\n" });
          emit({ type: "assistant_response_end", stopReason: "stop" });
        },
      };
    },
    async dispose() {},
  };
  const timers: Array<() => void> = [];
  const notes: string[] = [];
  const input = new PassThrough();
  let output = "";
  const app = new CasperApp({
    input, output: { write: (text: string) => { output += text; } },
    runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    githubWatch: { schedule: (fn) => { timers.push(fn); return () => { const at = timers.indexOf(fn); if (at >= 0) timers.splice(at, 1); }; },
      notify: async (text) => { notes.push(text); return true; } },
  });
  const interactive = app.runInteractive(project);
  const idle = () => until(() => app.interactive && !app.commandActive && /> $/.test(output), "the idle prompt");
  await idle();
  return { app, input, prompts, notes, hooks, timers, idle, root, release: gate.resolve, get output() { return output; },
    tick: () => { for (const fn of timers.splice(0)) fn(); },
    cleanup: async () => { input.end(); await interactive; await app.close(); await removeTempDir(root); } };
}

test("a wake at the idle prompt runs one turn with Casper's words; it is not echoed as typed and no typed-word rule reads it", async () => {
  const f = await fixture();
  try {
    const text = "big model: look at pull request #7 on GitHub";
    f.app.wakes.push({ key: "acme/widgets#7", reasons: ["a check failed (1 failing now)"], text: () => text, line: () => "◐ GitHub #7: a check failed (1 failing now). Casper asks the AI to look (your watch, not a merge decision)." });
    await until(() => f.prompts.length === 1, "the wake's turn");
    await f.idle();
    // Sent as it is: "big model:" from a wake is not the person's word, so no model switch and nothing taken out.
    expect(f.prompts[0]).toContain(text);
    expect(f.output).toContain("◐ GitHub #7: a check failed (1 failing now). Casper asks the AI to look (your watch, not a merge decision).");
    expect(f.output).not.toContain(text);
    // Any reading of its "big model:" would say so in a [model] line ("No big model is set up", "big model for this task").
    expect(f.output).not.toContain("big model");
    // The prompt is back and still reads the person's lines.
    f.input.write("and now my own line\n");
    await until(() => f.prompts.length === 2, "the typed line's turn");
    expect(f.prompts[1]).toContain("and now my own line");
  } finally { await f.cleanup(); }
});

test("a watch's change wakes the AI at the prompt, with a desktop notification; /tasks lists the watch and stops it", async () => {
  const f = await fixture();
  try {
    const watches = githubWatchesFor(f.app);
    expect(typeof watches).toBe("object");
    const reads: PullRead[] = [{ ok: true, state: state({ failing: ["test"], running: 0 }) }];
    githubWatches(f.app).start("acme/widgets", 7, state(), async () => reads.shift() ?? { ok: true, state: state({ failing: ["test"], running: 0 }) });
    const task = f.app.backgroundTasks().find((entry) => entry.kind === "watch");
    expect(task).toMatchObject({ kind: "watch", name: "pull request #7 (acme/widgets)", status: "read every 2 min" });
    f.tick();
    await until(() => f.prompts.length === 1, "the wake's turn");
    expect(f.prompts[0]).toContain(wakeText(7, "acme/widgets", ["a check failed (1 failing now)"]));
    expect(f.notes).toEqual(["GitHub #7: a check failed (1 failing now)"]);
    await f.idle();
    expect(await task!.stop()).toBe("Stopped watching #7.");
    expect(f.app.backgroundTasks().filter((entry) => entry.kind === "watch")).toEqual([]);
    expect(f.timers).toEqual([]);
  } finally { await f.cleanup(); }
});

test("a change while a request runs is told at once and runs after the request and the lines queued during it; a wake can unwatch, not watch", async () => {
  const f = await fixture();
  try {
    githubWatches(f.app).start("acme/widgets", 7, state(), async () => ({ ok: true, state: state({ review: "changes requested" }) }));
    f.input.write("hold open while I wait\n");
    await until(() => f.prompts.length === 1 && f.app.commandActive, "the held request");
    f.tick();
    await until(() => f.output.includes("◐ GitHub #7: the review decision is now changes requested. The AI looks after this request."), "the told line");
    f.app.queuedLines.push("a line typed during work");
    let duringWake: unknown;
    // The wake's turn may stop the watch it came from ("stop watching once CI is green"), never start one.
    const tool = githubTool({ root: () => f.app.activeWorkspaceRoot(), reruns: new Map(), repo: async () => ({ owner: "acme", name: "widgets" }),
      run: async () => { throw new Error("no gh call expected"); }, watches: (verb) => githubWatchesFor(f.app, verb) });
    let duringTool: unknown;
    f.hooks.onPrompt = async (text) => {
      if (!text.includes("Casper's watch")) return;
      duringWake = githubWatchesFor(f.app);
      duringTool = { watch: await tool.execute({ verb: "watch", number: 8 }), unwatch: await tool.execute({ verb: "unwatch", number: 7 }) };
    };
    f.release();
    await until(() => f.prompts.length === 3, "the queued line and the wake");
    expect(f.prompts[1]).toContain("a line typed during work");
    expect(f.prompts[2]).toContain("the review decision is now changes requested");
    expect(duringWake).toBe("Not started: a watch starts only from a request the person made, not during a wake.");
    expect(duringTool).toEqual({ watch: { text: "Not started: a watch starts only from a request the person made, not during a wake.", isError: true },
      unwatch: { text: "Stopped watching #7." } });
    expect(githubWatches(f.app).list()).toEqual([]);
    await f.idle();
    expect(typeof githubWatchesFor(f.app)).toBe("object");
  } finally { await f.cleanup(); }
});

test("no desktop notification with notifications off, or when the terminal is in front", async () => {
  const off = await fixture("notifications: off\n");
  try {
    githubWatches(off.app).start("acme/widgets", 7, state(), async () => ({ ok: true, state: state({ failing: ["test"], running: 0 }) }));
    off.tick();
    await until(() => off.prompts.length === 1, "the wake's turn");
    await off.idle();
    expect(off.notes).toEqual([]);
  } finally { await off.cleanup(); }
  const front = await fixture();
  try {
    Object.defineProperty(front.app.terminal, "inFront", { get: () => true, configurable: true });
    githubWatches(front.app).start("acme/widgets", 7, state(), async () => ({ ok: true, state: state({ failing: ["test"], running: 0 }) }));
    front.tick();
    await until(() => front.prompts.length === 1, "the wake's turn");
    await front.idle();
    expect(front.notes).toEqual([]);
  } finally { await front.cleanup(); }
});

test("the GitHub tool turned off stops the watches at their next change, with no model turn", async () => {
  const f = await fixture();
  try {
    githubWatches(f.app).start("acme/widgets", 7, state(), async () => ({ ok: true, state: state({ failing: ["test"], running: 0 }) }));
    f.app.projectContext = { ...f.app.projectContext!, github: false };
    f.tick();
    await until(() => f.output.includes("◐ Stopped watching #7: the GitHub tool is off in /settings."), "the stop line");
    expect(f.app.wakes.size).toBe(0);
    expect(f.timers).toEqual([]);
    expect(githubWatches(f.app).list()).toEqual([]);
    expect(f.prompts).toEqual([]);
  } finally { await f.cleanup(); }
});

test("during a walk-away job a change is told without promising the AI will look, and no wake runs", async () => {
  const f = await fixture();
  try {
    githubWatches(f.app).start("acme/widgets", 7, state(), async () => ({ ok: true, state: state({ failing: ["test"], running: 0 }) }));
    f.input.write("hold open while I wait\n");
    await until(() => f.prompts.length === 1 && f.app.commandActive, "the held request");
    f.app.away = {} as NonNullable<typeof f.app.away>;
    try {
      f.tick();
      await until(() => f.output.includes("◐ GitHub #7: a check failed (1 failing now). The AI does not look during a walk-away job."), "the told line");
      expect(f.output).not.toContain("The AI looks after this request");
      expect(f.app.wakes.size).toBe(0);
    } finally { f.app.away = undefined; }
    f.release();
    await f.idle();
    expect(f.prompts).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test("moving to another folder stops the watches, so no wake reads the new folder's repo", async () => {
  const f = await fixture();
  try {
    githubWatches(f.app).start("acme/widgets", 7, state(), async () => ({ ok: true, state: state({ failing: ["test"], running: 0 }) }));
    const other = path.join(f.root, "other");
    await mkdir(path.join(other, ".casper"), { recursive: true });
    await writeFile(path.join(other, ".casper/project.yaml"), "verification:\n  mode: off\n");
    await openWorkspaceBeforeRuntime(f.app, other);
    expect(f.output).toContain("◐ Stopped watching #7: Casper moved to another folder.");
    expect(githubWatches(f.app).list()).toEqual([]);
    expect(f.timers).toEqual([]);
  } finally { await f.cleanup(); }
});
