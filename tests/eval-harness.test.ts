import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { observeHarness, runHarness } from "../evals/harness";

test("Casper observations use the last complete answer, not deltas or its verification claim", () => {
  const result = observeHarness("casper", [
    { v: 1, type: "session_start", session: "casper-conversation" },
    { v: 1, type: "assistant_delta", text: "Working" },
    { v: 1, type: "assistant_message", text: "I will fix it." },
    { v: 1, type: "assistant_message", text: "Fixed and tested." },
    { v: 1, type: "receipt", execution: "completed", outcome: "verified", exitCode: 0 },
  ], { exitCode: 0, timedOut: false, wallClockMs: 42 });
  expect(result).toEqual({
    answer: "Fixed and tested.", termination: "completed", exitCode: 0, wallClockMs: 42,
    turns: null, tokens: null, estimatedCost: null, receiptOutcome: "verified", sessionId: "casper-conversation", errors: [],
  });
});

test("Casper's turns, tokens and cost come from its receipt; an unknown value stays null", () => {
  const process = { exitCode: 0, timedOut: false, wallClockMs: 42 };
  const run = (usage: unknown) => observeHarness("casper", [
    { v: 1, type: "assistant_message", text: "Done." },
    { v: 1, type: "receipt", execution: "completed", outcome: "verified", exitCode: 0, usage },
  ], process);
  expect(run({ turns: 3, tokens: 900, estimatedCost: 0.01 })).toMatchObject({ turns: 3, tokens: 900, estimatedCost: 0.01 });
  // A subagent's calls are not totalled, so Casper reports tokens and cost as unknown.
  expect(run({ turns: 3, tokens: null, estimatedCost: null })).toMatchObject({ turns: 3, tokens: null, estimatedCost: null });
  expect(run({ turns: -1, tokens: 1.5, estimatedCost: "0.01" })).toMatchObject({ turns: null, tokens: null, estimatedCost: null });
  expect(run(null)).toMatchObject({ turns: null, tokens: null, estimatedCost: null });
});

test("Pi counts authoritative assistant usage once, excluding tool results and agent_end copies", () => {
  const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Implemented." }],
    usage: { totalTokens: 120, cost: { total: 0.02 } } };
  const result = observeHarness("pi", [
    { type: "session", version: 3, id: "pi-conversation" },
    { type: "message_end", message: { ...message, stopReason: "toolUse" } },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "Not an answer" }] } },
    { type: "message_end", message },
    { type: "agent_end", messages: [message] },
  ], { exitCode: 0, timedOut: false, wallClockMs: 70 });
  expect(result).toEqual({ answer: "Implemented.", termination: "completed", exitCode: 0,
    wallClockMs: 70, turns: 2, tokens: 240, estimatedCost: 0.04, receiptOutcome: null, sessionId: "pi-conversation", errors: [] });
});

test("a route pins both harnesses' model to the same OpenRouter hosts, without fallbacks", async () => {
  const written: unknown[] = [];
  for (const name of ["casper", "pi"] as const) {
    const workdir = await mkdtemp(path.join(os.tmpdir(), "casper-harness-route-"));
    try {
      await runHarness(name, { command: [process.execPath, path.join(import.meta.dir, "fixtures/eval-harness-cli.ts")],
        cwd: workdir, prompt: "inspect models", model: "openrouter/z-ai/glm-5.3-flash", effort: "medium", timeoutMs: 5000, route: ["Together", "Novita"] });
      written.push(JSON.parse(await readFile(path.join(workdir, "models.json"), "utf8")));
    } finally { await rm(workdir, { recursive: true, force: true }); }
  }
  // OpenRouter pins a conversation to one host; hosts differ tenfold in speed, so both harnesses get the same ones.
  expect(written[0]).toEqual({ providers: { openrouter: { modelOverrides: { "z-ai/glm-5.3-flash": {
    compat: { openRouterRouting: { only: ["Together", "Novita"], order: ["Together", "Novita"], allow_fallbacks: false } } } } } } });
  expect(written[1]).toEqual(written[0]);
  await expect(runHarness("pi", { command: ["true"], cwd: os.tmpdir(), prompt: "x", model: "github-copilot/gpt-5-mini", effort: "medium", timeoutMs: 1000, route: ["Together"] }))
    .rejects.toThrow("--route applies only to openrouter models");
});

