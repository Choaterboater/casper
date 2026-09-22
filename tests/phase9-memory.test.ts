import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { BigIntStats, StatOptions, Stats } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectMemory } from "../src/memory/store";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { projectStateDirectory } from "../src/project/model";
import { SkillRegistry } from "../src/skills/registry";
import type { RuntimeEventListener, RuntimeSession } from "../src/runtime/types";
import type { VerificationReport } from "../src/verify/evidence";
import { VerifierRegistry } from "../src/verify/registry";
import { verifyAndRepair } from "../src/verify/repair-loop";
import { runCommandCheck } from "../src/verify/command";
import { needsFifos, needsSymlinks, posixModes } from "./support/platform";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-memory-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(project);
  const context = await loadProjectContext({ root: project, cwd: project, gitBranch: null, name: "project", isGit: false }, { homeDir: home });
  return { root, home, project, context, store: new ProjectMemory(context.stateDirectory) };
}

test("facts are explicit, idempotent, bounded, inspectable, and isolated by workspace", async () => {
  const { home, project, context, store } = await fixture();
  expect(await store.facts()).toEqual([]);
  const added = await store.remember("Use pnpm for package scripts.");
  expect(await store.remember("Use pnpm for package scripts.")).toEqual(added);
  expect(await new ProjectMemory(context.stateDirectory).facts()).toEqual([added]);
  // Mode bits are a POSIX guarantee; Windows synthesizes them (tests/support/platform.ts).
  if (posixModes) expect((await stat(path.join(context.stateDirectory, "memory.jsonl"))).mode & 0o777).toBe(0o600);
  expect(await store.context()).toContain("Current repository evidence");
  expect(await store.context()).toContain("Use pnpm");
  expect(await new ProjectMemory(projectStateDirectory(project + "-other", home)).facts()).toEqual([]);
  await expect(store.remember("😀".repeat(257))).rejects.toThrow("1024");
  await store.forget(added.id);
  expect(await store.context()).toBe("");
});

test("small memory reads allocate only the observed file size plus a sentinel", async () => {
  const { context, store } = await fixture();
  const saved = await store.remember("Use pnpm.");
  const size = (await stat(path.join(context.stateDirectory, "memory.jsonl"))).size;
  const allocate = spyOn(Buffer, "alloc");
  try {
    expect(await store.facts()).toEqual([saved]);
    expect(allocate.mock.calls.map(([bytes]) => bytes)).toEqual([size + 1]);
  } finally { allocate.mockRestore(); }
});

test("right-sized reads retain empty, exact-byte-limit and record-limit behavior", async () => {
  const { context, store } = await fixture();
  const file = path.join(context.stateDirectory, "memory.jsonl");
  await writeFile(file, "");
  expect(await store.facts()).toEqual([]);
  const value = { id: "one", text: "Fact", createdAt: "now" };
  const line = JSON.stringify(value) + "\n";
  await writeFile(file, line.padEnd(1_048_576, " "));
  expect(await store.facts()).toEqual([value]);
  await fs.appendFile(file, " ");
  await expect(store.facts()).rejects.toThrow("Cannot read valid memory state");
  const lines = Array.from({ length: 1000 }, (_, index) => JSON.stringify({ ...value, id: String(index) }) + "\n").join("");
  await writeFile(file, lines);
  expect(await store.facts()).toHaveLength(1000);
  await fs.appendFile(file, line);
  await expect(store.facts()).rejects.toThrow("Cannot read valid memory state");
});

