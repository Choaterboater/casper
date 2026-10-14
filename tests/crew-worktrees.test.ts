import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BuilderRunOptions, SubagentResult } from "../src/agents/manager";
import { builderAvailability, runAutoBuilder, type AutoBuildHost } from "../src/crew/auto";
import { APPLY_COPY, KEEP_COPY, runCrewCommand, type CrewHost } from "../src/crew/command";
import { GitWorktreeManager } from "../src/workspace/worktree";
import { removeTempDir } from "./support/temp-dir";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => String((await exec("git", args, { cwd, encoding: "utf8" })).stdout);
const cleanup: string[] = [];
afterEach(async () => { for (const root of cleanup.splice(0)) await removeTempDir(root); });

async function repository() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-crew-worktrees-")));
  cleanup.push(root);
  const repo = path.join(root, "repo"), home = path.join(root, "home"), source = path.join(root, "source");
  await mkdir(repo); await mkdir(home);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "core.autocrlf", "false");
  await git(repo, "config", "user.name", "Casper Test");
  await git(repo, "config", "user.email", "casper@example.invalid");
  await writeFile(path.join(repo, "a.txt"), "base\n");
  await writeFile(path.join(repo, "b.txt"), "base b\n");
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "base");
  await git(repo, "worktree", "add", "-b", "topic", source);
  await writeFile(path.join(source, "a.txt"), "topic\n");
  await git(source, "commit", "-am", "topic");
  const manager = (await GitWorktreeManager.open(source, home))!;
  const mainStatus = await git(repo, "status", "--porcelain=v1");
  const untouched = async () => {
    expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("base\n");
    expect(await readFile(path.join(repo, "b.txt"), "utf8")).toBe("base b\n");
    expect(await git(repo, "status", "--porcelain=v1")).toBe(mainStatus);
  };
  return { root, repo, home, source, manager, untouched };
}

function host(root: string, homeDir: string, answer = KEEP_COPY) {
  const output: string[] = [], jobs: BuilderRunOptions[] = [], edits: string[] = [];
  const value: CrewHost & AutoBuildHost = {
    root, homeDir, projectContext: "Project rules", write: (text) => { output.push(text); }, say: (text) => { output.push(text); },
    canAsk: () => true, pick: async () => answer,
    shell: () => ({ wrap: async (command) => ({ command }), close: async () => {} }),
    observeEdit: (file) => { edits.push(file); },
    runBuilder: async (options): Promise<SubagentResult> => {
      jobs.push(options);
      await writeFile(path.join(options.cwd, "a.txt"), "crew\n");
      return { role: "builder", cwd: options.cwd, goal: options.goal, status: "completed", response: "Changed a.txt.",
        toolsUsed: ["write"], toolErrors: [], truncated: false, usage: { tokens: 10, estimatedCost: 0 } };
    },
  };
  return { value, output: () => output.join(""), jobs, edits };
}

test("/crew starts from a linked worktree and Apply changes only that folder, leaving main files and status untouched", async () => {
  const { source, repo, home, untouched } = await repository();
  const crew = host(source, home, APPLY_COPY);
  await runCrewCommand(crew.value, "change a.txt");
  expect(crew.jobs).toHaveLength(1);
  expect(crew.jobs[0]!.main).toBe(source);
  expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("crew\n");
  expect(crew.output()).toContain("Applied to your folder, uncommitted (1 file)");
  expect(await git(repo, "branch", "--list", "casper/*")).toBe("");
  await untouched();
});

test("the crews guide and unreleased notes explain worktree origins, restart persistence and orphan handling", async () => {
  const guide = await readFile(new URL("../docs/CREWS.md", import.meta.url), "utf8");
  expect(guide).toContain("Both `/crew` and the AI's builders work from any Git worktree of the project");
  expect(guide).toContain("this survives a restart");
  expect(guide).toContain("copy stays listed with a plain reason");
  expect(guide).toContain("crews cannot nest");
  const release = (await readFile(new URL("../docs/RELEASE.md", import.meta.url), "utf8")).split("## v0.2.34:")[0]!;
  expect(release).toContain("Crews from any project worktree");
  expect(release).toContain("never apply elsewhere");
  const page = await readFile(new URL("../site/roadmap.html", import.meta.url), "utf8");
  const roadmap = page.slice(page.indexOf('id="v0235"'), page.indexOf('id="v0234"'));
  expect(roadmap).toContain("remembered across restarts");
  expect(roadmap).toContain("never apply elsewhere");
});

