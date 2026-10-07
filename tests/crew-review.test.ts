import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { CasperApp } from "../src/app";
import { BUILDER_LIMITS, SubagentManager, type BuildOutcome } from "../src/agents/manager";
import { PartRecord, PART_EXCERPT_BYTES } from "../src/crew/parts";
import { formatReceipt } from "../src/task/result";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeBuilderStartOptions, RuntimeEvent, RuntimeEventListener, RuntimeReadOnlyStartOptions, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const git = async (cwd: string, ...args: string[]) => String((await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout);

async function repository() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-crew-review-")));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"); const repo = path.join(root, "repo");
  await mkdir(home); await mkdir(repo);
  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(path.join(repo, name), `${name}\n`);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "core.autocrlf", "false");
  await git(repo, "config", "user.name", "Casper Test");
  await git(repo, "config", "user.email", "casper@example.invalid");
  await git(repo, "add", "-A"); await git(repo, "commit", "-m", "base");
  return { home, repo };
}

/** One fake child runtime: a builder writes the file its job names ("write b.txt"); a read-only child answers. */
class Children implements AgentRuntime {
  static builders: RuntimeBuilderStartOptions[] = [];
  static readers: Array<{ options: RuntimeReadOnlyStartOptions; prompt: string }> = [];
  /** Each builder's prompt, and what b.txt held in its copy when it started. */
  static builderPrompts: string[] = [];
  static seenB: string[] = [];
  /** What a read-only child answers, when a test sets it. */
  static readerReply: string | undefined;
  constructor(private readonly during?: () => Promise<void>) {}
  async start(): Promise<RuntimeSession> { throw new Error("not the main session"); }
  private session(cwd: string, run: (text: string, emit: (event: RuntimeEvent) => void) => Promise<void>): RuntimeSession {
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
    return { prompt: async (text) => { emit({ type: "assistant_response_start" }); await run(text, emit); },
      abort: async () => {}, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getState: () => ({ cwd, isStreaming: false }) };
  }
  async startBuilder(options: RuntimeBuilderStartOptions): Promise<RuntimeSession> {
    Children.builders.push(options);
    return this.session(options.cwd, async (text, emit) => {
      Children.builderPrompts.push(text);
      Children.seenB.push(await readFile(path.join(options.cwd, "b.txt"), "utf8").catch(() => ""));
      const file = /Job:\nwrite (\S+)/.exec(text)?.[1] ?? "none.txt";
      const body = text.includes("Fix only") ? "fixed by the fix builder\n" : file.startsWith("big") ? "a line of the builder's work\n".repeat(2000)
        : file.startsWith("keys") ? "API_KEY=sk-live-abcdef1234567890abcdef\n" : "from the builder\n";
      await writeFile(path.join(options.cwd, file), body);
      await this.during?.();
      emit({ type: "assistant_text_delta", delta: `Wrote ${file}.` });
      emit({ type: "assistant_response_end", stopReason: "stop", usage: { tokens: 1000, estimatedCost: 0.02 } });
    });
  }
  async startReadOnly(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
    return this.session(options.cwd, async (text, emit) => {
      Children.readers.push({ options, prompt: text });
      emit({ type: "assistant_text_delta", delta: Children.readerReply ?? (text.includes("keys.txt") ? "Finding: the key is hard coded.\nAPI_KEY=sk-live-abcdef1234567890abcdef\n" : "No findings.") });
      emit({ type: "assistant_response_end", stopReason: "stop", usage: { tokens: 500, estimatedCost: 0.01 } });
    });
  }
  async dispose() {}
}