test("memory reads reject growth after fstat rather than admitting a partial JSONL prefix", async () => {
  const { context, store } = await fixture();
  await store.remember("Original fact");
  const file = path.join(context.stateDirectory, "memory.jsonl");
  const original = await readFile(file, "utf8");
  const originalOpen = fs.open;
  // Inject a real append after the reader's fstat, at the filesystem seam.
  const opened = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === file) {
      const originalStat = handle.stat.bind(handle);
      function growingStat(options?: StatOptions & { bigint?: false }): Promise<Stats>;
      function growingStat(options: StatOptions & { bigint: true }): Promise<BigIntStats>;
      function growingStat(options?: StatOptions): Promise<Stats | BigIntStats>;
      async function growingStat(options?: StatOptions): Promise<Stats | BigIntStats> {
        const info = await originalStat(options);
        // Whitespace is valid JSONL padding: parsing alone cannot detect truncation.
        await fs.appendFile(file, "\n" + JSON.stringify({ id: "late", text: "Late fact", createdAt: "now" }) + "\n");
        return info;
      }
      handle.stat = growingStat;
    }
    return handle;
  });
  try {
    await expect(store.facts()).rejects.toThrow("Cannot read valid memory state");
  } finally { opened.mockRestore(); }
  expect(await readFile(file, "utf8")).toStartWith(original);
  expect((await store.facts()).map((entry) => entry.text)).toEqual(["Original fact", "Late fact"]);
});

test("independent memory writers merge under a lock without losing facts", async () => {
  const { context, store } = await fixture();
  await Promise.all(Array.from({ length: 8 }, (_, index) => new ProjectMemory(context.stateDirectory).remember(`Fact ${index}`)));
  expect((await store.facts()).map((entry) => entry.text).sort()).toEqual(Array.from({ length: 8 }, (_, index) => `Fact ${index}`));
  for (let index = 0; index < 8; index++) await store.remember(`${index}:` + "x".repeat(1000));
  await expect(store.remember("more:" + "y".repeat(1000))).rejects.toThrow("fact budget");
});

needsSymlinks("malformed, duplicated, oversized, and symlinked state fails closed without resetting it", async () => {
  const { root, context, store } = await fixture();
  const file = path.join(context.stateDirectory, "memory.jsonl");
  await writeFile(file, "bad json\n");
  await expect(store.remember("new fact")).rejects.toThrow("Cannot read valid memory");
  expect(await readFile(file, "utf8")).toBe("bad json\n");
  const item = { id: "same", text: "fact", createdAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(item) + "\n" + JSON.stringify(item) + "\n");
  await expect(store.facts()).rejects.toThrow();
  await writeFile(file, "x".repeat(1_048_577));
  await expect(store.facts()).rejects.toThrow();
  await rm(file); const external = path.join(root, "external"); await writeFile(external, "keep"); await symlink(external, file);
  await expect(store.remember("do not follow symlink")).rejects.toThrow();
  expect(await readFile(external, "utf8")).toBe("keep");
});

needsFifos("non-regular memory state is rejected without waiting for a FIFO writer", async () => {
  const { context } = await fixture();
  const file = path.join(context.stateDirectory, "memory.jsonl");
  const fifo = Bun.spawn(["mkfifo", file], { stdout: "ignore", stderr: "pipe" });
  expect(await fifo.exited).toBe(0);
  // A subprocess makes a blocked filesystem open killable without leaking a worker.
  const child = Bun.spawn([process.execPath, "-e", `
    import { ProjectMemory } from ${JSON.stringify(path.resolve("src/memory/store.ts"))};
    try { await new ProjectMemory(process.argv[1]).facts(); process.exitCode = 2; }
    catch { console.log("rejected"); }
  `, context.stateDirectory], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 1000);
  try {
    await child.exited;
    expect(timedOut).toBe(false);
    expect(await new Response(child.stdout).text()).toBe("rejected\n");
  } finally { clearTimeout(timer); child.kill(); }
});