test("the AI's builders are offered in a linked worktree", async () => {
  const { source, home } = await repository();
  expect(await builderAvailability({ root: source, homeDir: home, off: false, sandbox: "ready" })).toBeUndefined();
});

test("an AI-started builder applies and observes edits in its originating worktree only", async () => {
  const { source, home, untouched } = await repository();
  const crew = host(source, home);
  const result = await runAutoBuilder(crew.value, { goal: "change a.txt" });
  expect(result.report.applied).toEqual(["a.txt"]);
  expect(crew.jobs[0]!.main).toBe(source);
  expect(crew.edits).toEqual([path.join(source, "a.txt")]);
  expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("crew\n");
  await untouched();
});

test("each crew remembers its own originating folder when different worktrees start copies", async () => {
  const { source, repo, manager, untouched } = await repository();
  const fromTopic = await manager.create(await manager.planCrew("abc123", 1, source));
  const fromMain = await manager.create(await manager.planCrew("def456", 1, repo));
  expect(fromTopic.mainWorkspace).toBe(source);
  expect(fromMain.mainWorkspace).toBe(repo);
  await writeFile(path.join(fromTopic.path, "a.txt"), "crew\n");
  await manager.applyCrew(fromTopic, await manager.capturePatch(fromTopic));
  expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("crew\n");
  await untouched();
});

test("a fresh manager lists the saved source and base and applies there after restart", async () => {
  const { repo, source, home, manager, untouched } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, source));
  await writeFile(path.join(copy.path, "a.txt"), "crew\n");
  await git(copy.path, "commit", "-am", "builder");
  const fresh = (await GitWorktreeManager.open(repo, home))!;
  const [found] = await fresh.crewCopies();
  expect(found).toMatchObject({ mainWorkspace: source, baseCommit: copy.baseCommit });
  await fresh.applyCrew(found!, await fresh.capturePatch(found!));
  expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("crew\n");
  await untouched();
});

test("a restarted AI copy preserves its unsaved-folder base, and applies only its builder's changes", async () => {
  const { repo, source, home, manager, untouched } = await repository();
  await writeFile(path.join(source, "a.txt"), "unsaved\n");
  const copy = await manager.create(await manager.planCrew("abc123", 1, source, { fromFolder: true }));
  await writeFile(path.join(copy.path, "a.txt"), "unsaved\ncrew\n");
  const fresh = (await GitWorktreeManager.open(repo, home))!;
  const [found] = await fresh.crewCopies();
  expect(found).toMatchObject({ mainWorkspace: source, baseCommit: copy.baseCommit, startHead: copy.startHead });
  await fresh.applyCrew(found!, await fresh.capturePatch(found!), { wholeFiles: true });
  expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("unsaved\ncrew\n");
  await untouched();
});

test("a removed source is listed with a plain reason, never applied, and can be kept or thrown away", async () => {
  const { source, repo, home, manager, untouched } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, source));
  await writeFile(path.join(copy.path, "a.txt"), "crew\n");
  await git(repo, "worktree", "remove", source);
  const fresh = (await GitWorktreeManager.open(repo, home))!;
  const [found] = await fresh.crewCopies();
  expect(found).toMatchObject({ path: copy.path, mainWorkspace: source });
  const patch = await fresh.capturePatch(found!);
  await expect(fresh.applyCrew(found!, patch)).rejects.toThrow(/source folder is missing/i);
  const listing = host(repo, home);
  await runCrewCommand(listing.value, "");
  expect(listing.output()).toContain(copy.branch);
  expect(listing.output()).toMatch(/source folder is missing/i);
  expect(await readFile(path.join(copy.path, "a.txt"), "utf8")).toBe("crew\n");
  await runCrewCommand(listing.value, "apply 1");
  expect(listing.output()).toContain("Not applied:");
  await untouched();
  await runCrewCommand(listing.value, "drop 1");
  expect(listing.output()).toContain("Thrown away");
  expect(await fresh.crewCopies()).toEqual([]);
});