test.each(["casper", "pi"] as const)("%s keeps a saved conversation in the caller's home for a follow-up", async name => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "casper-harness-session-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-harness-session-home-"));
  try {
    const args = async (resume: boolean) => {
      await runHarness(name, { command: [process.execPath, path.join(import.meta.dir, "fixtures/eval-harness-cli.ts")],
        cwd: workdir, prompt: "Go on.", model: "github-copilot/gpt-5-mini", effort: "medium", timeoutMs: 5000,
        session: { home, id: "bench-task-1", resume } });
      const observed = JSON.parse(await readFile(path.join(workdir, "observed.json"), "utf8"));
      expect(observed.home).toBe(home);
      return (observed.args as string[]).filter((arg) => ["--continue", "--session-id", "bench-task-1", "--no-session"].includes(arg));
    };
    // Casper resumes its latest conversation; Pi resumes by id and refuses --continue with it.
    expect(await args(false)).toEqual(name === "casper" ? [] : ["--session-id", "bench-task-1"]);
    expect(await args(true)).toEqual(name === "casper" ? ["--continue"] : ["--session-id", "bench-task-1"]);
    // The caller owns the home: it survives the run.
    expect(await stat(home).then(() => true, () => false)).toBe(true);
  } finally {
    await rm(workdir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test.each(["casper", "pi"] as const)("%s receives explicit identical task inputs and an isolated environment", async name => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "casper-harness-test-"));
  const previous = process.env.EVAL_HARNESS_SECRET;
  process.env.EVAL_HARNESS_SECRET = "must-not-inherit";
  try {
    const result = await runHarness(name, {
      command: [process.execPath, path.join(import.meta.dir, "fixtures/eval-harness-cli.ts")],
      cwd: workdir, prompt: "Implement the task.", model: "github-copilot/gpt-5-mini", effort: "medium",
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ answer: "Scripted answer.", termination: "completed", exitCode: 0 });
    const observed = JSON.parse(await readFile(path.join(workdir, "observed.json"), "utf8"));
    expect(observed.inheritedSecret).toBeNull();
    expect(observed.home).not.toBe(os.homedir());
    expect(await stat(observed.home).then(() => true, () => false)).toBe(false);
    // No turn limit: Pi's CLI has none, so a Casper-only limit would stop only Casper.
    expect(observed.args).toEqual(name === "casper"
      ? ["--json", "--model", "github-copilot/gpt-5-mini", "--effort", "medium", "--verify", "--", "Implement the task."]
      : ["--print", "--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--model", "github-copilot/gpt-5-mini", "--thinking", "medium", "--", "Implement the task."]);
  } finally {
    if (previous === undefined) delete process.env.EVAL_HARNESS_SECRET; else process.env.EVAL_HARNESS_SECRET = previous;
    await rm(workdir, { recursive: true, force: true });
  }
});

test("casper-no-review is the Casper CLI and protocol with the review round off in its user configuration", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "casper-harness-variant-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-harness-variant-home-"));
  try {
    const result = await runHarness("casper-no-review", { command: [process.execPath, path.join(import.meta.dir, "fixtures/eval-harness-cli.ts")],
      cwd: workdir, prompt: "Implement the task.", model: "github-copilot/gpt-5-mini", effort: "medium", timeoutMs: 5000,
      session: { home, id: "bench-1", resume: false } });
    expect(result).toMatchObject({ answer: "Scripted answer.", termination: "completed", receiptOutcome: "unverified" });
    const observed = JSON.parse(await readFile(path.join(workdir, "observed.json"), "utf8"));
    expect(observed.args).toEqual(["--json", "--model", "github-copilot/gpt-5-mini", "--effort", "medium", "--verify", "--", "Implement the task."]);
    expect(observed.casperDir).toBe(path.join(home, ".casper/agent"));
    expect(await readFile(path.join(home, ".casper/config.yaml"), "utf8")).toBe("verification:\n  review: false\n");
  } finally {
    await rm(workdir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test.each(["casper", "pi"] as const)("%s stops a hung CLI at its deadline", async name => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "casper-harness-timeout-"));
  try {
    const result = await runHarness(name, {
      command: [process.execPath, path.join(import.meta.dir, "fixtures/eval-harness-cli.ts")],
      cwd: workdir, prompt: "hang", model: "test/model", effort: "medium", timeoutMs: 100,
    });
    expect(result.termination).toBe("timeout");
    expect(result.wallClockMs).toBeLessThan(3000);
  } finally { await rm(workdir, { recursive: true, force: true }); }
});