test("outcome state rejects coerced enum values and unknown nested evidence fields", async () => {
  const { context, store } = await fixture();
  const saved = await store.recordOutcome({ task: "inspect", skills: [], modelStatus: "completed" });
  const file = path.join(context.stateDirectory, "outcomes.jsonl");
  for (const patch of [
    { modelStatus: ["completed"] },
    { verification: ["pass"] },
    { checks: [{ name: "test", status: ["skip"] }] },
    { checks: [{ name: "test", status: "pass", stdout: "must not be accepted" }] },
    { checks: [{ name: "test", status: "pass", freshness: ["fresh"] }] },
    { checks: [{ name: "test", status: "pass", scope: { inputs: ["../outside"] } }] },
    { checks: [{ name: "test", status: "pass", freshnessReason: "x".repeat(2049) }] },
    { checks: [{ name: "test", status: "pass", exitCode: "0" }] },
    { coverage: "certified" },
    { verificationMeaning: ["command-execution"] },
  ]) {
    const source = JSON.stringify({ ...saved, ...patch }) + "\n";
    await writeFile(file, source);
    await expect(store.outcomes()).rejects.toThrow("Cannot read valid memory");
    await expect(store.acceptOutcome(saved.id, true)).rejects.toThrow("Cannot read valid memory");
    expect(await readFile(file, "utf8")).toBe(source);
  }
});

test("outcomes preserve skip/unverified evidence and never infer human acceptance", async () => {
  const { context, store } = await fixture();
  const report: VerificationReport = { status: "incomplete", repairAttempts: 1, rounds: [], results: [{
    name: "test", status: "skip", cwd: "/fixture", exitCode: null, signal: null, stdout: "DO_NOT_STORE_OUTPUT", stderr: "", durationMs: 0, truncated: false,
  }] };
  const first = await store.recordOutcome({ task: "inspect the authentication flow", skills: [], modelStatus: "completed" });
  const second = await store.recordOutcome({ task: "fix test setup", skills: ["typescript@fixture"], modelStatus: "completed", verification: report });
  expect(first.verification).toBe("not-run");
  expect(first.accepted).toBeNull(); expect(second.accepted).toBeNull();
  expect(second.verification).toBe("incomplete");
  expect(second.checks).toMatchObject([{ name: "test", status: "skip", exitCode: null, freshness: "unavailable" }]);
  expect(await readFile(path.join(context.stateDirectory, "outcomes.jsonl"), "utf8")).not.toContain("DO_NOT_STORE_OUTPUT");
  await store.acceptOutcome(second.id, true);
  const saved = (await store.outcomes()).find((entry) => entry.id === second.id)!;
  expect(saved.accepted).toBe(true);
  expect(saved.verification).toBe("incomplete");
});

test("legacy outcomes stay readable and explicitly unqualified in local memory inspection", async () => {
  const { project, context, store } = await fixture();
  const legacy = { id: "legacy", createdAt: "2026-01-01T00:00:00.000Z", task: "Build", skills: [],
    modelStatus: "completed", verification: "pass", checks: [{ name: "build", status: "pass" }], repairAttempts: 0, accepted: null };
  const file = path.join(context.stateDirectory, "outcomes.jsonl");
  const source = JSON.stringify(legacy) + "\n";
  await writeFile(file, source);
  const [saved] = await store.outcomes();
  expect(saved?.checks[0]).toMatchObject({ freshness: "unavailable", exitCode: null });
  expect(saved?.checks[0]?.freshnessReason).toContain("not recorded");
  expect(saved?.verificationMeaning).toBeUndefined();
  let output = "";
  const app = new CasperApp({ output: { write: (value) => { output += value; } }, loadProjectContext: async () => context });
  cleanup.push(() => app.close());
  await app.runOnce("/memory outcomes", project);
  expect(output).toContain('"verificationMeaning": "legacy"');
  expect(output).toContain('"freshness": "unavailable"');
  expect(output).toContain('"coverage": "not-certified"');
  expect(await readFile(file, "utf8")).toBe(source);
});

