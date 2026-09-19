import { afterEach, expect, test } from "bun:test";
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
  expect((await stat(path.join(context.stateDirectory, "memory.jsonl"))).mode & 0o777).toBe(0o600);
  expect(await store.context()).toContain("Current repository evidence");
  expect(await store.context()).toContain("Use pnpm");
  expect(await new ProjectMemory(projectStateDirectory(project + "-other", home)).facts()).toEqual([]);
  await expect(store.remember("😀".repeat(257))).rejects.toThrow("1024");
  await store.forget(added.id);
  expect(await store.context()).toBe("");
});

test("independent memory writers merge under a lock without losing facts", async () => {
  const { context, store } = await fixture();
  await Promise.all(Array.from({ length: 8 }, (_, index) => new ProjectMemory(context.stateDirectory).remember(`Fact ${index}`)));
  expect((await store.facts()).map((entry) => entry.text).sort()).toEqual(Array.from({ length: 8 }, (_, index) => `Fact ${index}`));
  for (let index = 0; index < 8; index++) await store.remember(`${index}:` + "x".repeat(1000));
  await expect(store.remember("more:" + "y".repeat(1000))).rejects.toThrow("fact budget");
});

test("malformed, duplicated, oversized, and symlinked state fails closed without resetting it", async () => {
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

test("non-regular memory state is rejected without waiting for a FIFO writer", async () => {
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