class Main implements AgentRuntime {
  tools: RuntimeTool[] = [];
  count = 0;
  constructor(private readonly act: (delegate: RuntimeTool, task: number) => Promise<void>) {}
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.tools = options.tools ?? [];
    return {
      setTools: (tools) => { this.tools = tools; },
      prompt: async () => { await this.act(this.tools.find((tool) => tool.name === "delegate")!, ++this.count); },
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

/** What the app printed, for the [crew] lines. */
let written: string[] = [];

async function app(repo: string, home: string, main: Main, children: () => AgentRuntime = () => new Children()) {
  Children.builders = []; Children.readers = []; Children.builderPrompts = []; Children.seenB = []; Children.readerReply = undefined; written = [];
  await mkdir(path.join(repo, ".casper"), { recursive: true });
  await writeFile(path.join(repo, ".casper", "project.yaml"), stringify({ name: "review-app" }));
  const casper = new CasperApp({ runtimeFactory: () => main, subagentRuntimeFactory: children, noSandbox: true,
    output: { write: (text: string) => { written.push(text); } }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ homeDir: home, projectRoot: context.info.root }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  cleanup.push(() => casper.close().catch(() => {}));
  await casper.start(repo);
  return casper;
}

const data = (text: string) => JSON.parse(text).data;
const build = async (delegate: RuntimeTool, file: string) => data((await delegate.execute({ role: "builder", goal: `write ${file}` })).text);
const review = (delegate: RuntimeTool, of: number, context?: string) =>
  delegate.execute({ role: "reviewer", goal: "check the part", of, ...(context ? { context } : {}) });

test("a reviewer given a part number gets the part's goal, files, stat and diff, with the lead's own context after", async () => {
  const { home, repo } = await repository();
  let part: number | undefined;
  let reply: { text: string; isError?: boolean } | undefined;
  const casper = await app(repo, home, new Main(async (delegate) => {
    const landed = await build(delegate, "b.txt");
    part = landed.part;
    expect(landed.next).toContain("of: 1");
    reply = await review(delegate, landed.part, "Focus on the first line.");
  }));
  await casper.runOnce("Split this up: change b", repo);
  expect(part).toBe(1);
  expect(data(reply!.text).status).toBe("completed");
  expect(Children.readers).toHaveLength(1);
  const { options, prompt } = Children.readers[0]!;
  expect(prompt).toContain("write b.txt");
  expect(prompt).toContain("b.txt");
  expect(prompt).toContain("+from the builder");
  expect(prompt.indexOf("+from the builder")).toBeLessThan(prompt.indexOf("Focus on the first line."));
  // The reviewer is the usual read-only child on the review model; only builders are started as builders.
  expect(options.modelRole).toBe("review");
  expect(Children.builders).toHaveLength(1);
}, 30_000);

test("a big diff is cut with a note, and the lead's own context keeps its limit", async () => {
  const { home, repo } = await repository();
  let refusal: { text: string } | undefined;
  const casper = await app(repo, home, new Main(async (delegate) => {
    const landed = await build(delegate, "big.txt");
    await review(delegate, landed.part);
    refusal = await review(delegate, landed.part, "x".repeat(9000));
  }));
  await casper.runOnce("Split this up", repo);
  const prompt = Children.readers[0]!.prompt;
  expect(prompt).toContain("cut");
  expect(Buffer.byteLength(prompt)).toBeLessThan(PART_EXCERPT_BYTES + 12_000);
  expect(data(refusal!.text).error).toContain("context");
}, 30_000);

test("a part number that was never given, or a part that was kept, is refused in plain words", async () => {
  const { home, repo } = await repository();
  const replies: string[] = [];
  const casper = await app(repo, home, new Main(async (delegate) => {
    replies.push(data((await review(delegate, 7)).text).error);
    const kept = await build(delegate, "a.txt");
    expect(kept.kept).toBeDefined();
    expect(kept.part).toBeUndefined();
    replies.push(data((await review(delegate, 1)).text).error);
    for (const bad of [0, 1.5, "1"]) replies.push(data((await delegate.execute({ role: "reviewer", goal: "g", of: bad })).text).error);
    replies.push(data((await delegate.execute({ role: "explorer", goal: "g", of: 1 })).text).error);
  }), () => new Children(async () => { await writeFile(path.join(repo, "a.txt"), "yours\n"); }));
  await casper.runOnce("Split this up", repo);
  expect(replies[0]).toContain("Part 7");
  expect(replies[0]).toContain("only a part a builder landed");
  expect(replies[1]).toContain("Part 1");
  for (const reply of replies.slice(2, 5)) expect(reply).toContain("whole number");
  expect(replies[5]).toContain("reviewer");
  expect(Children.readers).toHaveLength(0);
}, 30_000);

test("reviews of parts have their own budget: four explorers and three part reviewers all run, a part is reviewed once", async () => {
  const { home, repo } = await repository();
  const statuses: string[] = [];
  let again = "";
  const casper = await app(repo, home, new Main(async (delegate) => {
    const parts = [];
    for (const file of ["a.txt", "b.txt", "c.txt"]) parts.push((await build(delegate, file)).part);
    expect(parts).toEqual([1, 2, 3]);
    for (let i = 0; i < 4; i++) statuses.push(data((await delegate.execute({ role: "explorer", goal: `find ${i}` })).text).status);
    expect(data((await delegate.execute({ role: "explorer", goal: "one more" })).text).error).toContain("Delegation budget exhausted");
    for (const part of parts) statuses.push(data((await review(delegate, part)).text).status);
    again = data((await review(delegate, 1)).text).error;
  }));
  await casper.runOnce("Split this up", repo);
  expect(statuses).toEqual(Array(7).fill("completed"));
  expect(again).toContain("already reviewed");
  expect(Children.readers).toHaveLength(7);
}, 60_000);

test("a part reviewer's spend joins the task's spend", async () => {
  const { home, repo } = await repository();
  const casper = await app(repo, home, new Main(async (delegate) => { await review(delegate, (await build(delegate, "b.txt")).part); }));
  await casper.runOnce("Split this up", repo);
  expect(casper.getLastTaskResult()!.usage?.tokens).toBe(1500);
}, 30_000);

test("the parts are forgotten when the task ends", async () => {
  const { home, repo } = await repository();
  let next = "";
  const casper = await app(repo, home, new Main(async (delegate, task) => {
    if (task === 1) await build(delegate, "b.txt");
    else next = data((await review(delegate, 1)).text).error;
  }));
  await casper.runOnce("Split this up", repo);
  await casper.runOnce("Now something else", repo);
  expect(next).toContain("Part 1");
}, 30_000);

test("the record cuts the diff to text hunks, names binary files, and counts reviews", () => {
  const record = new PartRecord();
  const patch = Buffer.from([
    "diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n",
    "diff --git a/logo.png b/logo.png\nGIT binary patch\nliteral 3\nIcmZQz\n\n",
  ].join(""));
  const n = record.landed({ files: ["x.txt", "logo.png"], stat: "2 files changed", patch, goal: "do x" });
  const text = (record.reviewContext(n) as { context: string }).context;
  expect(text).toContain("+new");
  expect(text).toContain("logo.png (binary file, not shown)");
  expect(text).not.toContain("literal 3");
  expect(record.unreviewed()).toEqual([n]);
  record.markReviewed(n, "fine", 0);
  expect(record.unreviewed()).toEqual([]);
  expect("refusal" in record.reviewContext(n)).toBe(true);
  // After a fix refreshes the diff, one more review is allowed.
  record.refreshExcerpt(n, Buffer.from("diff --git a/x.txt b/x.txt\n+newer\n"));
  expect("context" in record.reviewContext(n)).toBe(true);
});

test("a secret a builder wrote is hidden in the reviewer's prompt", async () => {
  const { home, repo } = await repository();
  const casper = await app(repo, home, new Main(async (delegate) => {
    const landed = await build(delegate, "keys.txt");
    await review(delegate, landed.part);
  }));
  await casper.runOnce("Split this up: add keys", repo);
  const { prompt } = Children.readers[0]!;
  expect(prompt).toContain("keys.txt");
  expect(prompt).toContain("API_KEY=");
  expect(prompt).not.toContain("sk-live-abcdef1234567890abcdef");
}, 30_000);

test("a renamed binary file keeps its name in the excerpt", () => {
  const record = new PartRecord();
  const patch = Buffer.from("diff --git a/old.png b/new.png\nsimilarity index 90%\nrename from old.png\nrename to new.png\nGIT binary patch\nliteral 3\nIcmZQz\n\n");
  const n = record.landed({ files: ["new.png"], stat: "", patch, goal: "rename" });
  const text = (record.reviewContext(n) as { context: string }).context;
  expect(text).toContain("old.png -> new.png (binary file, not shown)");
  expect(text).not.toContain("literal 3");
});

const fix = (delegate: RuntimeTool, goal: string, of: number, context?: string) =>
  delegate.execute({ role: "builder", goal, of, ...(context ? { context } : {}) });

test("a fix builder gets the stored review report and the fixer rule, starts from the folder with the part in it, and lands with the part", async () => {
  const { home, repo } = await repository();
  let fixed: Record<string, unknown> | undefined;
  const casper = await app(repo, home, new Main(async (delegate) => {
    const landed = await build(delegate, "b.txt");
    await review(delegate, landed.part);
    fixed = data((await fix(delegate, "write b.txt", landed.part, "Mind the first line.")).text);
  }));
  await casper.runOnce("Split this up", repo);
  expect(fixed!.part).toBe(1);
  expect(fixed!.applied).toEqual(["b.txt"]);
  const prompt = Children.builderPrompts[1]!;
  expect(prompt).toContain("No findings.");
  expect(prompt).toContain("Fix only");
  expect(prompt).toContain("Mind the first line.");
  expect(prompt.indexOf("No findings.")).toBeLessThan(prompt.indexOf("Mind the first line."));
  expect(Children.seenB).toEqual(["b.txt\n", "from the builder\n"]);
  expect(await readFile(path.join(repo, "b.txt"), "utf8")).toBe("fixed by the fix builder\n");
  // One /undo takes the part and its fix back.
  await casper.runOnce("/undo");
  expect(await readFile(path.join(repo, "b.txt"), "utf8")).toBe("b.txt\n");
}, 30_000);

test("a second fix for the same part is refused and not counted; a fix with no review on file is allowed", async () => {
  const { home, repo } = await repository();
  const replies: string[] = [];
  const casper = await app(repo, home, new Main(async (delegate) => {
    const landed = await build(delegate, "b.txt");
    replies.push(data((await fix(delegate, "write b.txt", landed.part)).text).status);
    replies.push(data((await fix(delegate, "write b.txt", landed.part)).text).error);
    replies.push(data((await fix(delegate, "write b.txt", 9)).text).error);
  }));
  await casper.runOnce("Split this up", repo);
  expect(replies[0]).toBe("completed");
  expect(replies[1]).toContain("one fix round per part");
  expect(replies[1]).toContain("yourself");
  expect(replies[2]).toContain("Part 9");
  expect(Children.builderPrompts).toHaveLength(2);
}, 30_000);

test("a refused second fix does not move the fix counter", async () => {
  const { home, repo } = await repository();
  const out: string[] = [];
  const casper = await app(repo, home, new Main(async (delegate) => {
    for (let i = 1; i <= 6; i++) await build(delegate, `n${i}.txt`);
    for (const i of [1, 1, 1, 2, 3, 4]) {
      const reply = data((await fix(delegate, `write n${i}.txt`, i)).text);
      out.push(reply.error ?? reply.status);
    }
  }));
  await casper.runOnce("Split this up", repo);
  // Six first builds, then three fixes fit under the nine; the two repeats on part 1 used none of it.
  expect(out.slice(0, 1)).toEqual(["completed"]);
  expect(out[1]).toContain("one fix round per part");
  expect(out[2]).toContain("one fix round per part");
  expect(out.slice(3, 5)).toEqual(["completed", "completed"]);
  expect(out[5]).toContain(`${BUILDER_LIMITS.maxWithFixes} builders`);
}, 90_000);

test("a fix whose builder never started gives the part's fix round back", async () => {
  const record = new PartRecord();
  const n = record.landed({ files: ["x.txt"], stat: "", patch: Buffer.from("diff --git a/x.txt b/x.txt\n+a\n"), goal: "x" });
  let tries = 0;
  const agents = new SubagentManager({ runtimeFactory: () => { throw new Error("no children here"); } });
  cleanup.push(() => agents.close());
  const outcome: BuildOutcome = { report: { applied: [] }, isError: false, usage: null };
  const tool = agents.createTool(() => ({ cwd: "/", projectContext: "" }), undefined, {
    parts: record,
    run: async () => { if (++tries === 1) throw new Error("the copy could not be made"); return outcome; },
  });
  expect(data((await tool.execute({ role: "builder", goal: "fix", of: n })).text).error).toContain("copy could not be made");
  expect(data((await tool.execute({ role: "builder", goal: "fix", of: n })).text).error).toBeUndefined();
  expect(tries).toBe(2);
  // That one went through, so the round is spent now.
  expect(data((await tool.execute({ role: "builder", goal: "fix", of: n })).text).error).toContain("one fix round per part");
  expect(tries).toBe(2);
});

test("a stored reviewer report is scrubbed before the fix builder sees it", async () => {
  const { home, repo } = await repository();
  const casper = await app(repo, home, new Main(async (delegate) => {
    const landed = await build(delegate, "keys.txt");
    await review(delegate, landed.part);
    await fix(delegate, "write keys.txt", landed.part);
  }));
  await casper.runOnce("Split this up: add keys", repo);
  const prompt = Children.builderPrompts[1]!;
  expect(prompt).toContain("the key is hard coded");
  expect(prompt).toContain("API_KEY=");
  expect(prompt).not.toContain("sk-live-abcdef1234567890abcdef");
}, 30_000);

test("a review that started before a fix landed does not mark the part reviewed", () => {
  const record = new PartRecord();
  const n = record.landed({ files: ["x.txt"], stat: "", patch: Buffer.from("diff --git a/x.txt b/x.txt\n+a\n"), goal: "x" });
  const early = record.reviewContext(n) as { context: string; version: number };
  record.refreshExcerpt(n, Buffer.from("diff --git a/x.txt b/x.txt\n+b\n"));
  record.markReviewed(n, "late and about the old diff", early.version);
  expect(record.unreviewed()).toEqual([n]);
  // The stale report is not kept for a fix either.
  expect((record.fixContext(n) as { context: string }).context).not.toContain("late and about");
  // The review of the new diff counts.
  const fresh = record.reviewContext(n) as { context: string; version: number };
  record.markReviewed(n, "about the fix", fresh.version);
  expect(record.unreviewed()).toEqual([]);
});

test("a part fixed without a review gets one review after the fix, and a reviewed one gets one before and one after", () => {
  const record = new PartRecord();
  const patch = Buffer.from("diff --git a/x.txt b/x.txt\n+a\n");
  const bare = record.landed({ files: ["x.txt"], stat: "", patch, goal: "x" });
  record.refreshExcerpt(bare, patch);
  expect("context" in record.reviewContext(bare)).toBe(true);
  expect("refusal" in record.reviewContext(bare)).toBe(true);
  const both = record.landed({ files: ["y.txt"], stat: "", patch, goal: "y" });
  expect("context" in record.reviewContext(both)).toBe(true);
  expect("refusal" in record.reviewContext(both)).toBe(true);
  record.refreshExcerpt(both, patch);
  expect("context" in record.reviewContext(both)).toBe(true);
  expect("refusal" in record.reviewContext(both)).toBe(true);
});

test("after a fix the stat is labeled as the fix's own change, next to the part's first one", () => {
  const record = new PartRecord();
  const n = record.landed({ files: ["x.txt"], stat: "x.txt | 1 +", patch: Buffer.from("diff --git a/x.txt b/x.txt\n+a\n"), goal: "x" });
  record.refreshExcerpt(n, Buffer.from("diff --git a/y.txt b/y.txt\n+b\n"), { files: ["y.txt"], stat: "y.txt | 2 ++" });
  const text = (record.reviewContext(n) as { context: string }).context;
  expect(text).toContain("x.txt, y.txt");
  expect(text).toContain("The part's first change:\nx.txt | 1 +");
  expect(text).toContain("The fix's own change:\ny.txt | 2 ++");
});

test("a fix whose file changed meanwhile keeps its copy and says so", async () => {
  const { home, repo } = await repository();
  let reply: Record<string, unknown> | undefined;
  let during = false;
  const casper = await app(repo, home, new Main(async (delegate) => {
    const landed = await build(delegate, "b.txt");
    during = true;
    reply = data((await fix(delegate, "write b.txt", landed.part)).text);
  }), () => new Children(async () => { if (during) await writeFile(path.join(repo, "b.txt"), "yours\n"); }));
  await casper.runOnce("Split this up", repo);
  expect(reply!.kept).toBeDefined();
  expect(reply!.applied).toEqual([]);
  expect(await readFile(path.join(repo, "b.txt"), "utf8")).toBe("yours\n");
}, 30_000);

test("the post-fix re-review sees the fix's diff, once", async () => {
  const { home, repo } = await repository();
  const casper = await app(repo, home, new Main(async (delegate) => {
    const landed = await build(delegate, "b.txt");
    await review(delegate, landed.part);
    const fixed = data((await fix(delegate, "write b.txt", landed.part)).text);
    expect(fixed.next).toContain("of: 1");
    await review(delegate, landed.part);
    expect(data((await review(delegate, landed.part)).text).error).toContain("already reviewed");
  }));
  await casper.runOnce("Split this up", repo);
  expect(Children.readers).toHaveLength(2);
  expect(Children.readers[1]!.prompt).toContain("+fixed by the fix builder");
  expect(Children.readers[1]!.prompt).toContain("-from the builder");
}, 30_000);

test("the record notes files a fix touched outside the part", () => {
  const record = new PartRecord();
  const n = record.landed({ files: ["x.txt"], stat: "", patch: Buffer.from("diff --git a/x.txt b/x.txt\n+a\n"), goal: "x" });
  expect(record.refreshExcerpt(n, Buffer.from("diff --git a/y.txt b/y.txt\n+b\n"), { files: ["y.txt"], stat: "" })).toEqual(["y.txt"]);
  expect((record.reviewContext(n) as { context: string }).context).toContain("x.txt, y.txt");
});

test("fixes have their own count: six first builds stay six, fixes stop at nine builders", async () => {
  const { home, repo } = await repository();
  const out: string[] = [];
  const casper = await app(repo, home, new Main(async (delegate) => {
    for (let i = 1; i <= 6; i++) await build(delegate, `n${i}.txt`);
    out.push((await build(delegate, "n7.txt")).error);
    for (const i of [1, 2, 3, 4, 5, 6]) {
      const reply = data((await fix(delegate, `write n${i}.txt`, i)).text);
      out.push(reply.error ?? reply.status);
    }
  }));
  await casper.runOnce("Split this up", repo);
  expect(out[0]).toContain("Builder budget used up");
  expect(out.slice(1, 4)).toEqual(["completed", "completed", "completed"]);
  for (const reply of out.slice(4)) expect(reply).toContain("9 builders");
  expect(Children.builders).toHaveLength(9);
}, 90_000);

test("three fixes at once are the most; a fourth is turned away without using the part's one fix", async () => {
  const { home, repo } = await repository();
  const out: string[] = [];
  const casper = await app(repo, home, new Main(async (delegate) => {
    for (let i = 1; i <= 4; i++) await build(delegate, `n${i}.txt`);
    const four = await Promise.all([1, 2, 3, 4].map((i) => fix(delegate, `write n${i}.txt`, i)));
    out.push(...four.map((r) => data(r.text).error ?? data(r.text).status));
    out.push(data((await fix(delegate, "write n4.txt", 4)).text).status);
  }), () => new Children(() => new Promise((resolve) => setTimeout(resolve, 150))));
  await casper.runOnce("Split this up", repo);
  expect(out.slice(0, 3)).toEqual(["completed", "completed", "completed"]);
  expect(out[3]).toContain("3 builders are already working");
  expect(out[4]).toBe("completed");
}, 90_000);

test("a fix builder waits on the task's spend pause like any builder", async () => {
  const { home, repo } = await repository();
  const casper = await app(repo, home, new Main(async (delegate) => { await fix(delegate, "write b.txt", (await build(delegate, "b.txt")).part); }));
  await casper.runOnce("Split this up", repo);
  expect(Children.builders).toHaveLength(2);
  for (const options of Children.builders) expect(options.beforeToolWait).toBeDefined();
}, 30_000);

test("a fix for a part that was never landed is refused in plain words", async () => {
  const { home, repo } = await repository();
  let reply = "";
  const casper = await app(repo, home, new Main(async (delegate) => { reply = data((await fix(delegate, "write b.txt", 1)).text).error; }));
  await casper.runOnce("Split this up", repo);
  expect(reply).toContain("Part 1");
  expect(Children.builders).toHaveLength(0);
}, 30_000);

/** A reader whose run fails, as a reviewer that timed out or broke would. */
class FailingReader extends Children {
  override async startReadOnly(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
    const session = await super.startReadOnly(options);
    return { ...session, prompt: async () => { throw new Error("the model went away"); } };
  }
}

test("the record says which landed parts no reviewer finished, and why", () => {
  const record = new PartRecord();
  const patch = Buffer.from("diff --git a/x.txt b/x.txt\n+new\n");
  expect(record.notReviewed()).toEqual([]);
  const one = record.landed({ files: ["x.txt"], stat: "", patch, goal: "one" });
  const two = record.landed({ files: ["y.txt", "z.txt"], stat: "", patch, goal: "two" });
  const three = record.landed({ files: ["w.txt"], stat: "", patch, goal: "three" });
  expect(record.notReviewed().map((item) => item.why)).toEqual(Array(3).fill("no reviewer looked at it"));
  record.markReviewed(one, "fine", 0);
  record.reviewFailed(two, "timed_out", 0);
  expect(record.notReviewed()).toEqual([
    { part: two, files: ["y.txt", "z.txt"], why: "the reviewer timed out" },
    { part: three, files: ["w.txt"], why: "no reviewer looked at it" },
  ]);
  for (const [status, why] of [["failed", "the reviewer failed"], ["limited", "the reviewer was cut off"], ["cancelled", "the reviewer was stopped"]] as const) {
    record.reviewFailed(three, status, 0);
    expect(record.notReviewed().at(-1)!.why).toBe(why);
  }
  // A later review that finishes clears the reason; a fix makes the part new again.
  record.markReviewed(two, "fine", 0);
  expect(record.notReviewed().map((item) => item.part)).toEqual([three]);
  record.refreshExcerpt(one, Buffer.from("diff --git a/x.txt b/x.txt\n+newer\n"));
  expect(record.notReviewed().map((item) => [item.part, item.why])).toEqual([[one, "no reviewer looked at it"], [three, "the reviewer was stopped"]]);
});

test("the receipt says which landed parts were not reviewed when the reviewer failed, and not when all were reviewed or none landed", async () => {
  const { home, repo } = await repository();
  const failed = await app(repo, home, new Main(async (delegate) => {
    await review(delegate, (await build(delegate, "b.txt")).part);
    await build(delegate, "c.txt");
  }), () => new FailingReader());
  await failed.runOnce("Split this up", repo);
  const task = failed.getLastTaskResult()!;
  expect(task.partsNotReviewed).toEqual([
    { part: 1, files: ["b.txt"], why: "the reviewer failed" },
    { part: 2, files: ["c.txt"], why: "no reviewer looked at it" },
  ]);
  expect(formatReceipt(task)).toContain("• Not reviewed: part 1 (b.txt; the reviewer failed), part 2 (c.txt; no reviewer looked at it)");

  const reviewed = await app(repo, home, new Main(async (delegate) => { await review(delegate, (await build(delegate, "b.txt")).part); }));
  await reviewed.runOnce("Split this up", repo);
  expect(reviewed.getLastTaskResult()!.partsNotReviewed).toBeUndefined();
  expect(formatReceipt(reviewed.getLastTaskResult()!)).not.toContain("Not reviewed");

  const none = await app(repo, home, new Main(async (delegate) => { await delegate.execute({ role: "explorer", goal: "look" }); }));
  await none.runOnce("Look around", repo);
  expect(none.getLastTaskResult()!.partsNotReviewed).toBeUndefined();
}, 60_000);

test("the parts not reviewed are listed on the receipt of the task that landed them only", async () => {
  const { home, repo } = await repository();
  const casper = await app(repo, home, new Main(async (delegate, task) => { if (task === 1) await build(delegate, "b.txt"); }));
  await casper.runOnce("Split this up", repo);
  expect(casper.getLastTaskResult()!.partsNotReviewed).toHaveLength(1);
  await casper.runOnce("Something else", repo);
  expect(casper.getLastTaskResult()!.partsNotReviewed).toBeUndefined();
}, 30_000);

test("the last builder's result lists the parts no reviewer has finished, and an earlier one's does not while another builder works", async () => {
  const { home, repo } = await repository();
  const replies: Array<Record<string, unknown>> = [];
  const casper = await app(repo, home, new Main(async (delegate) => {
    // b.txt's builder is slow, c.txt's is not: c.txt ends first while b.txt still works.
    const both = await Promise.all([build(delegate, "b.txt"), build(delegate, "c.txt")]);
    replies.push(...both);
    replies.push(await build(delegate, "a.txt").catch(() => ({})));
  }), () => new Children(() => new Promise((resolve) => setTimeout(resolve, 100))));
  await casper.runOnce("Split this up", repo);
  const [first, second] = replies;
  const withNote = [first, second].filter((reply) => reply!.notReviewedYet !== undefined);
  expect(withNote).toHaveLength(1);
  expect(String(withNote[0]!.notReviewedYet)).toMatch(/Parts no reviewer has finished yet: [12], [12]/);
}, 60_000);

test("a lone builder's result lists its part, and a reviewed part is left off", async () => {
  const { home, repo } = await repository();
  const replies: Array<Record<string, unknown>> = [];
  const casper = await app(repo, home, new Main(async (delegate) => {
    replies.push(await build(delegate, "b.txt"));
    await review(delegate, 1);
    replies.push(await build(delegate, "c.txt"));
  }));
  await casper.runOnce("Split this up", repo);
  expect(replies[0]!.notReviewedYet).toContain("1");
  expect(String(replies[1]!.notReviewedYet)).toContain(": 2");
  expect(String(replies[1]!.notReviewedYet)).not.toContain("1");
}, 30_000);

test("[crew] lines say a reviewer is checking the part, and that a builder is fixing what it found", async () => {
  const { home, repo } = await repository();
  const casper = await app(repo, home, new Main(async (delegate) => {
    Children.readerReply = "Findings:\n1. **High** b.txt:1 is wrong\n   evidence: the line\n2. **Low** b.txt:1 is odd\n";
    const landed = await build(delegate, "b.txt");
    await review(delegate, landed.part);
    await fix(delegate, "write b.txt", landed.part);
  }));
  await casper.runOnce("Split this up", repo);
  const lines = written.join("");
  expect(lines).toContain("[crew] A reviewer is checking part 1 (1 file)");
  expect(lines).toContain("[crew] The reviewer found 2 problems; a builder is fixing them");
}, 30_000);

test("a fix with no review on file says a builder is fixing the part, without a count", async () => {
  const { home, repo } = await repository();
  const casper = await app(repo, home, new Main(async (delegate) => { await fix(delegate, "write b.txt", (await build(delegate, "b.txt")).part); }));
  await casper.runOnce("Split this up", repo);
  expect(written.join("")).toContain("[crew] A builder is fixing part 1");
}, 30_000);
