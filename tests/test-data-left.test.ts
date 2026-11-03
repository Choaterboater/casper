import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { formatReceipt } from "../src/task/result";
import { describeTestData, testDataLine } from "../src/task/test-data";
import { removeTempDir } from "./support/temp-dir";

/**
 * Run 8 (tracker on Sonnet 4.6): the AI started its own server (`PORT=3456 node src/server.js &`) and signed up through it.
 * The build shipped data/tracker.db with that user and session, so on a fresh install the first person to register was
 * not admin, and the receipt filed the database under "Changed by something else while Casper worked".
 */

type Emit = (event: Parameters<RuntimeEventListener>[0]) => void;

/** One request whose turn writes the server and runs it: the run makes data/tracker.db with one user, between tool calls. */
async function fixture(onNote: (project: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-test-data-"));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper/project.yaml"), "verification:\n  mode: offer\n");
  const prompts: string[] = [];
  const turn = async (emit: Emit) => {
    emit({ type: "tool_start", toolName: "write", toolCallId: "w1", input: { path: "src/server.js" } });
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(path.join(project, "src/server.js"), "// the tracker\n");
    emit({ type: "tool_end", toolName: "write", toolCallId: "w1", isError: false, input: { path: "src/server.js" } });
    const command = "PORT=3456 node src/server.js &\nsleep 2\ncurl -s -X POST localhost:3456/api/register";
    emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command } });
    emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: { command } });
    // The server it left running writes its database after the command returned, while no tool of the AI's runs.
    await Bun.sleep(2_600);
    await mkdir(path.join(project, "data"), { recursive: true });
    const db = new Database(path.join(project, "data/tracker.db"));
    db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)"); db.run("CREATE TABLE sessions (token TEXT)");
    db.run("INSERT INTO users (email) VALUES ('ada@example.test')"); db.run("INSERT INTO sessions VALUES ('t1')");
    db.close();
    emit({ type: "assistant_text_delta", delta: "The tracker is built and signs up a user." });
  };
  const listeners = new Set<RuntimeEventListener>();
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async (text: string) => {
          prompts.push(text);
          const emit: Emit = (event) => { for (const listener of listeners) listener(event); };
          if (prompts.length === 1) await turn(emit);
          else { await onNote(project); emit({ type: "assistant_text_delta", delta: "Done." }); }
        },
      };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({
    input: new PassThrough(), output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  return { app, project, prompts, output: () => output, close: async () => { await app.close(); await removeTempDir(root); } };
}

test("a database the task's own run made is its test data: the AI is told once what is in it, and the receipt never calls it someone else's", async () => {
  const f = await fixture(async () => {});
  try {
    await f.app.runOnce("build the tracker", f.project);
    const task = f.app.getLastTaskResult()!;
    // One end note, naming what the file holds.
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain("data/tracker.db (2 rows in 2 tables)");
    expect(f.prompts[1]).toContain("unless it is meant to ship");
    expect(f.output()).toContain("↻ data/tracker.db (2 rows in 2 tables): left by this task's own runs; asking the AI to remove it unless it ships");
    // Kept: the receipt names it, neutral; never another program's, and it is the task's for undo.
    expect(task.changedNotByModel ?? []).not.toContain("data/tracker.db");
    expect(task.testDataLeft).toEqual([{ file: "data/tracker.db", rows: 2, tables: 2 }]);
    const receipt = formatReceipt(task, { surface: "interactive" });
    expect(receipt).toContain("– Left by your test runs: data/tracker.db (2 rows in 2 tables); it ships with the app unless you delete it");
    expect(receipt).not.toContain("Changed by something else");
  } finally { await f.close(); }
}, 60_000);

test("deleted after the note: nothing on the receipt about it", async () => {
  const f = await fixture(async (project) => { await rm(path.join(project, "data"), { recursive: true, force: true }); });
  try {
    await f.app.runOnce("build the tracker", f.project);
    const task = f.app.getLastTaskResult()!;
    expect(f.prompts).toHaveLength(2);
    expect(task.testDataLeft).toBeUndefined();
    expect(task.changedPaths).toEqual(["src/server.js"]);
    expect(formatReceipt(task, { surface: "interactive" })).not.toMatch(/Left by your test runs|Changed by something else/);
  } finally { await f.close(); }
}, 60_000);

test("what a data file holds: a database's rows and tables, read only; a file that is gone is not listed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-test-data-count-"));
  try {
    await mkdir(path.join(root, "data"));
    const db = new Database(path.join(root, "data/app.db"));
    db.run("CREATE TABLE users (id INTEGER)"); db.run("INSERT INTO users VALUES (1)");
    db.close();
    await writeFile(path.join(root, "data/seed.json"), "[]\n");
    expect(await describeTestData(root, ["data/app.db", "data/app.db-wal", "data/seed.json", "data/gone.db"]))
      .toEqual([{ file: "data/app.db", rows: 1, tables: 1 }, { file: "data/seed.json" }]);
    expect(testDataLine([{ file: "data/seed.json" }], (text) => text)).toBe("– Left by your test runs: data/seed.json; it ships with the app unless you delete it");
  } finally { await removeTempDir(root); }
});
