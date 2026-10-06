import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import type { BuilderRunOptions, SubagentResult } from "../src/agents/manager";
import { CasperApp } from "../src/app";
import { APPLY_COPY, CREW_QUESTION, DROP_COPY, KEEP_COPY, runCrewCommand, type CrewHost } from "../src/crew/command";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeBuilderStartOptions, RuntimeEventListener, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const git = async (cwd: string, ...args: string[]) => String((await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout);

async function repository(init = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-crew-command-")));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"); const repo = path.join(root, "repo");
  await mkdir(home); await mkdir(repo);
  await writeFile(path.join(repo, "a.txt"), "a\n");
  if (init) {
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "core.autocrlf", "false");
    await git(repo, "config", "user.name", "Casper Test");
    await git(repo, "config", "user.email", "casper@example.invalid");
    await git(repo, "add", "-A"); await git(repo, "commit", "-m", "base");
  }
  return { home, repo };
}

const done = (options: BuilderRunOptions, response = "Changed a.txt."): SubagentResult => ({ role: "builder", cwd: options.cwd, goal: options.goal,
  status: "completed", response, toolsUsed: ["edit"], toolErrors: [], truncated: false, usage: { tokens: 1200, estimatedCost: 0.04 } });

function host(root: string, homeDir: string, build: (options: BuilderRunOptions) => Promise<void>, answer?: string) {
  const text: string[] = [];
  const asked: Array<{ question: string; labels: string[] }> = [];
  const jobs: BuilderRunOptions[] = [];
  let closed = 0;
  const value: CrewHost = {
    root, homeDir, projectContext: "Project rules",
    write: (line) => { text.push(line); },
    canAsk: () => answer !== undefined,
    pick: async (question, options) => { asked.push({ question, labels: options.map((option) => option.label) }); return answer; },
    runBuilder: async (options) => { jobs.push(options); await build(options); return done(options); },
    shell: (_copy, note) => { note("[shell] Not run: the AI's command reaches build-server, and this run can't ask you. Nothing was sent."); return { wrap: async (command) => ({ command }), close: async () => { closed++; } }; },
  };
  return { value, text: () => text.join(""), asked, jobs, closed: () => closed };
}

test("/crew outside a Git repository says so in one line and starts nothing", async () => {
  const { home, repo } = await repository(false);
  const crew = host(repo, home, async () => {});
  await runCrewCommand(crew.value, "add a flag");
  expect(crew.text()).toContain("A crew needs a Git repository");
  expect(crew.jobs).toHaveLength(0);
});

test("/crew runs a builder in its own copy; your folder changes only when you pick Apply", async () => {
  const { home, repo } = await repository();
  await writeFile(path.join(repo, "mine.txt"), "yours\n");
  let seenInMain: string | undefined;
  const crew = host(repo, home, async (options) => {
    expect(options.cwd).not.toBe(repo);
    expect(options.projectContext).toBe("Project rules");
    expect(options.shell).toBeDefined();
    await writeFile(path.join(options.cwd, "a.txt"), "crew\n");
    seenInMain = await readFile(path.join(repo, "a.txt"), "utf8");
  }, APPLY_COPY);
  await runCrewCommand(crew.value, "change a.txt");
  expect(seenInMain).toBe("a\n");
  expect(crew.jobs[0]!.goal).toBe("change a.txt");
  expect(crew.asked).toEqual([{ question: CREW_QUESTION, labels: [KEEP_COPY, APPLY_COPY, DROP_COPY] }]);
  expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("crew\n");
  expect(await readFile(path.join(repo, "mine.txt"), "utf8")).toBe("yours\n");
  const out = crew.text();
  expect(out).toContain("Your uncommitted changes are not in the copy.");
  expect(out).toContain("Builder 1 finished · 1,200 tokens · about $0.04");
  expect(out).toContain("Changed a.txt.");
  expect(out).toContain("Not run (it needed your OK):");
  expect(out).toContain("reaches build-server");
  expect(out).toContain("Applied to your folder, uncommitted (1 file)");
  expect(crew.closed()).toBe(1);
  expect(await git(repo, "worktree", "list")).not.toContain("casper/crew-");
  expect(await git(repo, "branch", "--list", "casper/*")).toBe("");
});