test("a source replaced by another repository stays listed but cannot receive the crew's work", async () => {
  const { source, repo, home, manager, untouched } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, source));
  await writeFile(path.join(copy.path, "a.txt"), "crew\n");
  await git(repo, "worktree", "remove", source);
  await mkdir(source); await git(source, "init", "-b", "other");
  await writeFile(path.join(source, "a.txt"), "other\n");
  const fresh = (await GitWorktreeManager.open(repo, home))!;
  const [found] = await fresh.crewCopies();
  expect(found!.mainWorkspace).toBe(source);
  await expect(fresh.applyCrew(found!, await fresh.capturePatch(found!))).rejects.toThrow(/no longer a worktree of this repository/i);
  expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("other\n");
  expect(await fresh.remove(found!, await fresh.capturePatch(found!))).toBeDefined();
  await untouched();
});

test("/crew cannot nest inside another crew's managed copy", async () => {
  const { repo, home, manager } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, repo));
  const nested = host(copy.path, home);
  await runCrewCommand(nested.value, "change a.txt");
  expect(nested.jobs).toHaveLength(0);
  expect(nested.output()).toMatch(/cannot start inside another crew copy/i);
});

test("AI builders cannot nest inside another crew's managed copy", async () => {
  const { repo, home, manager } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, repo));
  expect(await builderAvailability({ root: copy.path, homeDir: home, off: false, sandbox: "ready" })).toMatch(/another crew copy/i);
  const nested = host(copy.path, home);
  await expect(runAutoBuilder(nested.value, { goal: "change a.txt" })).rejects.toThrow(/cannot start inside another crew copy/i);
  expect(nested.jobs).toHaveLength(0);
});

test("main-checkout /crew keeps its existing apply message and cleanup", async () => {
  const { repo, home } = await repository();
  const crew = host(repo, home, APPLY_COPY);
  await runCrewCommand(crew.value, "change a.txt");
  expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("crew\n");
  expect(crew.output()).toContain("Applied to your folder, uncommitted (1 file). git diff shows it.");
  expect(await git(repo, "branch", "--list", "casper/*")).toBe("");
});

test("whole-file conflict checks use the originating worktree, never the main checkout", async () => {
  const { source, manager, untouched } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, source, { fromFolder: true }));
  await writeFile(path.join(copy.path, "b.txt"), "crew b\n");
  await writeFile(path.join(source, "b.txt"), "yours\n");
  expect(await manager.changedInFolder(copy, ["b.txt"])).toEqual(["b.txt"]);
  await expect(manager.applyCrew(copy, await manager.capturePatch(copy), { wholeFiles: true })).rejects.toThrow("b.txt changed in your folder too");
  expect(await readFile(path.join(source, "b.txt"), "utf8")).toBe("yours\n");
  await untouched();
});

test("crew source and base are saved atomically before registration, so an interrupted creation remains recoverable", async () => {
  const { repo, source, home, manager, untouched } = await repository();
  const plan = await manager.planCrew("abc123", 1, source);
  const spawn = Bun.spawn;
  let registered = false;
  let saved: { mainWorkspace: string; baseCommit: string } | undefined;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const command = Array.isArray(args[0]) ? args[0] as string[] : (args[0] as { cmd?: string[] }).cmd ?? [];
    if (command.includes("config") && command.includes(`branch.${plan.branch}.casperCrew`) && !command.includes("--get")) {
      saved = JSON.parse(command.at(-1)!);
    }
    if (command.includes("worktree") && command.includes("add")) {
      expect(saved).toEqual({ mainWorkspace: source, baseCommit: plan.baseCommit });
      registered = true;
    } else if (registered && command.includes("worktree") && command.includes("list")) {
      // Stop the post-registration validation and rollback discovery, as an interrupted process would.
      throw new Error("simulated interruption after registration");
    }
    return spawn(...args);
  }) as typeof Bun.spawn;
  try { await expect(manager.create(plan)).rejects.toThrow("simulated interruption"); }
  finally { Bun.spawn = spawn; }
  expect(registered).toBe(true);
  await writeFile(path.join(plan.path, "a.txt"), "crew\n");
  await git(repo, "worktree", "remove", source);
  const fresh = (await GitWorktreeManager.open(repo, home))!;
  const [found] = await fresh.crewCopies();
  expect(found).toMatchObject({ mainWorkspace: source, baseCommit: plan.baseCommit });
  await expect(fresh.applyCrew(found!, await fresh.capturePatch(found!))).rejects.toThrow("source folder is missing");
  expect(await fresh.remove(found!, await fresh.capturePatch(found!))).toBeDefined();
  await untouched();
});

