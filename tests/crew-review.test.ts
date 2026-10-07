import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { CasperApp } from "../src/app";
import { PartRecord, PART_EXCERPT_BYTES } from "../src/crew/parts";
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
      const file = /Job:\nwrite (\S+)/.exec(text)?.[1] ?? "none.txt";
      const body = file.startsWith("big") ? "a line of the builder's work\n".repeat(2000)
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
      emit({ type: "assistant_text_delta", delta: "No findings." });
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

async function app(repo: string, home: string, main: Main, children: () => AgentRuntime = () => new Children()) {
  Children.builders = []; Children.readers = [];
  await mkdir(path.join(repo, ".casper"), { recursive: true });
  await writeFile(path.join(repo, ".casper", "project.yaml"), stringify({ name: "review-app" }));
  const casper = new CasperApp({ runtimeFactory: () => main, subagentRuntimeFactory: children, noSandbox: true,
    output: { write: () => {} }, sessionHomeDir: home,
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
  record.markReviewed(n, "fine");
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