test("a copy kept when nobody can answer is listed by /crew and applied or thrown away later", async () => {
  const { home, repo } = await repository();
  const crew = host(repo, home, async (options) => { await writeFile(path.join(options.cwd, "new.txt"), "new\n"); });
  await runCrewCommand(crew.value, "add new.txt");
  expect(crew.text()).toContain("/crew applies it or throws it away");
  await expect(readFile(path.join(repo, "new.txt"), "utf8")).rejects.toThrow();
  await runCrewCommand(crew.value, "add other.txt");
  expect(crew.text()).toContain("1 crew copy is still here from before");
  const listing = host(repo, home, async () => {});
  await runCrewCommand(listing.value, "");
  expect(listing.text()).toMatch(/1 casper\/crew-[a-z0-9]{6}-1 · 1 file changed/);
  expect(listing.text()).toContain("/crew apply <n> or /crew drop <n>");
  await runCrewCommand(listing.value, "drop 2");
  expect(listing.text()).toContain("Thrown away");
  await runCrewCommand(listing.value, "apply 1");
  expect(await readFile(path.join(repo, "new.txt"), "utf8")).toBe("new\n");
  await runCrewCommand(listing.value, "");
  expect(listing.text()).toContain("No crew copies here.");
});

test("a builder that changed nothing leaves no copy; Throw it away keeps your folder as it was", async () => {
  const { home, repo } = await repository();
  const idle = host(repo, home, async () => {}, KEEP_COPY);
  await runCrewCommand(idle.value, "look around");
  expect(idle.text()).toContain("No changes were made; the copy was removed.");
  expect(idle.asked).toHaveLength(0);
  const dropped = host(repo, home, async (options) => { await writeFile(path.join(options.cwd, "a.txt"), "crew\n"); }, DROP_COPY);
  await runCrewCommand(dropped.value, "change a.txt");
  expect(dropped.text()).toContain("Thrown away; the files are kept at");
  expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("a\n");
  expect(await git(repo, "worktree", "list")).not.toContain("casper/crew-");
});

test("no builder starts without the session's shell around it", async () => {
  const { home, repo } = await repository();
  const crew = host(repo, home, async () => {});
  crew.value.shell = () => undefined;
  await runCrewCommand(crew.value, "change a.txt");
  expect(crew.text()).toContain("Not started");
  expect(crew.jobs).toHaveLength(0);
  expect(await git(repo, "worktree", "list")).not.toContain("casper/crew-");
});

class Builder implements AgentRuntime {
  options?: RuntimeBuilderStartOptions;
  async start(): Promise<RuntimeSession> { throw new Error("not the main session"); }
  async startBuilder(options: RuntimeBuilderStartOptions): Promise<RuntimeSession> {
    this.options = options;
    const listeners = new Set<RuntimeEventListener>();
    return {
      prompt: async () => {
        await writeFile(path.join(options.cwd, "a.txt"), "from the builder\n");
        for (const listener of listeners) listener({ type: "assistant_text_delta", delta: "Wrote a.txt." });
      },
      abort: async () => {}, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

test("/crew in Casper gives the builder the session's sandboxed shell and keeps the copy for /crew apply", async () => {
  const { home, repo } = await repository();
  await mkdir(path.join(repo, ".casper"));
  await writeFile(path.join(repo, ".casper", "project.yaml"), stringify({ name: "crew-app" }));
  const builder = new Builder();
  const output: string[] = [];
  const app = new CasperApp({ runtimeFactory: () => { throw new Error("no model"); }, subagentRuntimeFactory: () => builder,
    output: { write: (text) => { output.push(text); } }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ homeDir: home, projectRoot: context.info.root }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  cleanup.push(() => app.close().catch(() => {}));
  await app.start(repo);
  await app.runOnce("/crew change a.txt");
  expect(builder.options?.shell).toBeDefined();
  expect(builder.options?.cwd).toContain(path.join(".casper", "worktrees"));
  expect(output.join("")).toContain("Wrote a.txt.");
  expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("a\n");
  await app.runOnce("/crew apply 1");
  expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("from the builder\n");
});
