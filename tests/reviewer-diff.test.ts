import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { CasperApp } from "../src/app";
import { namedFiles } from "../src/agents/manager";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener, RuntimeReadOnlyStartOptions, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const git = (cwd: string, ...args: string[]) => execFileAsync("git", args, { cwd });

/** A project with three files; a git repository unless `plain`. */
async function project(plain = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-reviewer-diff-")));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"); const repo = path.join(root, "repo");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(repo, "lib"), { recursive: true });
  await writeFile(path.join(repo, "lib", "ipv4.js"), "export const bits = 32;\nexport const signed = true;\n");
  await writeFile(path.join(repo, "lib", "vlans.js"), "export const max = 4095;\n");
  await writeFile(path.join(repo, "README.md"), "# demo\n");
  if (!plain) {
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "core.autocrlf", "false");
    await git(repo, "config", "user.name", "Casper Test");
    await git(repo, "config", "user.email", "casper@example.invalid");
    await git(repo, "add", "-A"); await git(repo, "commit", "-m", "base");
  }
  return { home, repo };
}

/** Read-only children that record their prompt and answer at once. */
class Readers implements AgentRuntime {
  static prompts: string[] = [];
  async start(): Promise<RuntimeSession> { throw new Error("not the main session"); }
  async startReadOnly(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
    return {
      prompt: async (text) => {
        Readers.prompts.push(text);
        emit({ type: "assistant_response_start" });
        emit({ type: "assistant_text_delta", delta: "No findings." });
        emit({ type: "assistant_response_end", stopReason: "stop", usage: { tokens: 10, estimatedCost: 0 } });
      },
      abort: async () => {}, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

/** The main model: edits files itself, then calls delegate. */
class Main implements AgentRuntime {
  tools: RuntimeTool[] = [];
  constructor(private readonly act: (delegate: RuntimeTool) => Promise<void>) {}
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.tools = options.tools ?? [];
    return {
      setTools: (tools) => { this.tools = tools; },
      prompt: async () => { await this.act(this.tools.find((tool) => tool.name === "delegate")!); },
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

async function run(repo: string, home: string, act: (delegate: RuntimeTool) => Promise<void>) {
  Readers.prompts = [];
  await mkdir(path.join(repo, ".casper"), { recursive: true });
  await writeFile(path.join(repo, ".casper", "project.yaml"), stringify({ name: "reviewer-diff" }));
  const casper = new CasperApp({ runtimeFactory: () => new Main(act), subagentRuntimeFactory: () => new Readers(), noSandbox: true,
    output: { write: () => {} }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ homeDir: home, projectRoot: context.info.root }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  cleanup.push(() => casper.close().catch(() => {}));
  await casper.start(repo);
  await casper.runOnce("Fix the address math", repo);
}

const status = (text: string) => JSON.parse(text).data.status;

for (const plain of [false, true]) {
  test(`a reviewer whose goal names a changed file gets its diff against the task's start, before the lead's context${plain ? " (not a git folder)" : ""}`, async () => {
    const { home, repo } = await project(plain);
    let reply: string | undefined;
    await run(repo, home, async (delegate) => {
      await writeFile(path.join(repo, "lib", "ipv4.js"), "export const bits = 32;\nexport const signed = false;\n");
      await writeFile(path.join(repo, "lib", "vlans.js"), "export const max = 4094;\n");
      reply = (await delegate.execute({ role: "reviewer", goal: "Review the unsigned fix in lib/ipv4.js.", context: "Keep the old output." })).text;
    });
    expect(status(reply!)).toBe("completed");
    expect(Readers.prompts).toHaveLength(1);
    const prompt = Readers.prompts[0]!;
    expect(prompt).toContain("This task's changes to lib/ipv4.js so far");
    expect(prompt).toContain("-export const signed = true;");
    expect(prompt).toContain("+export const signed = false;");
    // Only the named file: the other change is not handed over.
    expect(prompt).not.toContain("+export const max = 4094;");
    expect(prompt.indexOf("+export const signed = false;")).toBeLessThan(prompt.indexOf("Keep the old output."));
    // Told to judge from the diff and report early, not to survey the code.
    expect(prompt).toContain("Judge it from the diff");
    expect(prompt).toContain("Report by turn 6.");
  });
}

test("a reviewer whose goal names no changed file gets the lead's context only", async () => {
  const { home, repo } = await project();
  await run(repo, home, async (delegate) => {
    await writeFile(path.join(repo, "lib", "ipv4.js"), "export const bits = 32;\nexport const signed = false;\n");
    await delegate.execute({ role: "reviewer", goal: "Review README.md for typos.", context: "Plain words." });
  });
  const prompt = Readers.prompts[0]!;
  expect(prompt).not.toContain("This task's changes");
  expect(prompt).not.toContain("+export const signed = false;");
  expect(prompt).not.toContain("Judge it from the diff");
  expect(prompt).toContain("Plain words.");
});

test("an explorer is never handed the diff", async () => {
  const { home, repo } = await project();
  await run(repo, home, async (delegate) => {
    await writeFile(path.join(repo, "lib", "ipv4.js"), "export const bits = 32;\nexport const signed = false;\n");
    await delegate.execute({ role: "explorer", goal: "Where is lib/ipv4.js used?" });
  });
  expect(Readers.prompts[0]).not.toContain("This task's changes");
});

test("a secret in the changed file is hidden from the reviewer", async () => {
  const { home, repo } = await project();
  await run(repo, home, async (delegate) => {
    await writeFile(path.join(repo, "lib", "ipv4.js"), "export const bits = 32;\nAPI_KEY=sk-live-abcdef1234567890abcdef\n");
    await delegate.execute({ role: "reviewer", goal: "Review lib/ipv4.js" });
  });
  const prompt = Readers.prompts[0]!;
  expect(prompt).toContain("This task's changes to lib/ipv4.js");
  expect(prompt).not.toContain("sk-live-abcdef1234567890abcdef");
});

test("changed files are named by path, by the end of a longer path, or by a file name only they have", () => {
  const files = ["lib/ipv4.js", "lib/vlans.js", "src/a/index.ts", "src/b/index.ts", "README.md", "parser/src/expression.js"];
  expect(namedFiles(files, "Review lib/ipv4.js and lib/vlans.js.")).toEqual(["lib/ipv4.js", "lib/vlans.js"]);
  expect(namedFiles(files, "Read /tmp/work/parser/src/expression.js")).toEqual(["parser/src/expression.js"]);
  expect(namedFiles(files, "the change to `expression.js` parseExprSubscripts")).toEqual(["parser/src/expression.js"]);
  expect(namedFiles(files, "Windows: lib\\vlans.js")).toEqual(["lib/vlans.js"]);
  // Two changed files share the name: only a path picks one.
  expect(namedFiles(files, "look at index.ts")).toEqual([]);
  expect(namedFiles(files, "look at src/b/index.ts")).toEqual(["src/b/index.ts"]);
  // A longer name, another folder's file of that name, or a word inside another word is not a mention.
  expect(namedFiles(files, "ipv4.jsx, test/ipv4.js, myREADME.md, ipv4.js.map")).toEqual([]);
  expect(namedFiles(files, "README.md:3 says")).toEqual(["README.md"]);
});