test.each(["casper", "pi"] as const)("%s copies only the selected provider and preserves the caller's seed files", async name => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-harness-seed-"));
  try {
    const authPath = path.join(root, "auth.json");
    const modelsStorePath = path.join(root, "models-store.json");
    const auth = JSON.stringify({ test: { type: "api_key", key: "synthetic" }, other: { type: "api_key", key: "unrelated" } });
    await writeFile(authPath, auth);
    await writeFile(modelsStorePath, '{"synthetic":true}');
    const result = await runHarness(name, {
      command: [process.execPath, path.join(import.meta.dir, "fixtures/eval-harness-cli.ts")],
      cwd: root, prompt: "inspect seed", model: "test/model", effort: "medium", timeoutMs: 2000,
      seed: { authPath, modelsStorePath },
    });
    expect(result.termination).toBe("completed");
    expect(JSON.parse(await readFile(path.join(root, "seed.json"), "utf8")))
      .toEqual({ providers: ["test"], catalog: '{"synthetic":true}' });
    expect(await readFile(authPath, "utf8")).toBe(auth);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Casper's own failed verdict is a finished run, not a failed one: the tree is graded like Pi's", () => {
  const events = (exitCode: number) => [
    { v: 1, type: "assistant_message", text: "Implemented it." },
    { v: 1, type: "receipt", execution: "completed", outcome: "failed", exitCode },
  ];
  expect(observeHarness("casper", events(1), { exitCode: 1, timedOut: false, wallClockMs: 5 }).termination).toBe("completed");
  // Phases are timed on the harness clock as their events arrive; one still running when the run
  // ended (a timeout) is recorded as unfinished, up to the end of the run.
  const phased = observeHarness("casper", [
    { v: 1, type: "phase", phase: "task", state: "start", atMs: 1 },
    { v: 1, type: "tool_start", tool: "bash", id: "a", target: "bun test" },
    { v: 1, type: "tool_end", tool: "bash", id: "a", ok: true, ms: 900 },
    { v: 1, type: "tool_end", tool: "bash", id: "b", ok: false, ms: 100 },
    { v: 1, type: "tool_end", tool: "write", id: "c", ok: true, ms: 5 },
    { v: 1, type: "phase", phase: "task", state: "end", atMs: 2 },
    { v: 1, type: "phase", phase: "review", state: "start", atMs: 3 },
  ], { exitCode: null, timedOut: true, wallClockMs: 300, eventTimes: [10, 20, 30, 31, 32, 110, 120] });
  expect(phased.phases).toEqual([{ phase: "task", durationMs: 100 }, { phase: "review", durationMs: 180, unfinished: true }]);
  expect(phased.tools).toEqual([{ tool: "bash", calls: 2, ms: 1000 }, { tool: "write", calls: 1, ms: 5 }]);
  // The receipt must account for the exit code, and a failed execution stays failed.
  expect(observeHarness("casper", events(0), { exitCode: 1, timedOut: false, wallClockMs: 5 }).termination).toBe("failed");
  expect(observeHarness("casper", [{ v: 1, type: "assistant_message", text: "x" }, { v: 1, type: "receipt", execution: "failed", exitCode: 1 }],
    { exitCode: 1, timedOut: false, wallClockMs: 5 }).termination).toBe("failed");
});

test("a Casper run whose checks failed is still completed through the CLI; its stderr is not an error", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "casper-harness-verdict-"));
  try {
    const result = await runHarness("casper", {
      command: [process.execPath, path.join(import.meta.dir, "fixtures/eval-harness-cli.ts")],
      cwd: workdir, prompt: "checks fail", model: "test/model", effort: "medium", timeoutMs: 2000,
    });
    expect(result).toMatchObject({ termination: "completed", exitCode: 1, errors: [] });
  } finally { await rm(workdir, { recursive: true, force: true }); }
});

test("a clean exit without a completed assistant exchange is not success", () => {
  const process = { exitCode: 0, timedOut: false, wallClockMs: 1 };
  expect(observeHarness("pi", [{ type: "message_end", message: {
    role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Answer" }],
  } }], process).termination).toBe("failed");
  expect(observeHarness("casper", [{ v: 1, type: "receipt", execution: "completed" }], process).termination).toBe("failed");
});

test("errors and incompatible Casper events cannot become completed observations", () => {
  const process = { exitCode: 0, timedOut: false, wallClockMs: 1 };
  // A provider failure Casper did not recover from ends in a failed receipt.
  expect(observeHarness("casper", [
    { v: 1, type: "error", message: "Provider unavailable" },
    { v: 1, type: "receipt", execution: "failed", exitCode: 1 },
  ], { ...process, exitCode: 1 })).toMatchObject({ termination: "failed", errors: ["Provider unavailable"] });
  expect(observeHarness("casper", [{ v: 2, type: "receipt", execution: "completed" }], process))
    .toMatchObject({ termination: "failed", errors: ["Unsupported Casper event version"] });
  expect(observeHarness("pi", [
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Quota exceeded", content: [] } },
    { type: "agent_end" },
  ], process)).toMatchObject({ termination: "failed", errors: ["Quota exceeded"], tokens: null, estimatedCost: null });
  expect(observeHarness("casper", [{ v: 1, type: "receipt", execution: "completed" }], { ...process, timedOut: true }).termination).toBe("timeout");
});

test("a provider error the CLI retried past is kept as a diagnostic; the final state decides the run", () => {
  const process = { exitCode: 0, timedOut: false, wallClockMs: 1 };
  // Seen in the first live benchmark run: both harnesses retried a dropped connection and finished.
  expect(observeHarness("casper", [
    { v: 1, type: "error", message: "The socket connection was closed unexpectedly." },
    { v: 1, type: "assistant_message", text: "Added the Tabs component." },
    { v: 1, type: "receipt", execution: "completed", outcome: "verified", exitCode: 0 },
  ], process)).toMatchObject({ termination: "completed", answer: "Added the Tabs component.", errors: ["The socket connection was closed unexpectedly."] });
  expect(observeHarness("pi", [
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "terminated", content: [], usage: { totalTokens: 0, cost: { total: 0 } } } },
    { type: "auto_retry_start" }, { type: "auto_retry_end" },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Added it." }], usage: { totalTokens: 50, cost: { total: 0.01 } } } },
    { type: "agent_end" },
  ], process)).toMatchObject({ termination: "completed", answer: "Added it.", turns: 2, tokens: 50, errors: ["terminated"] });
});
