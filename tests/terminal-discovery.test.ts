import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillRegistry } from "../src/skills/registry";
import { loadConfiguration } from "../src/config/load";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-discovery-")); roots.push(root);
  const homeDir = path.join(root, "home"), projectRoot = path.join(root, "project");
  await mkdir(homeDir); await mkdir(projectRoot);
  const put = async (base: string, file: string, text: string) => {
    const target = path.join(base, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text);
  };
  return { homeDir, projectRoot, put };
}
const valid = "---\nname: sample\ndescription: Sample guidance\n---\nInstructions";

test("default discovery never scans other tools' roots", async () => {
  const f = await fixture();
  for (const folder of [".claude/skills/AionUi", ".codex/skills/bad", ".pi/agent/skills/sample", ".agents/skills/paperclip"]) {
    await f.put(f.homeDir, `${folder}/README.md`, "# ordinary documentation");
    await f.put(f.homeDir, `${folder}/bad/SKILL.md`, "invalid");
  }
  await f.put(f.homeDir, ".casper/skills/native/SKILL.md", valid);
  const registry = await SkillRegistry.discover(f);
  expect(registry.list()).toHaveLength(1);
  expect(registry.diagnostics).toEqual([]);
});

test("opted-in trees ignore ordinary docs but retain malformed skill diagnostics and standalone skills", async () => {
  const f = await fixture();
  await f.put(f.homeDir, ".claude/skills/AionUi/README.md", "# ordinary documentation");
  await f.put(f.homeDir, ".claude/skills/paperclip/docs/frontmatter.md", "---\ntitle: Design\n---\nDocumentation");
  await f.put(f.homeDir, ".claude/skills/legacy.md", valid);
  await f.put(f.homeDir, ".claude/skills/flow.md", '---\n{"name": "flow", "description": "Flow mapping skill"}\n---\nInstructions');
  await f.put(f.homeDir, ".claude/skills/invalid/SKILL.md", "# missing frontmatter");
  await f.put(f.homeDir, ".claude/skills/broken.md", "---\nname: broken\ndescription: [\n---\nBad skill");
  await f.put(f.homeDir, ".codex/skills/invalid/SKILL.md", `---\nname: invalid\ndescription: ${"x".repeat(1025)}\n---\nBad skill`);
  const registry = await SkillRegistry.discover({ ...f, imports: ["claude", "codex"] });
  expect(registry.list().map((s) => [s.name, s.trust])).toEqual([["flow", "untrusted"], ["sample", "untrusted"]]);
  expect(registry.diagnostics).toHaveLength(3);
  expect(registry.diagnostics.join("\n")).not.toMatch(/README|frontmatter.md/);
  expect(registry.diagnostics.join("\n")).toContain("description must contain");
});

test("startup summarizes genuine warnings, keeps detail local and never prints ordinary-doc rejection noise", async () => {
  const f = await fixture();
  await f.put(f.homeDir, ".casper/skills/README.md", "# ordinary documentation");
  await f.put(f.homeDir, ".casper/skills/bad/SKILL.md", "bad");
  await f.put(f.homeDir, ".casper/skills/other/SKILL.md", "also bad");
  let output = "";
  const app = new CasperApp({
    runtimeFactory: () => { throw new Error("must stay local"); },
    loadProjectContext: (project) => loadProjectContext(project, { homeDir: f.homeDir }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ ...f, imports: context.skills.imports }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    output: { write: (text) => { output += text; } },
  });
  try {
    await app.start(f.projectRoot);
    expect(output).toContain("2 new warnings; use /skills diagnostics");
    expect(output).not.toContain("Skipped skill");
    expect(output).not.toContain("README.md");
    output = "";
    await app.runOnce("/skills diagnostics");
    expect(output.match(/Skipped skill/g)).toHaveLength(2);
    expect(output).toContain("expected YAML frontmatter");
    expect(output).not.toContain("README.md");
  } finally { await app.close(); }
});

test("imports are validated, user/profile-only, replace rather than merge, and default empty", async () => {
  const f = await fixture();
  expect((await loadConfiguration(f)).skills.imports).toEqual([]);
  await f.put(f.homeDir, ".casper/config.yaml", "skills: { imports: [pi, agents] }\n");
  await f.put(f.homeDir, ".casper/profiles/default/config.yaml", "skills: { imports: [codex] }\n");
  await f.put(f.projectRoot, ".casper/project.yaml", "skills: { imports: [claude] }\n");
  await expect(loadConfiguration(f)).rejects.toThrow("user/profile");
  await f.put(f.projectRoot, ".casper/project.yaml", "skills: { maxActive: 2 }\n");
  expect((await loadConfiguration(f)).skills).toEqual({ imports: ["codex"], maxActive: 2 });
  await f.put(f.homeDir, ".casper/profiles/default/config.yaml", "skills: { imports: [] }\n");
  expect((await loadConfiguration(f)).skills.imports).toEqual([]);
  await f.put(f.homeDir, ".casper/config.yaml", "skills: { imports: [unknown] }\n");
  await expect(loadConfiguration(f)).rejects.toThrow("skills.imports");
});
