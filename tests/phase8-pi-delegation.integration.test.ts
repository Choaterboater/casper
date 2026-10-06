import { expect, test } from "bun:test";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeEvent } from "../src/runtime/types";
import { cleanUpAfterEach, stream, answer, calls, fixture, snapshot, throttled, cli, adapter } from "./support/phase8-pi";

cleanUpAfterEach();

test("real parent Pi delegates and receives the child report without sharing child tools or history", async () => {
  let parentCalls = 0; let childCalls = 0;
  const f = await fixture((payload) => {
    const isChild = payload.tools.length === 4;
    if (isChild) return childCalls++ === 0
      ? calls([{ name: "read", args: { path: "fixture.txt" } }])
      : answer("REVIEW_REPORT: fixture.txt:1 contains LOCAL_EVIDENCE_8; no tests executed.");
    return parentCalls++ === 0
      ? calls([{ name: "delegate", args: { role: "reviewer", goal: "Inspect fixture.txt", context: "Be specific about evidence." } }])
      : answer("PARENT_DONE");
  });
  const before = await snapshot(f.project);
  const result = await f.run([cli, "PARENT_PRIVATE_CONTEXT: delegate an independent review"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain("PARENT_DONE");
  expect(parentCalls).toBe(2); expect(childCalls).toBe(2);
  const childPayloads = f.payloads.filter((payload) => payload.tools.length === 4);
  expect(childPayloads.every((payload) => !JSON.stringify(payload).includes("PARENT_PRIVATE_CONTEXT"))).toBe(true);
  expect(JSON.stringify(childPayloads[0])).toContain("Be specific about evidence");
  expect(JSON.stringify(f.payloads.at(-1)?.messages)).toContain("REVIEW_REPORT");
  expect(await snapshot(f.project)).toEqual(before);
  const sessions = await readdir(path.join(f.agent, "sessions"), { recursive: true });
  expect(sessions.filter((file) => file.endsWith(".jsonl"))).toHaveLength(1);
}, 60_000);

test("a real delegating task's receipt totals the parent's and the child's reported tokens", async () => {
  // The finishing chunk reports usage, as OpenAI-compatible providers do.
  const billed = async (response: Response, total: number) => new Response((await response.text()).replace(/("finish_reason":"(?:stop|tool_calls)"\}\])/,
    `$1,"usage":${JSON.stringify({ prompt_tokens: total - 1, completion_tokens: 1, total_tokens: total })}`), { headers: { "content-type": "text/event-stream" } });
  let parentCalls = 0; let childCalls = 0;
  const f = await fixture((payload) => {
    if (payload.tools.length === 4) return childCalls++ === 0 ? billed(calls([{ name: "read", args: { path: "fixture.txt" } }]), 10)
      : billed(answer("REVIEW_REPORT: fixture.txt:1 contains LOCAL_EVIDENCE_8."), 20);
    return parentCalls++ === 0 ? billed(calls([{ name: "delegate", args: { role: "reviewer", goal: "Inspect fixture.txt" } }]), 100)
      : billed(answer("PARENT_DONE"), 200);
  });
  const result = await f.run([cli, "--json", "delegate an independent review"]);
  expect(result.stderr).not.toContain("Error");
  const receipt = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.type === "receipt");
  expect(childCalls).toBe(2);
  expect(receipt.usage).toMatchObject({ turns: 2, tokens: 330 });
}, 60_000);