test("a committed linked worktree can start manual and AI crews when primary HEAD is unborn", async () => {
  const { repo, source, home } = await repository();
  await git(repo, "symbolic-ref", "HEAD", "refs/heads/unborn");
  const status = await git(repo, "status", "--porcelain=v1");
  expect(await builderAvailability({ root: source, homeDir: home, off: false, sandbox: "ready" })).toBeUndefined();
  const manual = host(source, home, APPLY_COPY);
  await runCrewCommand(manual.value, "change a.txt");
  expect(manual.jobs).toHaveLength(1);
  expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("crew\n");
  await writeFile(path.join(source, "a.txt"), "topic\n");
  expect((await runAutoBuilder(host(source, home).value, { goal: "change a.txt" })).report.applied).toEqual(["a.txt"]);
  expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("base\n");
  expect(await git(repo, "status", "--porcelain=v1")).toBe(status);
});

test("an orphan crew is listed and can be dropped even when primary HEAD is unborn", async () => {
  const { repo, source, home, manager } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, source));
  await writeFile(path.join(copy.path, "a.txt"), "crew\n");
  await git(repo, "worktree", "remove", source);
  await git(repo, "symbolic-ref", "HEAD", "refs/heads/unborn");
  const listing = host(repo, home);
  await runCrewCommand(listing.value, "");
  expect(listing.output()).toContain(copy.branch);
  expect(listing.output()).toContain("source folder is missing");
  await runCrewCommand(listing.value, "drop 1");
  expect(listing.output()).toContain("Thrown away");
});

test("crews can start from a detached linked worktree of the same repository", async () => {
  const { source, home, untouched } = await repository();
  await git(source, "switch", "--detach");
  const crew = host(source, home, APPLY_COPY);
  await runCrewCommand(crew.value, "change a.txt");
  expect(crew.jobs).toHaveLength(1);
  expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("crew\n");
  await untouched();
});

test("/crew can start in a managed /branch experiment and applies only to that experiment", async () => {
  const { repo, home, manager, untouched } = await repository();
  const experiment = await manager.create(await manager.plan("experiment", repo));
  const crew = host(experiment.path, home, APPLY_COPY);
  await runCrewCommand(crew.value, "change a.txt");
  expect(crew.jobs).toHaveLength(1);
  expect(await readFile(path.join(experiment.path, "a.txt"), "utf8")).toBe("crew\n");
  await untouched();
});

test("AI builders can start in a managed /branch experiment and apply only there", async () => {
  const { repo, home, manager, untouched } = await repository();
  const experiment = await manager.create(await manager.plan("experiment", repo));
  expect(await builderAvailability({ root: experiment.path, homeDir: home, off: false, sandbox: "ready" })).toBeUndefined();
  const crew = host(experiment.path, home);
  expect((await runAutoBuilder(crew.value, { goal: "change a.txt" })).report.applied).toEqual(["a.txt"]);
  expect(crew.edits).toEqual([path.join(experiment.path, "a.txt")]);
  await untouched();
});

