import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { formatReceipt } from "../src/task/result";
import { checkCommand } from "./support/check-command";
import { removeTempDir } from "./support/temp-dir";

/**
 * Run 10 (tracker on Sonnet 4.6, v0.4.8): the AI deleted its test database when told, then Casper's own end checks (a
 * repair round's browser recording, the replays and the app smoke) signed up 6 users, and the build shipped them. The
 * receipt said "Changed while checking: data/tracker.db …" and "⚠ Checks and repairs changed app settings or data".
 */

type Emit = (event: Parameters<RuntimeEventListener>[0]) => void;

async function fixture(aiWrites: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-checks-keep-data-"));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true }); await mkdir(path.join(project, "src"));
  // The check signs a user up through the app: its database gets a row, as the tracker's register endpoint did.
  await writeFile(path.join(project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(checkCommand("mkdir:data", "mkdir:var", "append:data/tracker.db=user-from-check", "append:var/sessions.json=s"))}\n`);
  await writeFile(path.join(project, "src/server.js"), "// v1\n");
  let turns = 0;
  const turn = async (emit: Emit) => {
    emit({ type: "tool_start", toolName: "write", toolCallId: "w1", input: { path: "src/server.js" } });
    await writeFile(path.join(project, "src/server.js"), "// v2\n");
    emit({ type: "tool_end", toolName: "write", toolCallId: "w1", isError: false, input: { path: "src/server.js" } });
    const command = "node src/server.js";
    emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command } });
    for (const [file, text] of Object.entries(aiWrites)) { await mkdir(path.dirname(path.join(project, file)), { recursive: true }); await writeFile(path.join(project, file), text); }
    emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: { command } });
    emit({ type: "assistant_text_delta", delta: "Done." });
  };
  const listeners = new Set<RuntimeEventListener>();
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => { if (++turns === 1) await turn((event) => { for (const listener of listeners) listener(event); }); },
      };
    },
    async dispose() {},
  };
  const app = new CasperApp({
    input: new PassThrough(), output: { write: () => {} }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  return { app, project, close: async () => { await app.close(); await removeTempDir(root); } };
}

test("data Casper's own checks write is put back as the AI left it: a database they made is gone, the receipt has no warning", async () => {
  const f = await fixture({});
  try {
    await f.app.runOnce("fix the server", f.project);
    const task = f.app.getLastTaskResult()!;
    expect(task.verification?.status).toBe("pass");
    expect(await Bun.file(path.join(f.project, "data/tracker.db")).exists()).toBe(false);
    expect(await Bun.file(path.join(f.project, "var/sessions.json")).exists()).toBe(false);
    expect(task.changedDuringChecks ?? []).toEqual([]);
    const receipt = formatReceipt(task, { surface: "interactive" });
    expect(receipt).not.toMatch(/Changed while checking|changed app settings or data|Left by your test runs/);
  } finally { await f.close(); }
}, 60_000);

test("a database the AI left keeps the AI's bytes after the checks, and only the AI's rows are named", async () => {
  const f = await fixture({ "data/tracker.db": "user-from-the-ai" });
  try {
    await f.app.runOnce("fix the server", f.project);
    const task = f.app.getLastTaskResult()!;
    expect(await readFile(path.join(f.project, "data/tracker.db"), "utf8")).toBe("user-from-the-ai");
    expect(task.changedDuringChecks ?? []).toEqual([]);
    expect(task.testDataLeft).toEqual([{ file: "data/tracker.db" }]);
    expect(formatReceipt(task, { surface: "interactive" })).not.toContain("changed app settings or data");
  } finally { await f.close(); }
}, 60_000);