for (const mode of ["turns", "calls"]) test(`real read-only Pi enforces ${mode} budget before more work`, async () => {
  const f = await fixture(() => calls(Array.from({ length: mode === "calls" ? 8 : 1 }, () => ({ name: "read", args: { path: "fixture.txt" } }))));
  const result = await f.run([adapter, f.project, mode]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const report: { events: RuntimeEvent[]; replaceBlocked: boolean } = JSON.parse(result.stdout.split("READONLY_RESULT=")[1]!);
  expect(report.replaceBlocked).toBe(true);
  expect(report.events).toContainEqual(expect.objectContaining({ type: "assistant_response_end", stopReason: "limit" }));
  expect(f.payloads).toHaveLength(mode === "turns" ? 2 : 1);
  expect(report.events.filter((event) => event.type === "tool_end" && !event.isError)).toHaveLength(mode === "turns" ? 2 : 3);
}, 60_000);

test("real read-only Pi spends its one opt-in report turn without doing more work", async () => {
  const f = await fixture(() => calls([{ name: "read", args: { path: "fixture.txt" } }]));
  const result = await f.run([adapter, f.project, "report"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const report: { events: RuntimeEvent[]; replaceBlocked: boolean } = JSON.parse(result.stdout.split("READONLY_RESULT=")[1]!);
  expect(report.events).toContainEqual(expect.objectContaining({ type: "assistant_response_end", stopReason: "limit" }));
  // Two budget turns plus the report turn, and the report turn runs no tools at all.
  expect(f.payloads).toHaveLength(3);
  expect(report.events.filter((event) => event.type === "tool_end" && !event.isError)).toHaveLength(2);
  expect(report.events.filter((event) => event.type === "tool_end" && event.isError).length).toBeGreaterThan(0);
}, 30_000);

test("delegation follows a reviewed worktree switch and return with fresh project context", async () => {
  const f = await fixture((payload) => payload.messages.some((message) => message.role === "tool")
    ? answer("WORKSPACE_EVIDENCE: fixture.txt:1")
    : calls([{ name: "read", args: { path: "fixture.txt" } }]));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: f.project });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  };
  git("init", "-b", "main");
  git("config", "user.name", "Casper Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("add", "fixture.txt"); git("commit", "-m", "Fixture baseline");
  const harness = path.join(f.agent, "switch-fixture.ts");
  await writeFile(harness, `import { CasperApp } from ${JSON.stringify(path.join(import.meta.dir, "../src/app.ts"))};
import { PassThrough } from 'node:stream';
const input = new PassThrough();
const commands = ['/branch candidate', '/delegate explorer inspect fixture.txt', '/switch main discard', '/delegate reviewer inspect fixture.txt', '/exit'];
const app = new CasperApp({ input, output: { write(text) {
  process.stdout.write(text);
  if (text === '> ') queueMicrotask(() => input.write(commands.shift() + '\\n'));
  else if (text.endsWith('Type 1 or 2: ')) queueMicrotask(() => input.write('2\\n'));
} } });
try { await app.runInteractive(); } finally { await app.close(); }
`);
  // On Windows, in a full parallel run, this test has needed more than the default 10 s.
  const result = await f.run([harness]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).not.toContain("[error]");
  const worktree = result.stdout.match(/\[sessions\] active candidate · ([^\n]+)/)?.[1];
  expect(worktree).toContain(path.join(".casper", "worktrees") + path.sep);
  expect(f.payloads).toHaveLength(4);
  // The payloads are JSON, where a Windows path's backslashes are escaped.
  const json = (text: string) => JSON.stringify(text).slice(1, -1);
  expect(JSON.stringify(f.payloads[0]?.messages)).toContain(json(`- root: ${worktree}`));
  expect(JSON.stringify(f.payloads[2]?.messages)).toContain(json(`- root: ${await realpath(f.project)}`));
  expect(JSON.stringify(f.payloads[2]?.messages)).not.toContain(json(worktree!));
  expect(git("status", "--porcelain")).toBe("");
  expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
}, 90_000);

test("review regression: truncated tool loops still obey the model-turn ceiling", async () => {
  let requests = 0;
  const f = await fixture(() => ++requests > 5 ? answer("escape otherwise unbounded loop") : calls([{ name: "read", args: { path: "fixture.txt" } }], "length"));
  const result = await f.run([adapter, f.project, "length"]);
  expect(result.exit).toBe(0);
  expect(requests).toBe(2);
});

test("review regression: cancelling during auth preflight cannot start a later request", async () => {
  const f = await fixture(() => answer("must not be requested"));
  const result = await f.run([adapter, f.project, "preflight-cancel"]);
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout.split("READONLY_RESULT=")[1]!).cancelled).toBe(true);
  expect(f.payloads).toHaveLength(0);
});

