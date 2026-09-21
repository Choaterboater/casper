import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { RuntimeSession, RuntimeSessionInfo } from "../src/runtime/types";

const exec = promisify(execFile);
test("a live debugger is revoked before exposing a new workspace or model task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-debug-workspace-"));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(home); await mkdir(project); await mkdir(path.join(project, ".casper"));
  await writeFile(path.join(project, "program.py"), "answer = 42\n");
  // Adapter observation files are test-harness state, not user workspace edits.
  await writeFile(path.join(project, ".gitignore"), "adapter-started\ndebuggee-pid\nrequests.jsonl\n");
  await writeFile(path.join(project, ".casper/debug.json"), JSON.stringify({ targets: { example: {
    command: process.execPath, args: [path.join(import.meta.dir, "fixtures/dap-adapter.ts")], adapterID: "fixture", program: "program.py",
  } } }));
  const git = (...args: string[]) => exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: project });
  let app: CasperApp | undefined;
  try {
    await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
    await git("add", "."); await git("commit", "-m", "Isolated fixture");
    const main = path.join(home, "main.jsonl"); await writeFile(main, "main");
    let info: RuntimeSessionInfo = { cwd: project, sessionId: "main", sessionFile: main };
    let beforeTransition = false, beforePrompt = false;
    const dead = async (cwd: string) => {
      const pid = Number(await readFile(path.join(cwd, "debuggee-pid"), "utf8"));
      try { process.kill(pid, 0); return false; } catch { return true; }
    };
    const session: RuntimeSession = {
      getSessionInfo: () => ({ ...info }), getState: () => ({ cwd: info.cwd, isStreaming: false }),
      forkSession: async options => {
        beforeTransition = await dead(project);
        const child = path.join(home, "child.jsonl"); await writeFile(child, "child");
        info = { cwd: options.cwd, sessionId: "child", sessionFile: child }; return { ...info };
      },
      switchSession: async options => { info = { ...info, ...options }; return { ...info }; },
      setTools: tools => { expect(tools.some(tool => tool.name === "debugger")).toBe(false); },
      appendContext: async () => {}, prompt: async () => { beforePrompt = await dead(info.cwd); },
      abort: async () => {}, subscribe: () => () => {},
    };
    const input = new PassThrough(); let output = "";
    const commands = ["/debug start example", "/branch debug-rebind", "/debug", "/debug start example", "hello", "/exit"];
    app = new CasperApp({ input, sessionHomeDir: home,
      runtimeFactory: () => ({ start: async () => session, dispose: async () => {} }),
      loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
      loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
      loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }), loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
      output: { write(text) {
        output += text;
        if (text.includes("Type yes:")) setImmediate(() => input.write("yes\n"));
        if (text === "> ") setImmediate(() => input.write((commands.shift() ?? "/exit") + "\n"));
      } },
    });
    await app.runInteractive(project);
    expect(output).not.toContain("[error]");
    expect(beforeTransition).toBe(true);
    expect(beforePrompt).toBe(true);
    expect(info.cwd).toContain(".casper/worktrees");
    expect(output).toContain('"state":"idle"');
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
}, 15_000);
