import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { posixOnly } from "./support/platform";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(commands: string[] = []) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-debug-app-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), project = path.join(root, "project"); await mkdir(home); await mkdir(project);
  await mkdir(path.join(project, ".casper")); await writeFile(path.join(project, "program.py"), "answer = 42\n");
  await writeFile(path.join(project, ".casper/debug.json"), JSON.stringify({ targets: { example: {
    command: process.execPath, args: [path.join(import.meta.dir, "fixtures/dap-adapter.ts")], adapterID: "fixture", program: "program.py",
  } } }));
  const input = new PassThrough(); let output = "", starts = 0;
  const app = new CasperApp({ input, runtimeFactory: () => { starts++; throw new Error("MODEL_MUST_NOT_START"); },
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ homeDir: home, projectRoot: context.info.root }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }), loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    output: { write(text) {
      output += text;
      if (text.includes("Type yes:")) setImmediate(() => input.write("yes\n"));
      if (text === "> " && commands.length) setImmediate(() => input.write(commands.shift()! + "\n"));
    } },
  });
  cleanup.push(() => app.close());
  return { app, project, input, output: () => output, starts: () => starts };
}

// python3 runs the standard-library PTY fixture; Windows has no equivalent here.
posixOnly("production debugger CLI preserves fresh consent and cleans up on EOF/SIGTERM", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-debug-pty-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const child = Bun.spawn(["python3", path.join(import.meta.dir, "fixtures/debug-pty.py"), process.execPath, root], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 40_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("DEBUG PTY PASS");
  } finally { clearTimeout(timer); child.kill(); }
}, 50_000);

test("debugger listing is lazy and one-shot launch cannot grant execution consent", async () => {
  const f = await fixture();
  await f.app.runOnce("/debug", f.project);
  expect(f.output()).toContain('"targets":["example"]');
  expect(f.starts()).toBe(0);
  await expect(f.app.runOnce("/debug start example")).rejects.toThrow("denied");
  expect(await Bun.file(path.join(f.project, "adapter-started")).exists()).toBe(false);
});

test("interactive debugger commands use fresh approval, no model and close owned processes", async () => {
  const f = await fixture(["/debug start example", "/debug threads", "/debug stack 1", "/debug stop", "/exit"]);
  await f.app.runInteractive(f.project);
  expect(f.output()).toContain("Debugger execution confirmation");
  expect(f.output()).toContain('"state":"stopped"');
  expect(f.output()).toContain('"name":"fixture"');
  expect(f.output()).toContain('"state":"closed"');
  expect(f.starts()).toBe(0);
  const pid = Number(await readFile(path.join(f.project, "debuggee-pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