test("parent cancellation during auth preflight prevents a late request and leaves the session usable", async () => {
  const f = await fixture(() => answer("AFTER_CANCEL_OK"));
  const result = await f.run([path.join(import.meta.dir, "fixtures/pi-interactive-cancel.ts")]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain("CANCELLED=true");
  expect(f.payloads).toHaveLength(1);
  expect(JSON.stringify(f.payloads[0])).toContain("AFTER_CANCEL_SESSION_STILL_USABLE");
}, 60_000);

test("real Pi caller cancellation stops a streaming child", async () => {
  const f = await fixture(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(stream({ role: "assistant", content: "partial" }, null)));
  } }), { headers: { "content-type": "text/event-stream" } }));
  const result = await f.run([adapter, f.project, "cancel"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const report: { events: RuntimeEvent[] } = JSON.parse(result.stdout.split("READONLY_RESULT=")[1]!);
  expect(report.events).toContainEqual(expect.objectContaining({ type: "assistant_response_end", stopReason: "aborted" }));
  expect(f.payloads).toHaveLength(1);
}, 30_000);


test("a read-only child retries a transient 429 under Pi's default policy and the child completes", async () => {
  let requests = 0;
  const f = await fixture(() => ++requests === 1 ? throttled() : answer("RETRIED_EVIDENCE: fixture.txt:1"));
  const result = await f.run([adapter, f.project, "retry"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const report: { events: RuntimeEvent[]; retry?: Record<string, unknown> } = JSON.parse(result.stdout.split("READONLY_RESULT=")[1]!);
  expect(report.retry).toMatchObject({ enabled: true, maxRetries: 3, baseDelayMs: 2000 });
  expect(f.payloads).toHaveLength(2);
  expect(report.events.filter((event) => event.type === "assistant_response_end").map((event) => event.stopReason)).toEqual(["error", "stop"]);
  expect(report.events.some((event) => event.type === "error")).toBe(false);
}, 30_000);

test("cancelling a read-only child during retry backoff stops it without another request", async () => {
  const f = await fixture(() => throttled());
  const started = Date.now();
  const result = await f.run([adapter, f.project, "retry-cancel"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const report: { events: RuntimeEvent[]; cancelled: boolean; retry?: Record<string, unknown> } = JSON.parse(result.stdout.split("READONLY_RESULT=")[1]!);
  expect(report.cancelled).toBe(true);
  expect(report.retry).toMatchObject({ enabled: true });
  expect(f.payloads).toHaveLength(1);
  // The backoff is 60 s: finishing well inside it means the abort ended the sleep.
  expect(Date.now() - started).toBeLessThan(30_000);
}, 30_000);

test("the main session honors a settings.json retry budget: it recovers within it and fails one 429 past it", async () => {
  let throttles = 2;
  const f = await fixture(() => throttles-- > 0 ? throttled() : answer("MAIN_RECOVERED"));
  const routing = { defaultProvider: "fixture", defaultModel: "fixture" };
  await writeFile(path.join(f.agent, "settings.json"), JSON.stringify({ ...routing, retry: { maxRetries: 2, baseDelayMs: 1 } }));
  const recovered = await f.run([cli, "Answer without tools"]);
  expect({ exit: recovered.exit, stderr: recovered.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(recovered.stdout).toContain("MAIN_RECOVERED");
  expect(f.payloads).toHaveLength(3);
  // maxRetries + 1 throttles: one first attempt and two retries, then the run fails.
  throttles = 3;
  const exhausted = await f.run([cli, "Answer without tools"]);
  expect(exhausted.exit).not.toBe(0);
  expect(exhausted.stdout + exhausted.stderr).toContain("rate-limited upstream");
  expect(f.payloads).toHaveLength(6);
}, 60_000);

test("a provider retry says so as it happens, and the error line waits until the retries run out", async () => {
  let throttles = 1;
  const f = await fixture(() => throttles-- > 0 ? throttled() : answer("MAIN_RECOVERED"));
  const routing = { defaultProvider: "fixture", defaultModel: "fixture" };
  await writeFile(path.join(f.agent, "settings.json"), JSON.stringify({ ...routing, retry: { maxRetries: 1, baseDelayMs: 1 } }));
  const recovered = await f.run([cli, "Answer without tools"]);
  expect(recovered.exit).toBe(0);
  expect(recovered.stdout).toContain("Can't reach fixture · trying again in 1s (1 of 1)");
  expect(recovered.stdout).not.toContain("[error]");
  expect(recovered.stdout).toContain("MAIN_RECOVERED");
  throttles = 2;
  const exhausted = await f.run([cli, "Answer without tools"]);
  expect(exhausted.exit).not.toBe(0);
  expect(exhausted.stdout).toContain("trying again");
  expect(exhausted.stdout.indexOf("[error]")).toBeGreaterThan(exhausted.stdout.indexOf("trying again"));
}, 60_000);

test("real CLI delegation reports a child that recovered from a 429 as completed", async () => {
  // Pi's real 2 s first backoff: the CLI offers no retry override for children, by design.
  let requests = 0;
  const f = await fixture(() => ++requests === 1 ? throttled() : answer("RECOVERED_EVIDENCE: fixture.txt:1"));
  const result = await f.run([cli, "/delegate", "reviewer", "Inspect fixture.txt"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain("reviewer · completed");
  expect(result.stdout).toContain("RECOVERED_EVIDENCE");
  expect(f.payloads).toHaveLength(2);
}, 60_000);

test("real CLI delegation fails rather than calling a provider error a successful report", async () => {
  const f = await fixture(() => new Response(JSON.stringify({ error: { message: "fixture model failure" } }), { status: 400 }));
  const result = await f.run([cli, "/delegate", "reviewer", "Inspect fixture.txt"]);
  expect(result.exit).toBe(1);
  expect(result.stdout).toContain("reviewer · failed");
  expect(result.stderr).toContain("Delegation failed");
  expect(f.payloads).toHaveLength(1);
}, 30_000);

test("a real child sees Pi's continuation notice for a large read, the real error for a directory, and recovers from a cut-off call", async () => {
  // The observed reviewer run: three reads of a large file, one lost to the output-token limit,
  // came back "limited" with a bare "tool failed: read" although the child went on to report.
  let step = 0;
  const f = await fixture((payload) => {
    if (payload.tools.length !== 4) return answer("PARENT_UNUSED");
    switch (step++) {
      case 0: return calls([{ name: "read", args: { path: "big.ts" } }, { name: "read", args: { path: "src" } }]);
      case 1: return calls([{ name: "read", args: { path: "big.ts", offset: 1276 } }], "length");
      case 2: return calls([{ name: "read", args: { path: "big.ts", offset: 1276 } }]);
      default: return answer("FINDINGS: big.ts:3400 ends the file");
    }
  });
  await writeFile(path.join(f.project, "big.ts"), Array.from({ length: 3400 }, (_, i) => `const line${i} = "${"x".repeat(20)}";`).join("\n"));
  await mkdir(path.join(f.project, "src"));
  const result = await f.run([cli, "/delegate", "reviewer", "Review big.ts"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain("reviewer · completed");
  expect(result.stdout).toContain("FINDINGS: big.ts:3400");
  // The truncated read is a result, not an error; the directory and cut-off call are errors with Pi's words.
  expect(result.stdout.match(/\[delegate\] read: .*/g)).toEqual([
    "[delegate] read: EISDIR: illegal operation on a directory, read",
    '[delegate] read: Tool call "read" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.',
  ]);
  expect(JSON.stringify(f.payloads[1]?.messages)).toContain("[Showing lines 1-1275 of 3400 (50.0KB limit). Use offset=1276 to continue.]");
  expect(f.payloads).toHaveLength(4);
}, 30_000);