test("a crew whose branch is detached still cannot start another crew from a subfolder", async () => {
  const { repo, home, manager } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, repo));
  await git(copy.path, "switch", "--detach");
  const inside = path.join(copy.path, "inside");
  await mkdir(inside);
  await expect(manager.planCrew("def456", 1, inside)).rejects.toThrow("cannot start inside another crew copy");
  expect(await builderAvailability({ root: inside, homeDir: home, off: false, sandbox: "ready" })).toContain("another crew copy");
});

test("a registered crew cannot nest by using another state home", async () => {
  const { repo, root, manager } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, repo));
  const home = path.join(root, "other-home");
  await mkdir(home);
  const nested = host(copy.path, home);
  await runCrewCommand(nested.value, "change a.txt");
  expect(nested.jobs).toHaveLength(0);
  expect(nested.output()).toContain("cannot start inside another crew copy");
});

test("a crew plan from another repository is still refused", async () => {
  const { root, manager } = await repository();
  const other = path.join(root, "other");
  await mkdir(other); await git(other, "init", "-b", "main");
  await expect(manager.planCrew("abc123", 1, other)).rejects.toThrow(/repository/i);
});

test("legacy main-origin copies without source metadata are still listed and applied as before", async () => {
  const { repo, home, manager } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, repo));
  await git(repo, "config", "--local", "--remove-section", `branch.${copy.branch}`).catch(() => {});
  await writeFile(path.join(copy.path, "a.txt"), "crew\n");
  const fresh = (await GitWorktreeManager.open(repo, home))!;
  const [found] = await fresh.crewCopies();
  expect(found).toMatchObject({ mainWorkspace: repo, baseCommit: copy.baseCommit });
  await fresh.applyCrew(found!, await fresh.capturePatch(found!));
  expect(await readFile(path.join(repo, "a.txt"), "utf8")).toBe("crew\n");
});

test("a relation cannot redirect crew work to another worktree of the same repository", async () => {
  const { repo, source, manager, untouched } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, source));
  await writeFile(path.join(copy.path, "a.txt"), "crew\n");
  await expect(manager.applyCrew({ ...copy, mainWorkspace: repo }, await manager.capturePatch(copy))).rejects.toThrow("does not match its saved source");
  await untouched();
});

test("the apply-check tests the source's clashing lines rather than main's clean file", async () => {
  const { source, home, untouched } = await repository();
  const crew = host(source, home);
  await runCrewCommand(crew.value, "change a.txt");
  await writeFile(path.join(source, "a.txt"), "yours\n");
  await runCrewCommand(crew.value, "apply 1");
  expect(crew.output()).toContain("a.txt changed in your folder too; nothing was applied");
  expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("yours\n");
  await untouched();
});

test("throwing away a linked-origin crew preserves its bytes without touching either checkout", async () => {
  const { repo, source, home, manager, untouched } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, source));
  await writeFile(path.join(copy.path, "a.txt"), "crew\n");
  const listing = host(repo, home);
  await runCrewCommand(listing.value, "");
  expect(listing.output()).toContain(`source: ${source}`);
  expect(await readFile(path.join(copy.path, "a.txt"), "utf8")).toBe("crew\n");
  const preserved = await manager.remove(copy, await manager.capturePatch(copy));
  expect(await readFile(path.join(preserved!, "a.txt"), "utf8")).toBe("crew\n");
  expect(await readFile(path.join(source, "a.txt"), "utf8")).toBe("topic\n");
  expect(await git(repo, "config", "--local", "--get", `branch.${copy.branch}.casperCrew`).catch(() => "")).toBe("");
  await untouched();
});

test("after restart a new source commit still blocks apply rather than moving the saved base", async () => {
  const { repo, source, home, manager, untouched } = await repository();
  const copy = await manager.create(await manager.planCrew("abc123", 1, source));
  await writeFile(path.join(copy.path, "a.txt"), "crew\n");
  await git(source, "commit", "--allow-empty", "-m", "later");
  const fresh = (await GitWorktreeManager.open(repo, home))!;
  const [found] = await fresh.crewCopies();
  expect(found!.baseCommit).toBe(copy.baseCommit);
  await expect(fresh.applyCrew(found!, await fresh.capturePatch(found!))).rejects.toThrow("Your folder has a new commit since the crew started");
  await untouched();
});
