import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import type { AgentRuntime, RuntimeSession, RuntimeStartOptions } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { formatTaskPrompt } from "../src/task/classify";
import { describeChecksPlan, planAutoChecks, selectedChecks } from "../src/verify/mode";
import { autoDetectedChecks } from "../src/verify/migrations-check";
import { defaultVerifyNames, VerifierRegistry } from "../src/verify/registry";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const SITES = "CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT NOT NULL);";
const DEVICES = "CREATE TABLE devices (id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES sites(id));";
const sqlitePkg = JSON.stringify({ name: "noc", dependencies: { "better-sqlite3": "11" } });

async function project(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-migrations-named-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), dir = path.join(root, "project");
  await mkdir(home); await mkdir(path.join(dir, ".casper"), { recursive: true });
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await writeFile(path.join(dir, name), text); }
  return { home, dir, root };
}

test("SQLite migrations are a named check: registered with their folder as scope, run only when a migration changes", async () => {
  const f = await project({ "package.json": sqlitePkg, "migrations/001_sites.sql": SITES, "migrations/002_devices.sql": DEVICES });
  const context = await loadProjectContext(await inspectProject(f.dir), { homeDir: f.home });
  expect(context.model.migrations).toMatchObject({ dir: "migrations", dialect: "sqlite" });
  const registry = VerifierRegistry.forProject(context.model);
  expect(registry.names()).toContain("migrations");
  expect(registry.scope("migrations")).toEqual({ inputs: ["migrations"] });
  expect(registry.modelNames()).toContain("migrations");
  expect(defaultVerifyNames(context.model)).toContain("migrations");
  const detected = autoDetectedChecks(context.model);
  const plan = (changedPaths: string[]) => planAutoChecks({ commands: {}, detected, changedPaths }).run;
  expect(plan(["migrations/003_ports.sql"])).toEqual(["migrations"]);
  expect(plan(["src/app.ts"])).toEqual([]);
  expect(describeChecksPlan({ mode: "auto", checks: selectedChecks(undefined, {}, undefined, detected.map((check) => check.name)) })).toBe("migrations — run after each change");
  // The AI is told the check exists; it runs through casper_check like any other.
  expect(formatTaskPrompt("Add a ports table", { intent: "implement", mode: "edit" } as never, context.model, { verificationMode: "auto" }))
    .toContain("migrations=apply the SQL migrations to a throwaway SQLite (Casper runs it)");
  const [result] = await registry.run(["migrations"]);
  expect(result).toMatchObject({ name: "migrations", status: "pass", label: "2 files · throwaway SQLite" });
});

test("a broken migration fails the check with the file and the database error", async () => {
  const f = await project({ "package.json": sqlitePkg, "migrations/001_init.sql": "CREATE TABLE a (x);", "migrations/002_devices.sql": `${DEVICES}\nINSERT INTO sites (name) VALUES ('hq');` });
  const context = await loadProjectContext(await inspectProject(f.dir), { homeDir: f.home });
  const [result] = await VerifierRegistry.forProject(context.model).run(["migrations"]);
  expect(result).toMatchObject({ status: "fail", reason: "002_devices.sql failed — no such table: sites" });
});

test("Postgres migrations are never run after changes; /verify migrations says why they were not checked", async () => {
  const f = await project({ "package.json": JSON.stringify({ name: "noc" }), "supabase/migrations/001_sites.sql": SITES });
  const context = await loadProjectContext(await inspectProject(f.dir), { homeDir: f.home });
  expect(autoDetectedChecks(context.model)).toEqual([]);
  expect(defaultVerifyNames(context.model)).not.toContain("migrations");
  const [result] = await VerifierRegistry.forProject(context.model).run(["migrations"]);
  expect(result).toMatchObject({ status: "skip", repair: "never" });
  expect(result!.reason).toContain("Postgres migrations (supabase/migrations), and Casper only has a throwaway SQLite");
});

test("a project's own verify.checks.migrations wins over the detected one", async () => {
  const f = await project({ "package.json": sqlitePkg, "migrations/001_sites.sql": SITES,
    ".casper/project.yaml": stringify({ verify: { checks: { migrations: { run: "echo own" } } } }) });
  const context = await loadProjectContext(await inspectProject(f.dir), { homeDir: f.home });
  expect(autoDetectedChecks(context.model)).toEqual([]);
  const [result] = await VerifierRegistry.forProject(context.model).run(["migrations"]);
  expect(result).toMatchObject({ status: "pass", command: "echo own" });
});

class EditingRuntime implements AgentRuntime {
  prompts: string[] = [];
  constructor(private readonly edit: (options: RuntimeStartOptions) => Promise<void>) {}
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    const info = () => ({ cwd: options.cwd, sessionId: "fixture", sessionFile: path.join(options.cwd, "..", "session.jsonl") });
    return { prompt: async (text) => { this.prompts.push(text); if (this.prompts.length === 1) await this.edit(options); }, setTools: () => {},
      abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }), clearConversation: async () => {},
      getSessionInfo: info, resumeConversation: async () => {}, forkSession: async () => info(), switchSession: async () => info() };
  }
  async dispose() {}
}

test("after the AI adds a broken migration, Casper runs the migrations check and hands the failure to the repair", async () => {
  const f = await project({ "package.json": sqlitePkg, "migrations/001_sites.sql": SITES,
    ".casper/project.yaml": stringify({ verification: { mode: "auto" }, repair: { maxAttempts: 1 } }) });
  await writeFile(path.join(f.root, "session.jsonl"), "");
  const runtime = new EditingRuntime(async (options) => {
    const file = path.join(f.dir, "migrations/002_ports.sql");
    await writeFile(file, "INSERT INTO switches (name) VALUES ('core');");
    await options.afterFileEdit!(file);
  });
  const output: string[] = [];
  const app = new CasperApp({ runtimeFactory: () => runtime, output: { write: (text) => { output.push(text); } }, sessionHomeDir: f.home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: f.home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ homeDir: f.home, projectRoot: context.info.root }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  cleanups.push(() => app.close().catch(() => {}));
  await app.start(f.dir);
  await app.runOnce("Add a ports table");
  const text = output.join("");
  expect(text).toContain("… Casper checking: migrations\n");
  expect(text).toContain("✗ migrations · 002_ports.sql failed — no such table: switches");
  expect(runtime.prompts[1]).toContain("Casper verification repair 1/1.");
  expect(runtime.prompts[1]).toContain("002_ports.sql failed — no such table: switches");
  expect(text).toContain("✗ Failed — migrations failed");
}, 30_000);
