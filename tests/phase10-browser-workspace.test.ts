import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { RuntimeSession, RuntimeSessionInfo } from "../src/runtime/types";

const exec = promisify(execFile);
const browserTest = existsSync(process.env.CASPER_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? test : test.skip;

browserTest("a workspace transition closes an already-running browser before exposing the destination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-browser-workspace-"));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(home); await mkdir(project);
  await writeFile(path.join(project, "index.html"), "<h1>Workspace fixture</h1>");
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<h1>Workspace fixture</h1>") });
  let app: CasperApp | undefined;
  try {
    // All Git state and fixture commits are confined to this temporary repository.
    const git = (...args: string[]) => exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: project });
    await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
    await git("add", "."); await git("commit", "-m", "Fixture baseline");
    const main = path.join(home, "main.jsonl"); await writeFile(main, "main");
    let info: RuntimeSessionInfo = { cwd: project, sessionId: "main", sessionFile: main };
    let prompts = 0;
    const session: RuntimeSession = {
      getSessionInfo: () => ({ ...info }), getState: () => ({ cwd: info.cwd, isStreaming: false }),
      forkSession: async options => {
        const child = path.join(home, "child.jsonl"); await writeFile(child, "child");
        info = { cwd: options.cwd, sessionId: "child", sessionFile: child }; return { ...info };
      },
      switchSession: async options => { info = { ...info, ...options }; return { ...info }; },
      setTools: () => {}, appendContext: async () => {}, prompt: async () => { prompts++; }, abort: async () => {}, subscribe: () => () => {},
    };
    const input = new PassThrough(); let output = "", question = 0;
    app = new CasperApp({ input, sessionHomeDir: home,
      runtimeFactory: () => ({ start: async () => session, dispose: async () => {} }),
      loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
      loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
      loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      output: { write(text) {
        output += text;
        if (text.includes("Type yes:")) queueMicrotask(() => input.write("yes\n"));
        if (text === "> ") queueMicrotask(() => input.write(["/branch browser-rebind\n", "/browser\n", "/exit\n"][question++] ?? "/exit\n"));
      } },
    });
    await app.runOnce(`/browser open http://127.0.0.1:${site.port}`, project);
    await app.runOnce("/browser");
    const pid = Number(output.match(/"ownedBrowserPid":(\d+)/)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    const boundary = output.length;
    await app.runInteractive();
    expect(info.cwd).toContain(".casper/worktrees");
    expect(output.slice(boundary)).toContain('"state":"idle"');
    expect(() => process.kill(pid, 0)).toThrow();
    expect(prompts).toBe(0);
    expect((await fetch(`http://127.0.0.1:${site.port}`)).status).toBe(200);
  } finally { await app?.close(); site.stop(true); await rm(root, { recursive: true, force: true }); }
}, 20_000);
