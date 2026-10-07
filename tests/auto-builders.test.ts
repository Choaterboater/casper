import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { BUILDER_LIMITS, SubagentManager, type BuilderRunOptions, type SubagentResult } from "../src/agents/manager";
import { CasperApp } from "../src/app";
import { settingRows } from "../src/app/settings";
import { buildersText } from "../src/app/footer";
import { autoBuilders, builderAvailability, builderSteer, builderSteerLine, runAutoBuilder, SOLO_REFUSAL, type AutoBuildHost } from "../src/crew/auto";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import type { AgentRuntime, RuntimeBuilderStartOptions, RuntimeEvent, RuntimeEventListener, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { NOT_RUN_REASON, NOT_WRITTEN_REASON } from "../src/secrets/gate";
import { SPEND_STOP_REASON } from "../src/task/spend";
import { removeTempDir } from "./support/temp-dir";

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const git = async (cwd: string, ...args: string[]) => String((await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout);

async function repository(init = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-auto-builders-")));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"); const repo = path.join(root, "repo");
  await mkdir(home); await mkdir(repo);
  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(path.join(repo, name), `${name}\n`);
  if (init) {
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "core.autocrlf", "false");
    await git(repo, "config", "user.name", "Casper Test");
    await git(repo, "config", "user.email", "casper@example.invalid");
    await git(repo, "add", "-A"); await git(repo, "commit", "-m", "base");
  }
  return { home, repo };
}

