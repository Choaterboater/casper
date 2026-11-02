import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

/** Every start in the smoke folder said "[skills] 3 new warnings; use /skills diagnostics": two skills in ~/.codex/skills
 * with no description and one name used twice, the same each time. */

const runtime: AgentRuntime = { async start() { throw new Error("no model in this test"); }, async dispose() {} };

async function start(home: string, project: string): Promise<string> {
  let output = "";
  const app = new CasperApp({
    output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  try { await app.runOnce("/skills diagnostics", project); } finally { await app.close(); }
  return output;
}

test("a skill warning is said at one start, not every start; a new one is said; /skills diagnostics lists them all", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-skill-warnings-"));
  const home = path.join(root, "home"), project = path.join(root, "project");
  try {
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "notes.txt"), "x\n");
    const bad = async (name: string) => {
      await mkdir(path.join(home, ".codex", "skills", name), { recursive: true });
      await writeFile(path.join(home, ".codex", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ""\n---\nBody\n`);
    };
    await bad("swiftui-specialist");
    const first = await start(home, project);
    expect(first).toContain("[skills] 1 new warning; use /skills diagnostics");
    expect(first).toContain("swiftui-specialist");
    const second = await start(home, project);
    expect(second).not.toContain("new warning");
    // /skills diagnostics still says it in full.
    expect(second).toContain("swiftui-specialist");
    await bad("swiftui-whats-new");
    expect(await start(home, project)).toContain("[skills] 1 new warning; use /skills diagnostics");
  } finally { await removeTempDir(root); }
}, 30_000);
