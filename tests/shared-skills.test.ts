import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import type { ProjectModel } from "../src/project/model";
import { DEFAULT_SKILL_IMPORTS, SkillRegistry } from "../src/skills/registry";
import { classifyTask } from "../src/task/classify";
import { needsSymlinks } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => removeTempDir(directory))); });

const request = "Add a TypeScript MCP tool with bounded output";
const model: ProjectModel = {
  schemaVersion: 1, project: { name: "example", root: "/example", git: false },
  languages: ["typescript"], frameworks: [], packageManager: "bun", commands: {}, architecture: {}, conventions: [], detectedAt: "2026-01-01T00:00:00.000Z",
};
const tags = "tags: [mcp, tools]\nstacks: [typescript]\nintents: [implement]\n";

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-shared-skills-")));
  temporary.push(base);
  const homeDir = path.join(base, "home");
  const projectRoot = path.join(base, "project");
  await mkdir(homeDir); await mkdir(projectRoot);
  return { homeDir, projectRoot };
}

async function skill(directory: string, name: string, body: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: How we write MCP tools (${body})\n${tags}---\n${body}\n`);
}

const loaded = async (registry: SkillRegistry) => (await registry.loadForTask(request, model, classifyTask(request))).map((item) => item.body.trim());

test("every tool's personal skill folder is read by default, as yours", async () => {
  const f = await fixture();
  await skill(path.join(f.homeDir, ".agents/skills/a"), "from-agents", "AGENTS");
  await skill(path.join(f.homeDir, ".claude/skills/b"), "from-claude", "CLAUDE");
  await skill(path.join(f.homeDir, ".copilot/skills/c"), "from-copilot", "COPILOT");
  await skill(path.join(f.homeDir, ".pi/agent/skills/d"), "from-pi", "PI");
  await skill(path.join(f.homeDir, ".codex/skills/e"), "from-codex", "CODEX");
  const registry = await SkillRegistry.discover(f);
  const summaries = registry.list();
  expect(summaries.map((item) => item.name).sort()).toEqual(["from-agents", "from-claude", "from-codex", "from-copilot", "from-pi"]);
  expect(summaries.every((item) => item.source === "personal" && item.trust === "trusted")).toBe(true);
  expect((await loaded(registry)).sort()).toEqual(["AGENTS", "CLAUDE", "CODEX", "COPILOT", "PI"]);
});

needsSymlinks("a skill linked from one of your folders into another counts once; a link out of your folders is not yours", async () => {
  const f = await fixture();
  await skill(path.join(f.homeDir, ".agents/skills/shared"), "shared", "SHARED");
  await mkdir(path.join(f.homeDir, ".claude/skills"), { recursive: true });
  await symlink(path.join(f.homeDir, ".agents/skills/shared"), path.join(f.homeDir, ".claude/skills/shared"));
  await skill(path.join(f.projectRoot, "elsewhere/outside"), "outside", "OUTSIDE");
  await symlink(path.join(f.projectRoot, "elsewhere/outside"), path.join(f.homeDir, ".claude/skills/outside"));
  const registry = await SkillRegistry.discover(f);
  expect(registry.list().filter((item) => item.name === "shared")).toHaveLength(1);
  expect(registry.list().find((item) => item.name === "shared")).toMatchObject({ trust: "trusted" });
  expect(registry.list().find((item) => item.name === "outside")).toMatchObject({ trust: "untrusted" });
  expect(await loaded(registry)).toEqual(["SHARED"]);
});

test("a repository's skill folders are used only while you trust the folder", async () => {
  const f = await fixture();
  await skill(path.join(f.projectRoot, ".casper/skills/a"), "repo-casper", "REPO_CASPER");
  await skill(path.join(f.projectRoot, ".agents/skills/b"), "repo-agents", "REPO_AGENTS");
  await skill(path.join(f.projectRoot, ".claude/skills/c"), "repo-claude", "REPO_CLAUDE");
  await skill(path.join(f.projectRoot, ".github/skills/d"), "repo-github", "REPO_GITHUB");
  const registry = await SkillRegistry.discover(f);
  // Not trusted (the default until the session decides): listed, never used.
  expect(registry.list().map((item) => [item.name, item.source, item.trust]).sort()).toEqual([
    ["repo-agents", "project", "untrusted"], ["repo-casper", "project", "untrusted"], ["repo-claude", "project", "untrusted"], ["repo-github", "project", "untrusted"],
  ]);
  expect(await loaded(registry)).toEqual([]);
  registry.setFolderTrusted(true);
  expect(registry.list().every((item) => item.trust === "trusted")).toBe(true);
  expect((await loaded(registry)).sort()).toEqual(["REPO_AGENTS", "REPO_CASPER", "REPO_CLAUDE", "REPO_GITHUB"]);
  // Taking the trust back stops them at once.
  registry.setFolderTrusted(false);
  expect(await loaded(registry)).toEqual([]);
  // A block still wins in a trusted folder.
  registry.setFolderTrusted(true);
  await registry.block(registry.list().find((item) => item.name === "repo-claude")!.id);
  expect((await loaded(registry)).sort()).toEqual(["REPO_AGENTS", "REPO_CASPER", "REPO_GITHUB"]);
});

test("the same name in two places: yours first (~/.casper, then the other tools in order), then the project's; the rest are listed as not used", async () => {
  const f = await fixture();
  await skill(path.join(f.homeDir, ".claude/skills/x"), "same", "FROM_CLAUDE");
  await skill(path.join(f.projectRoot, ".casper/skills/x"), "same", "FROM_PROJECT");
  await skill(path.join(f.homeDir, ".agents/skills/x"), "same", "FROM_AGENTS");
  await skill(path.join(f.homeDir, ".casper/skills/x"), "same", "FROM_CASPER");
  const registry = await SkillRegistry.discover({ ...f, folderTrusted: true });
  expect(await loaded(registry)).toEqual(["FROM_CASPER"]);
  const used = registry.list().find((item) => item.sourceDirectory.endsWith(path.join(".casper", "skills")) && item.source === "user")!;
  const others = registry.list().filter((item) => item.name === "same" && item.id !== used.id);
  expect(others).toHaveLength(3);
  expect(others.every((item) => item.shadowedBy === used.id)).toBe(true);
  expect(registry.diagnostics.some((line) => line.includes("isn't used") && line.includes(used.id))).toBe(true);
  // Without ~/.casper's, ~/.agents comes before ~/.claude, and both before the project's.
  const g = await fixture();
  await skill(path.join(g.homeDir, ".claude/skills/x"), "same", "FROM_CLAUDE");
  await skill(path.join(g.projectRoot, ".claude/skills/x"), "same", "FROM_PROJECT");
  await skill(path.join(g.homeDir, ".agents/skills/x"), "same", "FROM_AGENTS");
  expect(await loaded(await SkillRegistry.discover({ ...g, folderTrusted: true }))).toEqual(["FROM_AGENTS"]);
});

test("only ~/.casper/skills may stand in for a bundled skill; another tool's skill of that name leaves the bundled one in use", async () => {
  const f = await fixture();
  await skill(path.join(f.homeDir, ".agents/skills/web"), "web-quality", "AGENTS_WEB");
  const registry = await SkillRegistry.discover({ ...f, bundled: true });
  const mine = registry.list().find((item) => item.name === "web-quality" && item.source === "personal")!;
  expect(mine).toBeDefined();
  expect(registry.diagnostics).toContain(`${mine.id} has the same name as a bundled Casper skill; the bundled one is used`);
});

test("skills.imports [] turns the other tools' folders off; the project's own .casper/skills still follows folder trust", async () => {
  const f = await fixture();
  await skill(path.join(f.homeDir, ".claude/skills/b"), "from-claude", "CLAUDE");
  await skill(path.join(f.projectRoot, ".agents/skills/b"), "repo-agents", "REPO_AGENTS");
  await skill(path.join(f.projectRoot, ".casper/skills/a"), "repo-casper", "REPO_CASPER");
  const registry = await SkillRegistry.discover({ ...f, imports: [], folderTrusted: true });
  expect(registry.list().map((item) => item.name)).toEqual(["repo-casper"]);
  const onlyClaude = await SkillRegistry.discover({ ...f, imports: ["claude"], folderTrusted: true });
  expect(onlyClaude.list().map((item) => item.name).sort()).toEqual(["from-claude", "repo-casper"]);
});

test("skills.imports defaults to every tool, accepts copilot, and stays yours: a project file can't set it", async () => {
  const f = await fixture();
  expect(DEFAULT_SKILL_IMPORTS).toEqual(["agents", "claude", "copilot", "pi", "codex"]);
  expect((await loadConfiguration(f)).skills.imports).toEqual([...DEFAULT_SKILL_IMPORTS]);
  await mkdir(path.join(f.homeDir, ".casper"), { recursive: true });
  await writeFile(path.join(f.homeDir, ".casper/config.yaml"), "skills: { imports: [copilot] }\n");
  expect((await loadConfiguration(f)).skills.imports).toEqual(["copilot"]);
  await writeFile(path.join(f.homeDir, ".casper/config.yaml"), "skills: { imports: [] }\n");
  expect((await loadConfiguration(f)).skills.imports).toEqual([]);
  await mkdir(path.join(f.projectRoot, ".casper"), { recursive: true });
  await writeFile(path.join(f.projectRoot, ".casper/project.yaml"), "skills: { imports: [claude] }\n");
  await expect(loadConfiguration(f)).rejects.toThrow("skills.imports is user/profile-only");
});
