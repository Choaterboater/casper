import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadConfiguration } from "../src/config/load";
import { loadProjectContext } from "../src/project/context";
import { loadProjectModel } from "../src/project/model";
import { SkillRegistry, skillRegistryOptions } from "../src/skills/registry";
import type { AgentRuntime, RuntimeEventListener, RuntimeSession, RuntimeStartOptions } from "../src/runtime/types";

const temporary: string[] = [];

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-network-skills-config-"));
  temporary.push(base);
  const homeDir = path.join(base, "home");
  const projectRoot = path.join(base, "project");
  await mkdir(path.join(homeDir, ".casper/profiles/default"), { recursive: true });
  await mkdir(path.join(projectRoot, ".casper"), { recursive: true });
  return { homeDir, projectRoot };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("skills.bundled", () => {
  test("defaults on; your config or profile turns it off; a project cannot", async () => {
    const options = await fixture();
    expect((await loadConfiguration(options)).skills.bundled).toBe(true);
    await writeFile(path.join(options.homeDir, ".casper/config.yaml"), "skills:\n  bundled: false\n");
    expect((await loadConfiguration(options)).skills.bundled).toBe(false);
    await writeFile(path.join(options.homeDir, ".casper/profiles/default/config.yaml"), "skills:\n  bundled: true\n");
    expect((await loadConfiguration(options)).skills.bundled).toBe(true);
    await writeFile(path.join(options.homeDir, ".casper/config.yaml"), "skills:\n  bundled: nope\n");
    await expect(loadConfiguration(options)).rejects.toThrow("skills.bundled must be true or false");
    await writeFile(path.join(options.homeDir, ".casper/config.yaml"), "");
    await writeFile(path.join(options.projectRoot, ".casper/project.yaml"), "skills:\n  bundled: false\n");
    await expect(loadConfiguration(options)).rejects.toThrow("a project cannot turn the bundled skills off");
  });
});

describe("project detection of network SDKs", () => {
  test("requirements and pyproject names give the skill frameworks, whole names only", async () => {
    const { homeDir, projectRoot } = await fixture();
    const info = { cwd: projectRoot, root: projectRoot, name: "p", gitBranch: null, isGit: false };
    await writeFile(path.join(projectRoot, "requirements.txt"), "mistapi==0.64.0\npycentral>=1.4\npyaoscx\npyclearpass\njunos-eznc\n");
    expect((await loadProjectModel(info, { homeDir })).frameworks).toEqual(["aoscx", "central", "clearpass", "junos", "mist"]);
    await writeFile(path.join(projectRoot, "requirements.txt"), "mistapi-extra\nnot-pycentral\nncclient\n");
    expect((await loadProjectModel(info, { homeDir })).frameworks).toEqual(["junos"]);
    await rm(path.join(projectRoot, "requirements.txt"));
    await writeFile(path.join(projectRoot, "pyproject.toml"), "[project]\nname = \"x\"\ndependencies = [\"pyclearpass>=1.0\"]\n");
    expect((await loadProjectModel(info, { homeDir })).frameworks).toEqual(["clearpass"]);
  });
});

class Runtime implements AgentRuntime {
  readonly prompts: string[] = [];
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    const listeners = new Set<RuntimeEventListener>();
    const prompts = this.prompts;
    return {
      async prompt(text: string) {
        prompts.push(text);
        for (const listener of listeners) {
          listener({ type: "assistant_text_delta", delta: "ok" });
          listener({ type: "message_end" });
        }
      },
      setTools() {}, async abort() {},
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}

describe("the app with the pack", () => {
  test("a Mist request carries the bundled text; an unrelated one carries none; /status and /skills show the pack", async () => {
    const { homeDir, projectRoot } = await fixture();
    const runtime = new Runtime();
    let output = "";
    const app = new CasperApp({
      runtimeFactory: () => runtime,
      loadProjectContext: (project) => loadProjectContext(project, { homeDir }),
      loadSkillRegistry: (context) => SkillRegistry.discover(skillRegistryOptions(context, homeDir)),
      output: { write: (text) => { output += text; } },
    });
    try {
      await app.runOnce("/skills", projectRoot);
      expect(output).toContain("6 indexed (6 bundled)");
      expect(output).toContain("network-mist-api@bundled [bundled; trusted]");
      expect(output).toContain("skills/network/mist/SKILL.md (inside Casper; /settings turns them off)");
      expect(runtime.prompts).toHaveLength(0);
      output = "";
      await app.runOnce("list APs per site in Mist");
      expect(output).toContain(" skills selected: network-mist-api");
      expect(runtime.prompts[0]).toContain("MCP: Casper's change box asks; don't ask again in chat.");
      await app.runOnce("fix the css");
      expect(runtime.prompts[1]).not.toContain("network-");
      expect(runtime.prompts[1]).not.toContain("Stop and ask the user");
      output = "";
      await app.runOnce("/status");
      expect(output).toContain(" skills    6 indexed (6 bundled)");
    } finally {
      await app.close();
    }
  });

  test("with skills.bundled: false the pack is not indexed and /status says off", async () => {
    const { homeDir, projectRoot } = await fixture();
    await writeFile(path.join(homeDir, ".casper/config.yaml"), "skills:\n  bundled: false\n");
    const runtime = new Runtime();
    let output = "";
    const app = new CasperApp({
      runtimeFactory: () => runtime,
      loadProjectContext: (project) => loadProjectContext(project, { homeDir }),
      loadSkillRegistry: (context) => SkillRegistry.discover(skillRegistryOptions(context, homeDir)),
      output: { write: (text) => { output += text; } },
    });
    try {
      await app.runOnce("/status", projectRoot);
      expect(output).toContain(" skills    0 indexed; bundled: off");
      await app.runOnce("list APs per site in Mist");
      expect(output).not.toContain("skills selected");
      expect(runtime.prompts[0]).not.toContain("Stop and ask the user before running anything");
    } finally {
      await app.close();
    }
  });
});