test("saved command passes retain stale, unknown and declared-scope qualifications after reopening", async () => {
  for (const freshness of ["fresh", "stale", "unavailable"] as const) {
    const { project, context, store } = await fixture();
    await writeFile(path.join(project, "source.ts"), "before");
    const scope = freshness === "unavailable" ? undefined : { inputs: ["source.ts"] };
    const registry = new VerifierRegistry();
    registry.register({ name: "build", scope, run: () => runCommandCheck({ name: "build", cwd: project, timeoutMs: 1000,
      command: freshness === "stale" ? "printf after > source.ts" : "printf DO_NOT_STORE_OUTPUT" }) });
    const report = await verifyAndRepair({ registry, checks: ["build"], cwd: project, request: "Build" });
    await store.recordOutcome({ task: "Build", skills: [], modelStatus: "completed", verification: report });
    const [saved] = await new ProjectMemory(context.stateDirectory).outcomes();
    expect(saved).toMatchObject({ verification: "pass", verificationMeaning: "command-execution", coverage: "not-certified", accepted: null });
    expect(saved?.checks[0]).toMatchObject({ name: "build", status: "pass", exitCode: 0, freshness });
    expect(saved?.checks[0]?.scope).toEqual(scope);
    if (freshness === "stale") expect(saved?.checks[0]?.freshnessReason).toContain("Declared inputs changed");
    if (freshness === "unavailable") expect(saved?.checks[0]?.freshnessReason).toContain("No input scope declared");
    expect(JSON.stringify(saved)).not.toContain("DO_NOT_STORE_OUTPUT");
    expect(JSON.stringify(saved)).not.toContain("workspaceState");
  }
});

