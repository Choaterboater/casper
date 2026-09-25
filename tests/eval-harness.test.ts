import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { observeHarness, runHarness } from "../evals/harness";

test("Casper observations use the last complete answer, not deltas or its verification claim", () => {
  const result = observeHarness("casper", [
    { v: 1, type: "assistant_delta", text: "Working" },
    { v: 1, type: "assistant_message", text: "I will fix it." },
    { v: 1, type: "assistant_message", text: "Fixed and tested." },
    { v: 1, type: "receipt", execution: "completed", outcome: "verified", exitCode: 0 },
  ], { exitCode: 0, timedOut: false, wallClockMs: 42 });
  expect(result).toEqual({
    answer: "Fixed and tested.", termination: "completed", exitCode: 0, wallClockMs: 42,
    turns: null, tokens: null, estimatedCost: null, errors: [],
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
    { type: "message_end", message: { ...message, stopReason: "toolUse" } },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "Not an answer" }] } },
    { type: "message_end", message },
    { type: "agent_end", messages: [message] },
  ], { exitCode: 0, timedOut: false, wallClockMs: 70 });
  expect(result).toEqual({ answer: "Implemented.", termination: "completed", exitCode: 0,
    wallClockMs: 70, turns: 2, tokens: 240, estimatedCost: 0.04, errors: [] });
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

test("a clean exit without a completed assistant exchange is not success", () => {
  const process = { exitCode: 0, timedOut: false, wallClockMs: 1 };
  expect(observeHarness("pi", [{ type: "message_end", message: {
    role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Answer" }],
  } }], process).termination).toBe("failed");
  expect(observeHarness("casper", [{ v: 1, type: "receipt", execution: "completed" }], process).termination).toBe("failed");
});

test("errors and incompatible Casper events cannot become completed observations", () => {
  const process = { exitCode: 0, timedOut: false, wallClockMs: 1 };
  expect(observeHarness("casper", [
    { v: 1, type: "error", message: "Provider unavailable" },
    { v: 1, type: "receipt", execution: "completed" },
  ], process)).toMatchObject({ termination: "failed", errors: ["Provider unavailable"] });
  expect(observeHarness("casper", [{ v: 2, type: "receipt", execution: "completed" }], process))
    .toMatchObject({ termination: "failed", errors: ["Unsupported Casper event version"] });
  expect(observeHarness("pi", [
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Quota exceeded", content: [] } },
    { type: "agent_end" },
  ], process)).toMatchObject({ termination: "failed", errors: ["Quota exceeded"], tokens: null, estimatedCost: null });
  expect(observeHarness("casper", [{ v: 1, type: "receipt", execution: "completed" }], { ...process, timedOut: true }).termination).toBe("timeout");
});