/** A builder that writes the file its job names ("write b.txt") in its copy. */
class Builder implements AgentRuntime {
  static seen: RuntimeBuilderStartOptions[] = [];
  constructor(private readonly during?: (file: string) => Promise<void>) {}
  async start(): Promise<RuntimeSession> { throw new Error("not the main session"); }
  async startBuilder(options: RuntimeBuilderStartOptions): Promise<RuntimeSession> {
    Builder.seen.push(options);
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
    return {
      prompt: async (text) => {
        const file = /Job:\nwrite (\S+)/.exec(text)?.[1] ?? "none.txt";
        emit({ type: "assistant_response_start" });
        await writeFile(path.join(options.cwd, file), `from the builder\n`);
        await this.during?.(file);
        emit({ type: "assistant_text_delta", delta: `Wrote ${file}.` });
        emit({ type: "assistant_response_end", stopReason: "stop", usage: { tokens: 1000, estimatedCost: 0.02 } });
      },
      abort: async () => {}, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

/** The main AI: on each request it runs `act` with the delegate tool it was given. */
class Main implements AgentRuntime {
  tools: RuntimeTool[] = [];
  prompts: string[] = [];
  constructor(private readonly act: (delegate: RuntimeTool) => Promise<void>) {}
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.tools = options.tools ?? [];
    return {
      setTools: (tools) => { this.tools = tools; },
      prompt: async (text) => { this.prompts.push(text); await this.act(this.tools.find((tool) => tool.name === "delegate")!); },
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

async function app(repo: string, home: string, main: Main, builder: () => AgentRuntime = () => new Builder()) {
  await mkdir(path.join(repo, ".casper"), { recursive: true });
  await writeFile(path.join(repo, ".casper", "project.yaml"), stringify({ name: "auto-app" }));
  const output: string[] = [];
  const casper = new CasperApp({ runtimeFactory: () => main, subagentRuntimeFactory: builder, noSandbox: true,
    output: { write: (text) => { output.push(text); } }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ homeDir: home, projectRoot: context.info.root }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  cleanup.push(() => casper.close().catch(() => {}));
  await casper.start(repo);
  return { casper, output: () => output.join("") };
}

const data = (text: string) => JSON.parse(text).data;
const build = (delegate: RuntimeTool, goal: string) => delegate.execute({ role: "builder", goal });

test("the AI starts two builders at once; both changes land, count as the task's edits, and one /undo takes them back", async () => {
  const { home, repo } = await repository();
  const results: Array<{ text: string; isError?: boolean }> = [];
  const main = new Main(async (delegate) => {
    expect(delegate.description).toContain("Role builder");
    expect((delegate.inputSchema as { properties: { role: { enum: string[] } } }).properties.role.enum).toContain("builder");
    results.push(...await Promise.all([build(delegate, "write b.txt"), build(delegate, "write c.txt")]));
  });
  const { casper, output } = await app(repo, home, main);
  await casper.runOnce("Split this up: change b and c", repo);
  expect(main.prompts[0]).toContain(builderSteerLine("split")!);
  for (const result of results) expect(result.isError).toBeUndefined();
  const reports = results.map((result) => data(result.text));
  expect(reports.map((report) => report.applied)).toEqual([["b.txt"], ["c.txt"]]);
  expect(reports[0].cost).toBe("1,000 tokens · about $0.02");
  expect(reports[0].report).toBe("Wrote b.txt.");
  expect(await readFile(path.join(repo, "b.txt"), "utf8")).toBe("from the builder\n");
  expect(await readFile(path.join(repo, "c.txt"), "utf8")).toBe("from the builder\n");
  expect((await git(repo, "log", "--oneline")).trim().split("\n")).toHaveLength(1);
  const task = casper.getLastTaskResult()!;
  expect(task.observedEdits).toEqual(expect.arrayContaining([path.join(repo, "b.txt"), path.join(repo, "c.txt")]));
  expect(task.changedPaths).toEqual(expect.arrayContaining(["b.txt", "c.txt"]));
  expect(task.usage?.tokens).toBe(2000);
  expect(output()).toContain("A builder's change was applied to your folder, uncommitted: b.txt.");
  expect(await git(repo, "worktree", "list")).not.toContain("casper/crew-");
  await casper.runOnce("/undo");
  expect(await readFile(path.join(repo, "b.txt"), "utf8")).toBe("b.txt\n");
  expect(await readFile(path.join(repo, "c.txt"), "utf8")).toBe("c.txt\n");
}, 30_000);

test("a builder whose file was changed in your folder meanwhile is not applied; its copy is kept for /crew", async () => {
  const { home, repo } = await repository();
  let result: { text: string; isError?: boolean } | undefined;
  const main = new Main(async (delegate) => { result = await build(delegate, "write a.txt"); });
  const { casper, output } = await app(repo, home, main, () => new Builder(async () => { await writeFile(path.join(repo, "a.txt"), "yours\n"); }));
  await casper.runOnce("Change a.txt", repo);
  expect(result!.isError).toBe(true);
  const report = data(result!.text);
  expect(report.applied).toEqual([]);
  expect(report.changedInCopy).toEqual(["a.txt"]);
  expect(report.kept.why).toContain("a.txt changed in your folder too");
  expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("yours\n");
  expect(output()).toContain("It stays in its copy; /crew lists it.");
  await casper.runOnce("/crew");
  expect(output()).toMatch(/1 casper\/crew-[a-z0-9]{6}-1 · 1 file changed/);
}, 30_000);

test("turned off, or the request says by yourself: builder calls get one plain line; read-only helpers still work", async () => {
  const { home, repo } = await repository();
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper", "config.yaml"), "delegate:\n  build: false\n");
  const texts: string[] = [];
  let description = "";
  const main = new Main(async (delegate) => {
    description = delegate.description;
    texts.push((await build(delegate, "write b.txt")).text);
    texts.push((await delegate.execute({ role: "explorer", goal: "find a" })).text);
  });
  const reader = { async start(): Promise<RuntimeSession> { throw new Error("no"); }, async dispose() {},
    async startReadOnly(): Promise<RuntimeSession> {
      let listener: RuntimeEventListener | undefined;
      return { prompt: async () => { listener?.({ type: "assistant_text_delta", delta: "a.txt:1" }); }, abort: async () => {},
        subscribe: (next) => { listener = next; return () => {}; }, getState: () => ({ cwd: repo, isStreaming: false }) };
    } } satisfies AgentRuntime;
  const { casper } = await app(repo, home, main, () => reader);
  await casper.runOnce("Change b.txt", repo);
  expect(description).toContain("No builders here: turned off in /settings.");
  expect(data(texts[0]!).error).toContain("No builders here: turned off");
  expect(data(texts[1]!).status).toBe("completed");
  expect(await readFile(path.join(repo, "b.txt"), "utf8")).toBe("b.txt\n");

  // A project file can't turn them back on for you.
  await writeFile(path.join(repo, ".casper", "project.yaml"), stringify({ name: "auto-app", delegate: { build: true } }));
  const context = await loadProjectContext(await inspectProject(repo), { homeDir: home });
  expect(context.delegate).toEqual({ build: false });
  expect(settingRows(context).find((row) => row.label === "Helpers that build")?.value).toBe("off");
}, 30_000);

test("'by yourself' takes builders away for that request, with no steer to split", async () => {
  const { home, repo } = await repository();
  const texts: string[] = [];
  const main = new Main(async (delegate) => { texts.push((await build(delegate, "write b.txt")).text); });
  const { casper } = await app(repo, home, main);
  await casper.runOnce("Change b.txt by yourself", repo);
  expect(main.prompts[0]).toContain(builderSteerLine("solo")!);
  expect(data(texts[0]!).error).toBe(SOLO_REFUSAL);
  expect(await readFile(path.join(repo, "b.txt"), "utf8")).toBe("b.txt\n");
}, 30_000);

test("outside a Git repository builders are not offered and the tool says why once", async () => {
  const { home, repo } = await repository(false);
  let delegate: RuntimeTool | undefined;
  const main = new Main(async (given) => { delegate = given; });
  const { casper } = await app(repo, home, main);
  await casper.runOnce("Change b.txt in parallel", repo);
  expect((delegate!.inputSchema as { properties: { role: { enum: string[] } } }).properties.role.enum).toEqual(["explorer", "reviewer"]);
  expect(delegate!.description).toContain("No builders here: not a Git repository.");
  expect(main.prompts[0]).not.toContain(builderSteerLine("split")!);
  expect(data((await build(delegate!, "write b.txt")).text).error).toContain("not a Git repository");
}, 30_000);

test("a repository with no commits offers no builders and says why", async () => {
  const { home, repo } = await repository(false);
  await git(repo, "init", "-b", "main");
  expect(await builderAvailability({ root: repo, homeDir: home, off: false, sandbox: "ready" })).toBe("the repository has no commits yet");
});

test("request words steer builders", () => {
  expect(builderSteer("Use a crew for this")).toBe("split");
  expect(builderSteer("split this up please")).toBe("split");
  expect(builderSteer("use builders for the three parts")).toBe("split");
  expect(builderSteer("do these in parallel")).toBe("split");
  expect(builderSteer("work in parallel on the docs and the tests")).toBe("split");
  expect(builderSteer("run a crew to add the login page")).toBe("split");
  expect(builderSteer("have the crew do the docs and the API")).toBe("split");
  expect(builderSteer("do this as a crew")).toBe("split");
  expect(builderSteer("crew it: tests, docs and the page")).toBe("split");
  // Words about the code, not about how Casper works.
  expect(builderSteer("make the fetches run in parallel")).toBeUndefined();
  expect(builderSteer("run the tests in parallel")).toBeUndefined();
  expect(builderSteer("the crew list shows the wrong count")).toBeUndefined();
  expect(builderSteer("fix /crew apply")).toBeUndefined();
  expect(builderSteer("run the crew tests")).toBeUndefined();
  expect(builderSteer("split this up but no helpers")).toBe("solo");
  expect(builderSteer("do it by yourself")).toBe("solo");
  expect(builderSteer("rename the function")).toBeUndefined();
});

test("at most 3 builders at once; a fourth is turned away and not counted", async () => {
  const { home, repo } = await repository();
  const release: Array<() => void> = [];
  let started = 0;
  const agents = new SubagentManager({ runtimeFactory: () => new Builder() });
  cleanup.push(() => agents.close());
  const host: AutoBuildHost = { root: repo, homeDir: home, projectContext: "rules",
    runBuilder: async (options: BuilderRunOptions): Promise<SubagentResult> => {
      started++;
      await new Promise<void>((resolve) => { release.push(resolve); });
      return { role: "builder", cwd: options.cwd, goal: options.goal, status: "completed", response: "done", toolsUsed: [], toolErrors: [], truncated: false, usage: { tokens: 1, estimatedCost: 0 } };
    },
    shell: () => ({ wrap: async (command) => ({ command }), close: async () => {} }),
    observeEdit: () => {}, say: () => {} };
  const tool = agents.createTool(() => ({ cwd: repo, projectContext: "rules" }), undefined, autoBuilders(host, undefined, undefined));
  const calls = [1, 2, 3, 4].map((n) => tool.execute({ role: "builder", goal: `job ${n}` }));
  const fourth = await calls[3]!;
  expect(data(fourth.text).error).toBe(`${BUILDER_LIMITS.maxConcurrent} builders are already working; wait for one to finish`);
  const limit = performance.now() + 10_000;
  while (started < 3 && performance.now() < limit) await Bun.sleep(10);
  expect(started).toBe(3);
  for (const resolve of release) resolve();
  for (const call of calls.slice(0, 3)) expect(data((await call).text).note).toBe("No changes were made; the copy was removed.");
  expect(await git(repo, "worktree", "list")).not.toContain("casper/crew-");
}, 30_000);

test("a builder's private paths stay private in its copy, and it gets the session's shell at the copy", async () => {
  const { home, repo } = await repository();
  Builder.seen = [];
  const agents = new SubagentManager({ runtimeFactory: () => new Builder(), privatePaths: () => [path.join(repo, "secret.txt")] });
  cleanup.push(() => agents.close());
  const shells: string[] = [];
  const edits: string[] = [];
  const outcome = await runAutoBuilder({ root: repo, homeDir: home, projectContext: "rules",
    runBuilder: (options) => agents.runBuilder(options),
    shell: (copy) => { shells.push(copy); return { wrap: async (command) => ({ command }), close: async () => {} }; },
    observeEdit: (file) => { edits.push(file); }, say: () => {} }, { goal: "write b.txt" });
  const options = Builder.seen[0]!;
  expect(shells).toEqual([options.cwd]);
  expect(options.privatePaths).toEqual(expect.arrayContaining([path.join(repo, "secret.txt"), path.join(options.cwd, "secret.txt")]));
  expect(options.shell).toBeDefined();
  // The same hidden-secret check as the main session: the marker never goes back into a file.
  expect(options.beforeToolGate!("write", { path: "b.txt", content: "password <secret hidden>" })).toBe(NOT_WRITTEN_REASON);
  expect(options.beforeToolGate!("edit", { path: "b.txt", edits: [{ oldText: "x", newText: "<line hidden: secret>" }] })).toBe(NOT_WRITTEN_REASON);
  expect(options.beforeToolGate!("bash", { command: "sed -i 's/x/<secret hidden>/' b.txt" })).toBe(NOT_RUN_REASON);
  expect(options.beforeToolGate!("write", { path: "/elsewhere/b.txt", content: "x" })).toContain("outside your copy");
  expect(options.beforeToolGate!("write", { path: "b.txt", content: "x" })).toBeUndefined();
  expect(outcome.report.applied).toEqual(["b.txt"]);
  expect(edits).toEqual([path.join(repo, "b.txt")]);
}, 30_000);

test("a builder's change next to yours in the same file is not merged in: the whole file counts", async () => {
  const { home, repo } = await repository();
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  await writeFile(path.join(repo, "long.txt"), `${lines.join("\n")}\n`);
  await git(repo, "add", "-A"); await git(repo, "commit", "-m", "long");
  const outcome = await runAutoBuilder({ root: repo, homeDir: home, projectContext: "rules",
    runBuilder: async (options) => {
      await writeFile(path.join(options.cwd, "long.txt"), `${["builder", ...lines.slice(1)].join("\n")}\n`);
      await writeFile(path.join(repo, "long.txt"), `${[...lines.slice(0, -1), "yours"].join("\n")}\n`);
      return { role: "builder", cwd: options.cwd, goal: options.goal, status: "completed", response: "done", toolsUsed: [], toolErrors: [], truncated: false, usage: null };
    },
    shell: () => ({ wrap: async (command) => ({ command }), close: async () => {} }), observeEdit: () => {}, say: () => {} }, { goal: "edit long.txt" });
  expect((outcome.report.kept as { why: string }).why).toContain("long.txt changed in your folder too");
  expect(await readFile(path.join(repo, "long.txt"), "utf8")).toStartWith("line 0\n");
}, 30_000);

test("the footer shows running builders and what they spent so far", () => {
  const run = (role: "builder" | "explorer", estimatedCost: number) => ({ id: 1, role, goal: "g", startedAt: 0, spent: { tokens: 500, estimatedCost } });
  expect(buildersText({ subagents: { runs: () => [] } } as never)).toBe("");
  expect(buildersText({ subagents: { runs: () => [run("builder", 0.05), run("builder", 0.07), run("explorer", 1)] } } as never)).toBe(" │ 2 builders · $0.12");
  expect(buildersText({ subagents: { runs: () => [run("builder", 0)] } } as never)).toBe(" │ 1 builder · 500 tok");
});

const done = (options: BuilderRunOptions): SubagentResult => ({ role: "builder", cwd: options.cwd, goal: options.goal, status: "completed", response: "done",
  toolsUsed: [], toolErrors: [], truncated: false, usage: null });
const quietHost = (repo: string, home: string, runBuilder: AutoBuildHost["runBuilder"]): AutoBuildHost => ({ root: repo, homeDir: home, projectContext: "rules",
  runBuilder, shell: () => ({ wrap: async (command) => ({ command }), close: async () => {} }), observeEdit: () => {}, say: () => {} });

test("a change that would write the hidden-secret marker into a file is kept in its copy, not applied", async () => {
  const { home, repo } = await repository();
  await writeFile(path.join(repo, "switch.cfg"), "hostname core\npassword real-one\n");
  await git(repo, "add", "-A"); await git(repo, "commit", "-m", "config");
  const outcome = await runAutoBuilder(quietHost(repo, home, async (options) => {
    await writeFile(path.join(options.cwd, "switch.cfg"), "hostname edge\npassword <secret hidden>\n");
    return done(options);
  }), { goal: "rename the switch" });
  expect(outcome.isError).toBe(true);
  expect((outcome.report.kept as { why: string }).why).toContain("<secret hidden>");
  expect(await readFile(path.join(repo, "switch.cfg"), "utf8")).toBe("hostname core\npassword real-one\n");
}, 30_000);

test("builders start from the folder as it is: your unsaved and new files are in the copy, and its change lands on top", async () => {
  const { home, repo } = await repository();
  await writeFile(path.join(repo, "a.txt"), "a.txt\nyours\n");
  await writeFile(path.join(repo, "types.txt"), "new type\n");
  let seen = "";
  const outcome = await runAutoBuilder(quietHost(repo, home, async (options) => {
    seen = await readFile(path.join(options.cwd, "types.txt"), "utf8");
    await writeFile(path.join(options.cwd, "a.txt"), `${await readFile(path.join(options.cwd, "a.txt"), "utf8")}builder\n`);
    await writeFile(path.join(options.cwd, "b.txt"), "uses the new type\n");
    return done(options);
  }), { goal: "use the new type" });
  expect(seen).toBe("new type\n");
  expect(outcome.report.applied).toEqual(["a.txt", "b.txt"]);
  expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("a.txt\nyours\nbuilder\n");
  expect(await readFile(path.join(repo, "types.txt"), "utf8")).toBe("new type\n");
  expect((await git(repo, "log", "--oneline")).trim().split("\n")).toHaveLength(1);
  expect(await git(repo, "worktree", "list")).not.toContain("casper/crew-");
}, 30_000);

/** A builder that spends `cost` on its first response, then asks to run a tool. */
class SpendingBuilder implements AgentRuntime {
  static waits: Array<string | undefined> = [];
  constructor(private readonly cost: number) {}
  async start(): Promise<RuntimeSession> { throw new Error("not the main session"); }
  async startBuilder(options: RuntimeBuilderStartOptions): Promise<RuntimeSession> {
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
    return {
      prompt: async () => {
        emit({ type: "assistant_response_start" });
        await writeFile(path.join(options.cwd, "b.txt"), "half done\n");
        emit({ type: "assistant_response_end", stopReason: "toolUse", usage: { tokens: 1000, estimatedCost: this.cost } });
        SpendingBuilder.waits.push(await options.beforeToolWait?.("bash", options.signal));
        emit({ type: "assistant_response_start" });
        emit({ type: "assistant_text_delta", delta: "Done." });
        emit({ type: "assistant_response_end", stopReason: "stop", usage: { tokens: 10, estimatedCost: 0 } });
      },
      abort: async () => {}, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

test("a running builder's spend counts toward the task's pause: crossing it stops the builder and keeps its copy", async () => {
  const { home, repo } = await repository();
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper", "config.yaml"), "spend:\n  pauseAt: 5\n");
  SpendingBuilder.waits = [];
  let result: { text: string; isError?: boolean } | undefined;
  const main = new Main(async (delegate) => { result = await build(delegate, "write b.txt"); });
  const { casper, output } = await app(repo, home, main, () => new SpendingBuilder(6));
  await casper.runOnce("Change b.txt", repo);
  expect(SpendingBuilder.waits).toEqual([SPEND_STOP_REASON]);
  const report = data(result!.text);
  expect(report.applied).toEqual([]);
  expect(report.kept.why).toContain("was stopped");
  expect(await readFile(path.join(repo, "b.txt"), "utf8")).toBe("b.txt\n");
  expect(output()).toContain("[spend] This task has used $6.00");
  expect(casper.getLastTaskResult()?.spendLimit).toBeDefined();
}, 30_000);

test("under the pause a builder's tool calls are not held", async () => {
  const { home, repo } = await repository();
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper", "config.yaml"), "spend:\n  pauseAt: 5\n");
  SpendingBuilder.waits = [];
  let result: { text: string; isError?: boolean } | undefined;
  const main = new Main(async (delegate) => { result = await build(delegate, "write b.txt"); });
  const { casper } = await app(repo, home, main, () => new SpendingBuilder(1));
  await casper.runOnce("Change b.txt", repo);
  expect(SpendingBuilder.waits).toEqual([undefined]);
  expect(data(result!.text).applied).toEqual(["b.txt"]);
}, 30_000);
