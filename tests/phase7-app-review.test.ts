import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { discoverMCPConfiguration } from "../src/mcp/config";
import type { RuntimeSession, RuntimeSessionInfo, RuntimeTool } from "../src/runtime/types";

const exec = promisify(execFile);
test("review regression: failed destination context loading revokes old capabilities and blocks prompts until recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-rebind-review-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper/mcp.json"), JSON.stringify({ mcpServers: { fixture: {
    command: process.execPath, args: [path.join(import.meta.dir, "fixtures/mcp-server.ts")],
  } } }));
  const git = (...args: string[]) => exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: project });
  await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
  await git("add", "."); await git("commit", "-m", "Fixture baseline");
  const sessionFile = path.join(home, "main.jsonl"); await writeFile(sessionFile, "main");
  let info: RuntimeSessionInfo = { cwd: project, sessionId: "main", sessionFile };
  let badConfig = ""; let prompts = 0; let tools: RuntimeTool[] = [];
  const session: RuntimeSession = {
    getSessionInfo: () => ({ ...info }), getState: () => ({ cwd: info.cwd, isStreaming: false }),
    forkSession: async (options) => {
      const child = path.join(home, "child.jsonl"); await writeFile(child, "child");
      info = { cwd: options.cwd, sessionId: "child", sessionFile: child };
      badConfig = path.join(options.cwd, ".casper/project.yaml"); await writeFile(badConfig, "invalid: [");
      return { ...info };
    },
    switchSession: async (options) => { info = { ...info, ...options }; return { ...info }; },
    setTools: (next) => { tools = next; }, appendContext: async () => {},
    prompt: async () => { prompts++; }, abort: async () => {}, subscribe: () => () => {},
  };
  const input = new PassThrough(); let output = ""; let question = 0;
  const app = new CasperApp({
    input, sessionHomeDir: home, runtimeFactory: () => ({ start: async () => session, dispose: async () => {} }),
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: (context) => discoverMCPConfiguration({ projectRoot: context.info.root, homeDir: home }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    output: { write(text) {
      output += text;
      if (text.includes("Type yes:")) queueMicrotask(() => input.write("yes\n"));
      if (text === "> ") {
        const current = question++;
        void (async () => {
          if (current === 0) input.write("/branch broken-context\n");
          if (current === 1) input.write("inspect the project\n");
          if (current === 2) { await rm(badConfig); input.write("/mcp\n"); }
          if (current === 3) input.write("/exit\n");
        })();
      }
    } },
  });
  try {
    await app.runOnce("/mcp connect fixture", project);
    expect(output).toContain("340 tools");
    await app.runInteractive();
    expect(output.match(/\[error\] Invalid Casper configuration/g)).toHaveLength(2);
    expect(output).toContain("fixture [stdio; disconnected]");
    expect(prompts).toBe(0);
    expect(tools).toEqual([]);
    expect(info.cwd).toContain(".casper/worktrees");
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
}, 15_000);
