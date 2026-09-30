import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp, type CasperAppOptions } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeStartOptions } from "../src/runtime/types";
import { currentSandbox } from "../src/sandbox/manager";
import { SkillRegistry } from "../src/skills/registry";
import { fakeEngine } from "./support/sandbox-fakes";

/** The sandbox as a session shows it: the banner's shell line, /sandbox, /status, the receipt and the AI's bash. */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(options: Partial<CasperAppOptions> = {}, edit = true) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-sandbox-app-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "project");
  await mkdir(home); await mkdir(project);
  let started: RuntimeStartOptions | undefined;
  const runtime: AgentRuntime = {
    async start(startOptions) {
      started = startOptions;
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: () => () => {}, abort: async () => {}, setTools: () => {},
        prompt: async () => { if (edit) await writeFile(path.join(project, "notes.md"), "done\n"); },
      };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({
    output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    verificationMode: "off",
    ...options,
  });
  return { app, project, home, text: () => output, started: () => started };
}

test("with the sandbox on, /status and /sandbox say what it holds, and the AI's bash is wrapped", async () => {
  const engine = fakeEngine();
  const f = await fixture({ sandboxSeams: { engine, problem: () => undefined, platform: "linux" } });
  try {
    await f.app.runOnce("/status", f.project);
    expect(f.text()).toMatch(/ shell {5}sandboxed · writes: this project, temp, package caches · hosts: \d+ listed \(\/sandbox\)\n/);
    await f.app.runOnce("/sandbox", f.project);
    expect(f.text()).toContain("Hosts:   registry.npmjs.org");
    expect(f.text()).toContain("Not in the sandbox: MCP servers, language servers, the debugger, the browser and lab checks.");
    await f.app.runOnce("Write the notes", f.project);
    const shell = f.started()!.shell!;
    const wrapped = await shell.wrap("npm test", f.project);
    expect(wrapped.id).toBeDefined();
    expect(wrapped.command).toContain("CASPER_FAKE_HELD=ask");
    expect(f.app.getLastTaskResult()?.sandbox).toEqual({ held: true });
    // The shared sandbox is the one every other shell path uses, until the session closes.
    expect(currentSandbox()).toBe(f.app.sandbox);
  } finally { await f.app.close(); }
  expect(currentSandbox()).toBeUndefined();
});

test("--no-sandbox: the one-shot banner, the receipt and the JSON say shell commands were not sandboxed", async () => {
  const f = await fixture({ noSandbox: true, sandboxSeams: { engine: fakeEngine(), problem: () => undefined, platform: "linux" } });
  try {
    await f.app.runOnce("Write the notes", f.project);
    expect(f.text()).toContain(" shell     not sandboxed (--no-sandbox)\n");
    expect(f.text()).toContain("• Shell commands and checks were not sandboxed (--no-sandbox)");
    expect(f.app.getLastTaskResult()?.sandbox).toEqual({ held: false, reason: "--no-sandbox" });
    const wrapped = await f.started()!.shell!.wrap("npm test", f.project);
    expect(wrapped).toEqual({ command: "npm test" });
  } finally { await f.app.close(); }
});

test("with no sandbox here, the banner says so and gives the fix", async () => {
  const f = await fixture({ sandboxSeams: { engine: fakeEngine(), problem: () => "bubblewrap and socat are missing: sudo apt install bubblewrap socat", platform: "linux" } });
  try {
    await f.app.runOnce("/status", f.project);
    expect(f.text()).toContain(" shell     not sandboxed (bubblewrap and socat are missing: sudo apt install bubblewrap socat) · Casper asks before each AI shell command\n");
    await f.app.runOnce("/permissions", f.project);
    expect(f.text()).toContain("Casper asks before each shell command the AI runs.");
  } finally { await f.app.close(); }
});

test("a repo's .pi/sandbox.json is ignored, and Casper says so", async () => {
  const f = await fixture({ sandboxSeams: { engine: fakeEngine(), problem: () => undefined, platform: "linux" } });
  await mkdir(path.join(f.project, ".pi"));
  await writeFile(path.join(f.project, ".pi", "sandbox.json"), JSON.stringify({ enabled: false, filesystem: { allowWrite: ["/"] } }));
  try {
    await f.app.start(f.project);
    expect(f.text()).toContain("[sandbox] Ignored .pi/sandbox.json: a project can't loosen the sandbox.\n");
    expect(f.app.sandbox?.on).toBe(true);
    expect(f.app.sandbox?.policy().allowWrite).not.toContain("/");
  } finally { await f.app.close(); }
});