needsSymlinks("unavailable facts warn and omit guidance without blocking tasks or rewriting facts", async () => {
  const { project, home, context, store } = await fixture();
  const prompts: string[] = [];
  let output = "";
  const session: RuntimeSession = {
    setTools: () => {}, subscribe: () => () => {},
    prompt: async (value) => {
      prompts.push(value);
      if (value.includes("Fail deliberately")) throw new Error("Scripted runtime failure");
    }, abort: async () => {},
    getState: () => ({ cwd: project, isStreaming: false }),
  };
  const app = new CasperApp({
    output: { write: (value) => { output += value; } },
    runtimeFactory: () => ({ start: async () => session, dispose: async () => {} }),
    sessionHomeDir: home, loadProjectContext: async () => context,
    loadSkillRegistry: () => SkillRegistry.discover({ projectRoot: project, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  cleanup.push(() => app.close());
  const file = path.join(context.stateDirectory, "memory.jsonl");
  const overBudget = Array.from({ length: 65 }, (_, index) => JSON.stringify({ id: String(index), text: "Over-budget guidance", createdAt: "now" }) + "\n").join("");
  for (const source of ["{not json\nPRIVATE_FACT\u001b[31m", "x".repeat(1_048_577), JSON.stringify({ id: "bad", text: 12, createdAt: "now" }), Buffer.from([0xff, 0x0a]), overBudget]) {
    await writeFile(file, source);
    output = "";
    await app.runOnce("Inspect the repository", project);
    expect(prompts.at(-1)).toContain("Inspect the repository");
    expect(prompts.at(-1)).not.toContain("Casper human-entered project facts");
    expect(output).not.toContain("PRIVATE_FACT");
    expect(app.getLastTaskResult()?.execution).toBe("completed");
    expect((await store.outcomes())[0]).toMatchObject({ modelStatus: "completed", verification: "not-run", accepted: null });
    const count = prompts.length;
    for (const command of ["/memory", "/memory remember Do not overwrite", "/memory forget bad"]) {
      if (source === overBudget && command === "/memory") {
        // Structurally valid facts remain inspectable even if the prompt budget rejects them.
        await app.runOnce(command);
      } else {
        await expect(app.runOnce(command)).rejects.toThrow();
      }
    }
    expect(prompts).toHaveLength(count);
    expect(await readFile(file)).toEqual(Buffer.from(source));
  }
  await writeFile(file, "bad json\n");
  await expect(app.runOnce("Fail deliberately")).rejects.toThrow("Scripted runtime failure");
  expect(app.getLastTaskResult()?.execution).toBe("failed");
  expect((await store.outcomes())[0]).toMatchObject({ modelStatus: "failed", verification: "not-run", accepted: null });
  expect(await readFile(file, "utf8")).toBe("bad json\n");
  // Manual repair is observed on the next prompt, without restarting the app.
  await writeFile(file, "");
  await app.runOnce("/memory remember Restored guidance");
  output = "";
  await app.runOnce("Inspect again");
  expect(prompts.at(-1)).toContain("Restored guidance");
  await rm(file);
  const external = path.join(home, "PRIVATE_PATH");
  await writeFile(external, "Do not read or rewrite");
  await symlink(external, file);
  output = "";
  await app.runOnce("Inspect with unreadable facts");
  expect(prompts.at(-1)).not.toContain("Restored guidance");
  expect(output).not.toContain("PRIVATE_PATH");
  expect(await readFile(external, "utf8")).toBe("Do not read or rewrite");
  expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
  await rm(file);
  output = "";
  await app.runOnce("Inspect with no facts");
  expect(prompts.at(-1)).not.toContain("Restored guidance");
});

test("shutdown during a failing facts read cannot start a late runtime or record an outcome", async () => {
  const { project, home, context, store } = await fixture();
  let starts = 0;
  let output = "";
  const app = new CasperApp({
    output: { write: (value) => { output += value; } },
    runtimeFactory: () => { starts++; throw new Error("Unexpected runtime initialization"); },
    sessionHomeDir: home, loadProjectContext: async () => context,
    loadSkillRegistry: () => SkillRegistry.discover({ projectRoot: project, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  cleanup.push(() => app.close());
  const facts = spyOn(ProjectMemory.prototype, "context").mockImplementation(async () => {
    await app.close();
    throw new Error("Read failed during shutdown");
  });
  try { await app.runOnce("Inspect the repository", project); }
  finally { facts.mockRestore(); }
  expect(starts).toBe(0);
  expect(output).not.toContain("Facts unavailable");
  expect(app.getLastTaskResult()).toBeUndefined();
  expect(await store.outcomes()).toEqual([]);
});

test("memory commands stay local; facts reach only this project's prompts and tasks record honest outcomes", async () => {
  const { project, home, context, store } = await fixture();
  let starts = 0; const prompts: string[] = []; let listener: RuntimeEventListener | undefined;
  const session: RuntimeSession = {
    setTools: () => {}, subscribe: (callback) => { listener = callback; return () => { listener = undefined; }; },
    prompt: async (value) => {
      prompts.push(value);
      listener?.({ type: "assistant_response_end", stopReason: value.includes("fail deliberately") ? "error" : "stop" });
    }, abort: async () => {}, getState: () => ({ cwd: project, isStreaming: false }),
  };
  const app = new CasperApp({
    output: { write: () => {} }, runtimeFactory: () => ({ start: async () => { starts++; return session; }, dispose: async () => {} }),
    sessionHomeDir: home, loadProjectContext: async () => context,
    loadSkillRegistry: () => SkillRegistry.discover({ projectRoot: project, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }), loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
  });
  cleanup.push(() => app.close());
  await app.runOnce("/memory remember API calls belong in services/", project);
  await app.runOnce("/memory"); expect(starts).toBe(0);
  await app.runOnce("Inspect authentication");
  expect(prompts[0]).toContain("API calls belong in services/");
  const first = (await store.outcomes())[0]!;
  expect(first.modelStatus).toBe("completed"); expect(first.verification).toBe("not-run"); expect(first.accepted).toBeNull();
  await app.runOnce(`/memory accept ${first.id} yes`);
  expect((await store.outcomes())[0]!.accepted).toBe(true);
  await app.runOnce("fail deliberately");
  expect((await store.outcomes())[0]!.modelStatus).toBe("failed");
  await app.runOnce(`/memory forget ${(await store.facts())[0]!.id}`);
  await app.runOnce("Inspect again");
  expect(prompts.at(-1)).not.toContain("API calls belong in services/");
  await app.runOnce("/memory outcomes"); expect(prompts).toHaveLength(3);
});
