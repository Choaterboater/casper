import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import type { ProjectModel } from "../src/project/model";
import { SkillRegistry, formatSelectedSkills } from "../src/skills/registry";
import { classifyTask } from "../src/task/classify";

const temporary: string[] = [];
const task = "Add a TypeScript MCP tool with bounded output";
const model: ProjectModel = {
  schemaVersion: 1,
  project: { name: "example", root: "/example", git: false },
  languages: ["typescript"], frameworks: [], packageManager: "bun",
  commands: {}, architecture: {}, conventions: [], detectedAt: "2026-01-01T00:00:00.000Z",
};

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-skills-"));
  temporary.push(base);
  const homeDir = path.join(base, "home");
  const projectRoot = path.join(base, "project");
  await mkdir(homeDir);
  await mkdir(projectRoot);
  return { homeDir, projectRoot };
}

async function skill(directory: string, name: string, body: string, fields = ""): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "SKILL.md");
  await writeFile(file, `---\nname: ${name}\ndescription: Guidance for ${name}\n${fields}---\n${body}\n`);
  return file;
}

const metadata = "tags: [mcp, tools]\nstacks: [typescript]\nintents: [implement]\n";

async function load(registry: SkillRegistry, request = task) {
  return registry.loadForTask(request, model, classifyTask(request));
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Phase 2 skills", () => {
  test("indexes native and compatible skills as metadata with source, trust, and unknown fields", async () => {
    const options = await fixture();
    await skill(path.join(options.homeDir, ".casper/skills/mcp"), "mcp-tools", "USER_BODY", metadata + "platforms: [mist]\n");
    await skill(path.join(options.projectRoot, ".casper/skills/mcp"), "project-mcp", "PROJECT_BODY", metadata + "trusted: true\n");
    await skill(path.join(options.homeDir, ".pi/agent/skills/mcp"), "pi-mcp", "PI_BODY", metadata);
    await skill(path.join(options.projectRoot, ".agents/skills/mcp"), "agents-mcp", "AGENTS_BODY", metadata);
    await skill(path.join(options.homeDir, ".claude/skills/mcp"), "claude-mcp", "CLAUDE_BODY", metadata);
    await skill(path.join(options.projectRoot, ".codex/skills/mcp"), "codex-mcp", "CODEX_BODY", metadata);
    const registry = await SkillRegistry.discover(options);
    const summaries = registry.list();
    expect(summaries).toHaveLength(6);
    expect(summaries.find((item) => item.name === "mcp-tools")).toMatchObject({
      source: "user", trust: "trusted", extra: { platforms: ["mist"] },
    });
    expect(summaries.find((item) => item.name === "project-mcp")).toMatchObject({ source: "project", trust: "untrusted" });
    expect(summaries.filter((item) => item.source === "external").every((item) => item.trust === "untrusted")).toBe(true);
    expect(JSON.stringify(summaries)).not.toContain("_BODY");
    expect((await load(registry)).map(({ skill }) => skill.name)).toEqual(["mcp-tools"]);
  });

  test("ranks relevant metadata, excludes incompatible/unrelated/manual-only skills, and limits bodies", async () => {
    const options = await fixture();
    const root = path.join(options.homeDir, ".casper/skills");
    await skill(path.join(root, "mcp"), "mcp-tools", "MCP_BODY", metadata);
    await skill(path.join(root, "ts"), "typescript", "TS_BODY", "tags: [typescript]\nstacks: [typescript]\n");
    await skill(path.join(root, "python"), "python-mcp", "PYTHON_BODY", "tags: [mcp]\nstacks: [python]\n");
    await skill(path.join(root, "ui"), "react-layout", "UI_BODY", "stacks: [typescript]\nintents: [implement]\n");
    await skill(path.join(root, "manual"), "manual-mcp", "MANUAL_BODY", metadata + "disable-model-invocation: true\n");
    const registry = await SkillRegistry.discover(options);
    const selected = await load(registry);
    expect(selected.map(({ skill }) => skill.name)).toEqual(["mcp-tools", "typescript"]);
    const context = formatSelectedSkills(selected);
    expect(context).toContain("MCP_BODY");
    expect(context).toContain("TS_BODY");
    expect(context).toContain("Base directory:");
    expect(context).toContain("not permission");
    expect(context).not.toContain("PYTHON_BODY");
    expect(context).not.toContain("UI_BODY");
    expect(context).not.toContain("MANUAL_BODY");
    expect(await load(registry, "Hello there")).toEqual([]);
    expect(await load(await SkillRegistry.discover({ ...options, maxActive: 0 }))).toEqual([]);
    expect((await load(await SkillRegistry.discover({ ...options, maxActive: 1 }))).map(({ skill }) => skill.name)).toEqual(["mcp-tools"]);
  });

  test("loads current bodies on demand instead of retaining them in the metadata index", async () => {
    const options = await fixture();
    const file = await skill(path.join(options.homeDir, ".casper/skills/mcp"), "mcp-tools", "OLD_BODY", metadata);
    const registry = await SkillRegistry.discover(options);
    await writeFile(file, (await readFile(file, "utf8")).replace("OLD_BODY", "CURRENT_BODY"));
    expect((await load(registry))[0].body).toBe("CURRENT_BODY");
    await writeFile(file, (await readFile(file, "utf8")).replace("name: mcp-tools", "name: other-name"));
    expect(await load(registry)).toEqual([]);
    expect(registry.diagnostics.join(" ")).toContain("metadata changed");
  });

  test("requires exact reviewed content, persists trust, and rejects changed content even after restart", async () => {
    const options = await fixture();
    const file = await skill(path.join(options.projectRoot, ".casper/skills/mcp"), "mcp-tools", "REVIEWED_BODY", metadata);
    let registry = await SkillRegistry.discover(options);
    const id = registry.list()[0].id;
    expect(await load(registry)).toEqual([]);
    const inspected = await registry.inspect(id);
    expect(inspected.body).toBe("REVIEWED_BODY");
    expect(await load(registry)).toEqual([]);
    await expect(registry.trust(id, "wrong-digest")).rejects.toThrow("digest");
    await registry.trust(id, inspected.sha256);
    registry = await SkillRegistry.discover(options);
    expect((await load(registry))[0]).toMatchObject({ body: "REVIEWED_BODY", skill: { trust: "reviewed-external" } });
    await writeFile(file, (await readFile(file, "utf8")).replace("REVIEWED_BODY", "UNREVIEWED_BODY"));
    registry = await SkillRegistry.discover(options);
    expect(await load(registry)).toEqual([]);
    expect(registry.list()[0].trust).toBe("untrusted");
    expect(registry.diagnostics.join(" ")).toContain("reviewed content changed");
  });

  test("blocking a user skill survives restart and cannot be overridden by its frontmatter", async () => {
    const options = await fixture();
    await skill(path.join(options.homeDir, ".casper/skills/mcp"), "mcp-tools", "BODY", metadata + "trusted: true\n");
    const registry = await SkillRegistry.discover(options);
    await registry.block(registry.list()[0].id);
    const restored = await SkillRegistry.discover(options);
    expect(restored.list()[0].trust).toBe("blocked");
    expect(await load(restored)).toEqual([]);
  });

  test("handles malformed skills, duplicate names, missing roots and symlink loops deterministically", async () => {
    const options = await fixture();
    expect((await SkillRegistry.discover(options)).list()).toEqual([]);
    const root = path.join(options.homeDir, ".casper/skills");
    await skill(path.join(root, "one"), "mcp-tools", "ONE", metadata);
    await skill(path.join(root, "two"), "mcp-tools", "TWO", metadata);
    await skill(path.join(root, "bad"), "INVALID_NAME", "BAD");
    await symlink(root, path.join(root, "loop"));
    await symlink(path.join(root, "one"), path.join(root, "alias"));
    const registry = await SkillRegistry.discover(options);
    const again = await SkillRegistry.discover(options);
    expect(registry.list()).toEqual(again.list());
    expect(registry.list()).toHaveLength(2);
    expect(new Set(registry.list().map((item) => item.id)).size).toBe(2);
    expect(registry.diagnostics.join(" ")).toContain("Duplicate skill name");
    expect(registry.diagnostics.join(" ")).toContain("Skipped skill");
    expect(await load(registry)).toHaveLength(1);
    expect(await load(registry)).toEqual(await load(again));
  });

  test("does not follow project skill symlinks outside the project, but permits in-project links", async () => {
    const options = await fixture();
    const outside = path.join(options.homeDir, "outside");
    const file = await skill(outside, "outside-mcp", "OUTSIDE_BODY", metadata);
    await mkdir(path.join(options.projectRoot, ".casper"));
    await symlink(outside, path.join(options.projectRoot, ".casper/skills"));
    for (const harness of [".pi", ".agents", ".claude", ".codex"]) {
      const root = path.join(options.projectRoot, harness, "skills");
      await mkdir(root, { recursive: true });
      await symlink(outside, path.join(root, "directory-link"));
      await symlink(file, path.join(root, "file-link.md"));
    }
    const inside = path.join(options.projectRoot, "shared-skill");
    await skill(inside, "inside-mcp", "INSIDE_BODY", metadata);
    await symlink(inside, path.join(options.projectRoot, ".agents/skills/inside"));
    const registry = await SkillRegistry.discover(options);
    expect(registry.list().map((item) => item.name)).toEqual(["inside-mcp"]);
    expect(registry.list()[0].trust).toBe("untrusted");
    expect(registry.diagnostics.join(" ")).toContain("outside the project root");
  });

  test("symlinking project content into user skills does not implicitly trust it", async () => {
    const options = await fixture();
    const source = path.join(options.projectRoot, "external-skill");
    await skill(source, "mcp-tools", "UNTRUSTED", metadata);
    const userRoot = path.join(options.homeDir, ".casper/skills");
    await mkdir(userRoot, { recursive: true });
    await symlink(source, path.join(userRoot, "mcp"));
    const registry = await SkillRegistry.discover(options);
    expect(registry.list()[0].trust).toBe("untrusted");
    expect(await load(registry)).toEqual([]);
  });

  test("an equally relevant reviewed project skill wins a name collision without loading both bodies", async () => {
    const options = await fixture();
    await skill(path.join(options.homeDir, ".casper/skills/mcp"), "mcp-tools", "GLOBAL_BODY", metadata);
    await skill(path.join(options.projectRoot, ".casper/skills/mcp"), "mcp-tools", "PROJECT_BODY", metadata);
    const registry = await SkillRegistry.discover(options);
    const projectSkill = registry.list().find((item) => item.source === "project")!;
    const inspection = await registry.inspect(projectSkill.id);
    await registry.trust(projectSkill.id, inspection.sha256);
    expect((await load(registry)).map(({ body }) => body)).toEqual(["PROJECT_BODY"]);
  });

  test("discovers root Markdown skills and ignores files under a skill's references directory", async () => {
    const options = await fixture();
    const root = path.join(options.homeDir, ".pi/agent/skills");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "legacy.md"), "---\nname: legacy-mcp\ndescription: MCP authoring.\n---\nLEGACY_BODY");
    await skill(path.join(root, "nested"), "nested-mcp", "NESTED_BODY", metadata);
    await skill(path.join(root, "nested/references"), "not-a-skill", "REFERENCE_BODY");
    const registry = await SkillRegistry.discover(options);
    expect(registry.list().map((item) => item.name)).toEqual(["legacy-mcp", "nested-mcp"]);
    expect(await load(registry)).toEqual([]);
  });

  test("bounds file and prompt sizes, and defaults to six selected skills", async () => {
    const options = await fixture();
    const root = path.join(options.homeDir, ".casper/skills");
    for (const suffix of ["a", "b", "c", "d", "e", "f", "g"]) {
      await skill(path.join(root, suffix), `mcp-${suffix}`, "BOUNDED_BODY", metadata);
    }
    await skill(path.join(root, "oversized"), "mcp-oversized", "x".repeat(257 * 1024), metadata);
    const registry = await SkillRegistry.discover(options);
    expect(registry.list()).toHaveLength(7);
    expect(await load(registry)).toHaveLength(6);
    expect(registry.diagnostics.join(" ")).toContain("256 KiB");
    const other = await fixture();
    await skill(path.join(other.homeDir, ".casper/skills/large"), "mcp-large", "x".repeat(65 * 1024), metadata);
    const limited = await SkillRegistry.discover(other);
    expect(await load(limited)).toEqual([]);
    expect(limited.diagnostics.join(" ")).toContain("64 KiB");
  });

  test("a corrupt trust store fails closed rather than silently reactivating blocked user skills", async () => {
    const options = await fixture();
    await skill(path.join(options.homeDir, ".casper/skills/mcp"), "mcp-tools", "BODY", metadata);
    const registry = await SkillRegistry.discover(options);
    await registry.block(registry.list()[0].id);
    await writeFile(path.join(options.homeDir, ".casper/skills-trust.json"), "not json");
    await expect(SkillRegistry.discover(options)).rejects.toThrow("Cannot read skill trust store");
    await expect(load(registry)).rejects.toThrow("Cannot read skill trust store");
  });

  test("honors layered maxActive settings but does not accept project-authored trust decisions", async () => {
    const options = await fixture();
    await mkdir(path.join(options.homeDir, ".casper/profiles/default"), { recursive: true });
    await mkdir(path.join(options.projectRoot, ".casper"));
    await writeFile(path.join(options.homeDir, ".casper/config.yaml"), "skills:\n  maxActive: 5\n");
    await writeFile(path.join(options.homeDir, ".casper/profiles/default/config.yaml"), "skills:\n  maxActive: 3\n");
    await writeFile(path.join(options.projectRoot, ".casper/project.yaml"), "skills:\n  maxActive: 1\n  trustAll: true\n");
    expect((await loadConfiguration(options)).skills.maxActive).toBe(1);
    await writeFile(path.join(options.projectRoot, ".casper/project.yaml"), "skills:\n  maxActive: -1\n");
    await expect(loadConfiguration(options)).rejects.toThrow("maxActive");
  });
});
