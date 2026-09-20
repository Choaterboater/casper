import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp, type CasperAppOptions } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function gate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { pending, release };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-workspace-load-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home); await mkdir(project);
  const info = { cwd: project, root: project, name: "project", isGit: false, gitBranch: null };
  const context = await loadProjectContext(info, { homeDir: home, profileName: "selected" });
  const registry = await SkillRegistry.discover({ projectRoot: project, homeDir: home });
  let output = "";
  let runtimeStarts = 0;
  const options: CasperAppOptions = {
    inspectProject: async () => info, loadProjectContext: async () => context,
    loadSkillRegistry: async () => registry,
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: ["MCP_DIAGNOSTIC"] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: ["LSP_DIAGNOSTIC"] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: ["REFERENCE_DIAGNOSTIC"] }),
    runtimeFactory: () => { runtimeStarts++; throw new Error("No runtime expected"); },
    output: { write: (text) => { output += text; } },
  };
  return { project, info, context, registry, options, output: () => output, runtimeStarts: () => runtimeStarts };
}

test("independent workspace discovery overlaps only after context and publishes only when all ready", async () => {
  const f = await fixture();
  const contextReady = gate();
  const skillsReady = gate();
  const mcpReady = gate();
  const lspReady = gate();
  const referencesReady = gate();
  const started: string[] = [];
  const loaders = [
    ["loadSkillRegistry", skillsReady], ["loadMCPConfiguration", mcpReady],
    ["loadLSPConfiguration", lspReady], ["loadReferenceConfiguration", referencesReady],
  ] as const;
  // Existing injectable loaders are the scheduling seam; no timers or fake I/O latency.
  for (const [name, ready] of loaders) {
    const original = f.options[name]!;
    Object.assign(f.options, { [name]: async (context: typeof f.context) => {
      expect(context).toBe(f.context);
      started.push(name);
      await ready.pending;
      return original(context);
    } });
  }
  const app = new CasperApp({ ...f.options, loadProjectContext: async () => { await contextReady.pending; return f.context; } });
  cleanup.push(() => app.close());
  const starting = app.start(f.project);
  try {
    await turn();
    expect(started).toEqual([]);
    contextReady.release();
    await turn();
    expect(started).toEqual(loaders.map(([name]) => name));
    expect(f.output()).toBe("");
    // Finish out of order, leaving skills blocked: nothing may publish early.
    referencesReady.release(); lspReady.release(); mcpReady.release();
    await turn();
    expect(f.output()).toBe("");
    skillsReady.release();
    expect(await starting).toEqual(f.info);
    expect(f.output()).toContain("selected");
    expect(f.output().indexOf("REFERENCE_DIAGNOSTIC")).toBeLessThan(f.output().indexOf("MCP_DIAGNOSTIC"));
    expect(f.output().indexOf("MCP_DIAGNOSTIC")).toBeLessThan(f.output().indexOf("LSP_DIAGNOSTIC"));
    await app.runOnce("/project");
    expect(started).toHaveLength(4);
    expect(f.output().match(/CASPER/g)).toHaveLength(1);
    expect(f.runtimeStarts()).toBe(0);
  } finally {
    contextReady.release();
    for (const [, ready] of loaders) ready.release();
    await starting.catch(() => {});
  }
});

test("failed parallel discovery publishes no partial workspace and a retry reloads configuration", async () => {
  const f = await fixture();
  const skillsReady = gate();
  let fail = true;
  let loads = 0;
  const app = new CasperApp({ ...f.options,
    loadSkillRegistry: async () => { loads++; await skillsReady.pending; return f.registry; },
    loadMCPConfiguration: async () => { if (fail) throw new Error("Rejected configuration"); return { servers: [], diagnostics: [] }; },
  });
  cleanup.push(() => app.close());
  const starting = app.start(f.project);
  const verdict = starting.then(() => "ready", () => "failed");
  try {
    await turn();
    // The sibling failure is observed even while skill discovery is still blocked.
    expect(await Promise.race([verdict, turn().then(() => "waiting")])).toBe("failed");
    expect(f.output()).toBe("");
    skillsReady.release();
    await turn();
    expect(f.output()).toBe("");
    fail = false;
    await app.runOnce("/project", f.project);
    expect(loads).toBe(2);
    expect(f.output().match(/CASPER/g)).toHaveLength(1);
    expect(f.runtimeStarts()).toBe(0);
  } finally { skillsReady.release(); await starting.catch(() => {}); }
});

test("closing during workspace discovery prevents late publication and runtime startup", async () => {
  const f = await fixture();
  const ready = gate();
  const app = new CasperApp({ ...f.options, loadSkillRegistry: async () => { await ready.pending; return f.registry; } });
  cleanup.push(() => app.close());
  const starting = app.start(f.project);
  const verdict = starting.then(() => "ready", (error: Error) => error.message);
  try {
    await turn();
    await app.close();
  } finally { ready.release(); }
  expect(await verdict).toBe("Casper is closing");
  expect(f.output()).toBe("");
  expect(f.runtimeStarts()).toBe(0);
  await expect(app.start(f.project)).rejects.toThrow("Casper is closing");
});

test("invalid project context stops all dependent discovery", async () => {
  const f = await fixture();
  let loads = 0;
  const app = new CasperApp({ ...f.options,
    loadProjectContext: async () => { throw new Error("Invalid profile name"); },
    loadSkillRegistry: async () => { loads++; return f.registry; },
    loadMCPConfiguration: async () => { loads++; return { servers: [], diagnostics: [] }; },
    loadLSPConfiguration: async () => { loads++; return { servers: [], diagnostics: [] }; },
    loadReferenceConfiguration: async () => { loads++; return { sources: [], diagnostics: [] }; },
  });
  cleanup.push(() => app.close());
  await expect(app.start(f.project)).rejects.toThrow("Invalid profile name");
  expect(loads).toBe(0);
  expect(f.output()).toBe("");
  expect(f.runtimeStarts()).toBe(0);
});
