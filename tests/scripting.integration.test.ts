import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

interface Payload { model: string; messages: Array<{ role: string; content: unknown }>; reasoning_effort?: string }
type Step = { text: string } | { tools: Array<{ name: string; args: unknown }> };

function chunk(delta: unknown, finishReason: string | null, usage?: unknown): string {
  return `data: ${JSON.stringify({ id: "scripting", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`;
}
/** Every response reports 100 prompt and 20 completion tokens. */
const USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
function respond(step: Step): Response {
  const body = "text" in step
    ? chunk({ role: "assistant", content: step.text }, "stop", USAGE)
    : chunk({ role: "assistant", tool_calls: step.tools.map((tool, index) => ({ index, id: `call_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) }, null) + chunk({}, "tool_calls", USAGE);
  return new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

/** An isolated home whose Casper default is fixture/first, served by a scripted loopback provider. */
async function fixture(script: (request: number, payload: Payload) => Step = () => ({ text: "LOCAL_RESPONSE" })) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-scripting-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  const payloads: Payload[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const payload = await request.json() as Payload;
    payloads.push(payload);
    return respond(script(payloads.length - 1, payload));
  } });
  cleanup.push(async () => { server.stop(true); });
  const agent = path.join(home, ".casper/agent");
  await mkdir(agent, { recursive: true });
  const baseUrl = `http://127.0.0.1:${server.port}/v1`;
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: {
    fixture: { baseUrl, api: "openai-completions", apiKey: "synthetic", models: [
      // $1 per million input and $2 per million output tokens: $0.00014 per scripted response.
      { id: "first", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }, { id: "second", reasoning: true },
      // Like GLM: no minimal or medium, but max.
      { id: "sparse", reasoning: true, thinkingLevelMap: { minimal: null, medium: null, max: "max" } }] },
    missing: { baseUrl, api: "openai-completions", models: [{ id: "no-auth" }] },
  } }));
  const settings = path.join(home, ".casper/settings.json");
  await writeFile(settings, JSON.stringify({ defaultProvider: "fixture", defaultModel: "first", retry: { enabled: false } }));
  const env = { ...isolatedEnvironment(home), CASPER_OFFLINE: "1" };
  async function run(args: string[], cwd = project) {
    const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, exit };
    } finally { clearTimeout(timer); }
  }
  return { root, home, project, settings, payloads, run };
}

test("--model and --effort choose this run's model and effort without touching the saved default", async () => {
  const f = await fixture();
  const before = await readFile(f.settings, "utf8");
  const result = await f.run(["--model", "fixture/second", "--effort", "low", "Answer without tools"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain("LOCAL_RESPONSE");
  expect(f.payloads.map((payload) => [payload.model, payload.reasoning_effort])).toEqual([["second", "low"]]);
  const suffix = await f.run(["--model", "fixture/second:minimal", "Answer without tools"]);
  expect(suffix.exit).toBe(0);
  expect(f.payloads[1]).toMatchObject({ model: "second", reasoning_effort: "minimal" });
  // Neither the default model nor a remembered effort was written.
  expect(await readFile(f.settings, "utf8")).toBe(before);
  const plain = await f.run(["Answer without tools"]);
  expect(plain.exit).toBe(0);
  expect(f.payloads[2]!.model).toBe("first");
}, 60_000);

test("every --effort level runs on every model, mapped to the nearest level it supports", async () => {
  const f = await fixture();
  const sparse = await f.run(["--model", "fixture/sparse", "--effort", "medium", "Answer without tools"]);
  expect(sparse.exit).toBe(0);
  const plain = await f.run(["--model", "fixture/first", "--effort", "high", "Answer without tools"]);
  expect(plain.exit).toBe(0);
  const suffix = await f.run(["--model", "fixture/sparse:xhigh", "Answer without tools"]);
  expect(suffix.exit).toBe(0);
  // medium runs as high, a model without reasoning runs without it, xhigh runs as max.
  expect(f.payloads.map((payload) => [payload.model, payload.reasoning_effort])).toEqual([["sparse", "high"], ["first", undefined], ["sparse", "max"]]);
}, 60_000);

test("an unknown --model or effort word is a usage error before any model request", async () => {
  const f = await fixture();
  for (const [args, message] of [
    [["--model", "fixture/nope", "hi"], "Unknown model"],
    [["--effort", "loud", "hi"], "--effort must be one of"],
    [["--model", "fixture/second:high", "--effort", "low", "hi"], "either in --model"],
    [["--model"], "--model needs a value"],
  ] as const) {
    const result = await f.run([...args]);
    expect({ args, exit: result.exit, stdout: result.stdout.includes("> hi") ? "prompt shown" : "" }).toMatchObject({ args, exit: 64 });
    expect(result.stderr).toContain(message);
  }
  expect(f.payloads).toEqual([]);
}, 60_000);

test("a --model whose provider has no credentials fails (exit 1) with the sign-in hint", async () => {
  const f = await fixture();
  const result = await f.run(["--model", "missing/no-auth", "hi"]);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("Credentials missing for missing");
  expect(f.payloads).toEqual([]);
}, 30_000);

test("--cd opens the given folder as the workspace; a missing folder is a usage error", async () => {
  const f = await fixture();
  await writeFile(path.join(f.project, "package.json"), JSON.stringify({ name: "cd-target", scripts: { test: "true" } }));
  const opened = await f.run(["--cd", f.project, "/project"], f.root);
  expect({ exit: opened.exit, stderr: opened.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(opened.stdout).toContain(" project   project\n");
  expect(opened.stdout).toContain(" test      npm run test\n");
  for (const target of [path.join(f.root, "missing"), path.join(f.project, "package.json")]) {
    const result = await f.run(["--cd", target, "hi"], f.root);
    expect({ target, exit: result.exit, stdout: result.stdout }).toEqual({ target, exit: 64, stdout: "" });
    expect(result.stderr).toContain("--cd: not a folder");
  }
  expect(f.payloads).toEqual([]);
}, 30_000);

/** Saved conversation IDs, newest first, from the local /resume listing (no model call). */
async function savedConversations(f: Awaited<ReturnType<typeof fixture>>): Promise<string[]> {
  const listing = await f.run(["/resume"]);
  expect(listing.exit).toBe(0);
  return listing.stdout.split("\n").map((line) => /^([0-9a-f-]{8,})\s/.exec(line)?.[1]).filter((id): id is string => Boolean(id));
}
const userText = (payload: Payload) => JSON.stringify(payload.messages.filter((message) => message.role === "user"));

test("--json --continue reports the conversation it continued: the same session id", async () => {
  const f = await fixture();
  const first = await f.run(["--json", "remember ALPHA"]);
  const second = await f.run(["--json", "--continue", "which word?"]);
  const session = (stdout: string) => JSON.parse(stdout.split("\n")[0]!).session;
  expect({ first: first.exit, second: second.exit }).toEqual({ first: 0, second: 0 });
  expect(session(second.stdout)).toBe(session(first.stdout));
  expect(userText(f.payloads.at(-1)!)).toContain("remember ALPHA");
}, 30_000);

test("--continue picks up the latest conversation and --resume the one whose ID starts with a prefix", async () => {
  const f = await fixture();
  const fresh = await f.run(["--continue", "remember ALPHA"]);
  expect({ exit: fresh.exit, stderr: fresh.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(fresh.stdout).toContain("[session] No earlier conversation in this workspace; starting a new one.");
  await Bun.sleep(20);
  expect((await f.run(["remember BRAVO"])).exit).toBe(0);
  const [bravo, alpha] = await savedConversations(f);
  expect(alpha && bravo && alpha !== bravo).toBeTruthy();

  const continued = await f.run(["--continue", "which word?"]);
  expect({ exit: continued.exit, stderr: continued.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(continued.stdout).toContain(`[session] Continuing conversation ${bravo}.`);
  expect(userText(f.payloads.at(-1)!)).toContain("remember BRAVO");
  expect(userText(f.payloads.at(-1)!)).not.toContain("remember ALPHA");

  const resumed = await f.run(["--resume", alpha!.slice(0, 12), "which word?"]);
  expect({ exit: resumed.exit, stderr: resumed.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(userText(f.payloads.at(-1)!)).toContain("remember ALPHA");
  expect(userText(f.payloads.at(-1)!)).not.toContain("remember BRAVO");

  // One-shot flags change nothing for later runs: a plain prompt still starts a new conversation.
  expect((await f.run(["a fresh question"])).exit).toBe(0);
  expect(userText(f.payloads.at(-1)!)).not.toMatch(/remember (ALPHA|BRAVO)/);
  // Continuing left no empty conversations behind: ALPHA, BRAVO and the fresh question.
  const all = await savedConversations(f);
  expect(all).toHaveLength(3);

  const requests = f.payloads.length;
  let shared = 0;
  while (alpha![shared] === bravo![shared]) shared++;
  if (shared) {
    const ambiguous = await f.run(["--resume", alpha!.slice(0, shared), "hi"]);
    expect({ exit: ambiguous.exit, stderr: ambiguous.stderr }).toMatchObject({ exit: 64 });
    const matching = all.filter((id) => id.startsWith(alpha!.slice(0, shared))).length;
    expect(ambiguous.stderr).toContain(`matches ${matching} conversations; give more of the ID`);
  }
  for (const [args, message] of [
    [["--resume", "ffffffffffff", "hi"], "no saved conversation in this workspace starts with"],
    [["--continue", "--resume", alpha!, "hi"], "--continue and --resume cannot be combined"],
    [["--resume", "not a prefix!", "hi"], "--resume needs the start of a conversation ID"],
  ] as const) {
    const result = await f.run([...args]);
    expect({ args, exit: result.exit }).toEqual({ args, exit: 64 });
    expect(result.stderr).toContain(message);
  }
  expect(f.payloads.length).toBe(requests);
}, 90_000);

test("--max-turns stops a model that keeps working, runs no checks and exits 2", async () => {
  const f = await fixture((request) => ({ tools: [{ name: "write", args: { path: `turn-${request}.txt`, content: "x\n" } }] }));
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), "verify:\n  test: \"true\"\n");
  const result = await f.run(["--max-turns", "2", "--verify", "keep writing files"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 2, stderr: "" });
  expect(f.payloads).toHaveLength(2);
  expect(result.stdout).toContain("✗ Stopped after 2 turns (--max-turns) — changes so far are kept; casper --continue to go on");
  expect(result.stdout).toContain("✓ Changed 2 files: turn-0.txt, turn-1.txt");
  expect(result.stdout).not.toContain("Casper checking");
}, 30_000);

/** Parse every stdout line as a v1 event and replace run-specific values with stable markers. */
function events(stdout: string, project: string) {
  const lines = stdout.split("\n").filter(Boolean);
  return lines.map((line) => {
    const event = JSON.parse(line);
    expect(event.v).toBe(1);
    for (const key of ["ms"]) if (key in event) event[key] = typeof event[key] === "number" ? "<ms>" : event[key];
    if (event.type === "session_start") {
      expect(event.session).toMatch(/^[0-9a-f-]{36}$/);
      Object.assign(event, { casper: "<version>", session: "<id>", cwd: event.cwd === project ? "<project>" : event.cwd });
    }
    if (event.type === "receipt") event.checks = event.checks.map((check: { ms: number }) => ({ ...check, ms: "<ms>" }));
    if (event.type === "phase") event.atMs = "<ms>";
    return event;
  });
}

async function fixProject(f: Awaited<ReturnType<typeof fixture>>, test = "grep -q fixed sum.js") {
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(test)}\n`);
  await writeFile(path.join(f.project, "sum.js"), "broken\n");
}

/** The text of the prompt being answered, and whether the model is answering a tool result. */
const lastUser = (payload: Payload | undefined) => JSON.stringify([...(payload?.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? "");
const afterTool = (payload: Payload) => payload.messages.at(-1)?.role === "tool";
const REVIEW = "Casper requirements review";
const PROOF_REPAIR = "also passes without it";

test("--json streams v1 JSON Lines on stdout: session, text, tools, Casper's check and one receipt", async () => {
  const f = await fixture((request, payload) => lastUser(payload).includes(REVIEW) ? { text: "Requirements:\n- [x] sum.js is fixed — the test check" }
    : request === 0 ? { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] }
    : { text: "Fixed \u001b[31msum.js\u202e." });
  await fixProject(f);
  const result = await f.run(["--json", "--verify", "--require-verification", "Fix sum.js"]);
  expect(result.exit).toBe(0);
  // The transcript and the plain receipt a person reads moved to stderr.
  expect(result.stderr).toContain("✓ Verified by Casper: test passed");
  expect(result.stdout).not.toMatch(/[\x1b\u202e]/);
  const receiptText = "✓ Changed 1 file: sum.js\n✓ Verified by Casper: test passed (grep -q fixed sum.js, ";
  const stream = events(result.stdout, await realpath(f.project));
  const receipt = stream.at(-1);
  expect(receipt.text).toStartWith(receiptText);
  receipt.text = "<receipt text>";
  // Three model responses (the task, its answer, the requirements review) at 120 tokens each; the
  // cost is the catalog estimate for those tokens.
  expect(receipt.usage.estimatedCost).toBeCloseTo(0.00042, 10);
  receipt.usage.estimatedCost = "<cost>";
  expect(stream).toEqual([
    { v: 1, type: "session_start", casper: "<version>", cwd: "<project>", session: "<id>", provider: "fixture", model: "first", effort: stream[0].effort },
    { v: 1, type: "phase", phase: "task", state: "start", atMs: "<ms>" },
    { v: 1, type: "tool_start", tool: "write", id: "call_0", target: "sum.js" },
    { v: 1, type: "tool_end", tool: "write", id: "call_0", ok: true, ms: "<ms>" },
    { v: 1, type: "assistant_delta", text: "Fixed \u001b[31msum.js\u202e." },
    { v: 1, type: "assistant_message", text: "Fixed \u001b[31msum.js\u202e." },
    { v: 1, type: "phase", phase: "task", state: "end", atMs: "<ms>" },
    { v: 1, type: "phase", phase: "checks", state: "start", atMs: "<ms>" },
    { v: 1, type: "check", name: "test", command: "grep -q fixed sum.js", status: "pass", exit: 0, ms: "<ms>", recordedBy: "casper", reused: false },
    { v: 1, type: "phase", phase: "checks", state: "end", atMs: "<ms>" },
    { v: 1, type: "phase", phase: "review", state: "start", atMs: "<ms>" },
    // The requirements review: the model's checklist, then no rerun because it changed nothing.
    { v: 1, type: "assistant_delta", text: "Requirements:\n- [x] sum.js is fixed — the test check" },
    { v: 1, type: "assistant_message", text: "Requirements:\n- [x] sum.js is fixed — the test check" },
    { v: 1, type: "phase", phase: "review", state: "end", atMs: "<ms>" },
    { v: 1, type: "phase", phase: "proof", state: "start", atMs: "<ms>" },
    { v: 1, type: "phase", phase: "proof", state: "end", atMs: "<ms>" },
    { v: 1, type: "receipt", outcome: "verified", exitCode: 0, execution: "completed", changed: ["sum.js"], changedDuringChecks: [],
      verificationMode: "auto", checks: [{ name: "test", command: "grep -q fixed sum.js", status: "pass", exit: 0, ms: "<ms>", fresh: true }],
      repairAttempts: 0, turnLimit: null, usage: { turns: 3, tokens: 360, estimatedCost: "<cost>" },
      // The check fails on sum.js as it was, so it proves the fix.
      proof: { status: "proven", check: "test", command: "grep -q fixed sum.js", testsChanged: false, without: { exitCode: 1, ended: "fail" } },
      review: { done: ["sum.js is fixed — the test check"], open: [] }, text: "<receipt text>" },
  ]);
}, 30_000);

test("--json exit codes match the receipt: failed 1, not verified 3, usage 64 with nothing on stdout", async () => {
  const failing = await fixture(() => ({ text: "sum.js looks broken." }));
  await fixProject(failing);
  await writeFile(path.join(failing.project, ".casper/project.yaml"), 'verify:\n  test: "grep -q fixed sum.js"\nrepair:\n  maxAttempts: 0\n');
  const noChange = await failing.run(["--json", "--require-verification", "Look at sum.js"]);
  const receipt = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1)!);
  // No files changed: nothing to verify, so even --require-verification exits 0.
  expect({ exit: noChange.exit, outcome: receipt(noChange.stdout).outcome }).toEqual({ exit: 0, outcome: "unchanged" });

  const broken = await fixture((request) => request === 0
    ? { tools: [{ name: "write", args: { path: "sum.js", content: "still broken\n" } }] } : { text: "Done." });
  await fixProject(broken);
  await writeFile(path.join(broken.project, ".casper/project.yaml"), 'verify:\n  test: "grep -q fixed sum.js"\nrepair:\n  maxAttempts: 0\n');
  const failed = await broken.run(["--json", "--verify", "Fix sum.js"]);
  expect({ exit: failed.exit, outcome: receipt(failed.stdout).outcome, exitCode: receipt(failed.stdout).exitCode }).toEqual({ exit: 1, outcome: "failed", exitCode: 1 });

  const unchecked = await fixture((request) => request === 0
    ? { tools: [{ name: "write", args: { path: "notes.txt", content: "x\n" } }] } : { text: "Done." });
  const notVerified = await unchecked.run(["--json", "--require-verification", "Write notes"]);
  expect({ exit: notVerified.exit, outcome: receipt(notVerified.stdout).outcome }).toEqual({ exit: 3, outcome: "not_verified" });

  const usage = await unchecked.run(["--json"]);
  expect({ exit: usage.exit, stdout: usage.stdout }).toEqual({ exit: 64, stdout: "" });
  expect(usage.stderr).toContain("--json needs a prompt");
}, 60_000);

/** A project whose test passes on the unfixed code too: it cannot prove a fix to sum.js. */
async function weaklyTestedProject(f: Awaited<ReturnType<typeof fixture>>) {
  await mkdir(path.join(f.project, ".casper"));
  await mkdir(path.join(f.project, "tests"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), 'verify:\n  test: "sh tests/check.sh"\n');
  await writeFile(path.join(f.project, "tests/check.sh"), "test -f sum.js\n");
  await writeFile(path.join(f.project, "sum.js"), "broken\n");
}
const asked = (payload: Payload | undefined, text: string) => JSON.stringify(payload?.messages ?? []).includes(text);
const TICKED = { text: "Requirements:\n- [x] sum.js is fixed — tests/check.sh" };

test("an unproven fix gets one round to add a test that fails without it; then the receipt says proven", async () => {
  const f = await fixture((_request, payload) => {
    const prompt = lastUser(payload);
    if (prompt.includes(PROOF_REPAIR)) return afterTool(payload) ? { text: "Added a test that fails on the broken code." }
      : { tools: [{ name: "write", args: { path: "tests/check.sh", content: "grep -q fixed sum.js\n" } }] };
    if (prompt.includes(REVIEW)) return TICKED;
    return afterTool(payload) ? { text: "Fixed sum.js." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] };
  });
  await weaklyTestedProject(f);
  const result = await f.run(["--json", "--verify", "--require-verification", "Fix sum.js"]);
  // The first turn is the request itself; the review comes before the proof, and the proof round asks for the test.
  expect(asked(f.payloads[0], "fail without your change")).toBe(false);
  expect(lastUser(f.payloads[0]!)).toContain("Fix sum.js");
  expect(f.payloads.map((payload) => lastUser(payload).includes(REVIEW) ? "review" : lastUser(payload).includes(PROOF_REPAIR) ? "proof" : "task"))
    .toEqual(["task", "task", "review", "proof", "proof"]);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ exit: result.exit, outcome: receipt.outcome, repairs: receipt.repairAttempts, proof: receipt.proof, review: receipt.review }).toEqual({
    exit: 0, outcome: "verified", repairs: 1, proof: { status: "proven", check: "test", command: "sh tests/check.sh", testsChanged: true, without: { exitCode: 1, ended: "fail" } },
    review: { done: ["sum.js is fixed — tests/check.sh"], open: [] },
  });
  expect(result.stderr).toContain("✓ Proven: test fails without this change (exit 1) and passes with it");
}, 60_000);

test("a fix no test proves is not verified: the receipt says why, and --require-verification exits 3", async () => {
  const f = await fixture((_request, payload) => lastUser(payload).includes(REVIEW) ? TICKED
    : afterTool(payload) || lastUser(payload).includes(PROOF_REPAIR) ? { text: "Fixed sum.js." }
    : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] });
  await weaklyTestedProject(f);
  const result = await f.run(["--json", "--verify", "--require-verification", "Fix sum.js"]);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ exit: result.exit, outcome: receipt.outcome, proof: receipt.proof?.status, testsChanged: receipt.proof?.testsChanged })
    .toEqual({ exit: 3, outcome: "not_verified", proof: "unproven", testsChanged: false });
  expect(receipt.text).toContain("⚠ Not proven: test passes without this change too, and no test was added or changed");
  // Exactly one proof round was asked for; the model's answer did not add a test.
  expect(f.payloads.filter((payload) => lastUser(payload).includes(PROOF_REPAIR)).length).toBe(1);
}, 60_000);

test("a feature worded like a test task is still reviewed and proven; a docs-only edit is not", async () => {
  // "new test files" makes the keyword classifier say intent "test"; the work (a code change) decides.
  const f = await fixture((_request, payload) => lastUser(payload).includes(REVIEW) ? TICKED
    : afterTool(payload) ? { text: "Done." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] });
  await fixProject(f);
  const result = await f.run(["--json", "--verify", "sum.js should print fixed; you may add new test files"]);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ proof: receipt.proof?.status, review: receipt.review }).toEqual({ proof: "proven", review: { done: ["sum.js is fixed — tests/check.sh"], open: [] } });

  const docs = await fixture((_request, payload) => afterTool(payload) ? { text: "Documented." } : { tools: [{ name: "write", args: { path: "NOTES.md", content: "notes\n" } }] });
  await fixProject(docs);
  await writeFile(path.join(docs.project, ".casper/project.yaml"), 'verify:\n  test: "test -f sum.js"\n');
  const documented = await docs.run(["--json", "--verify", "Add notes about sum.js"]);
  const docsReceipt = JSON.parse(documented.stdout.trim().split("\n").at(-1)!);
  expect({ outcome: docsReceipt.outcome, proof: docsReceipt.proof, review: docsReceipt.review }).toEqual({ outcome: "verified", proof: null, review: null });
  expect(docs.payloads.some((payload) => lastUser(payload).includes(REVIEW))).toBe(false);
}, 90_000);

test("the review round runs even after a fully ticked first checklist, and the receipt keeps the review's", async () => {
  const f = await fixture((_request, payload) => lastUser(payload).includes(REVIEW) ? TICKED
    : afterTool(payload) ? { text: "Fixed sum.js.\n\nRequirements:\n- [x] sum.js prints fixed — tests/sum.sh" }
    : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }, { name: "write", args: { path: "tests/sum.sh", content: "grep -q fixed sum.js\n" } }] });
  await fixProject(f);
  const result = await f.run(["--json", "--verify", "Fix sum.js"]);
  // B: the first turn is the request itself; the review asks for the checklist, with the ticking rule.
  expect(asked(f.payloads[0], "Tick a requirement only when a test you can name asserts it")).toBe(false);
  // A fully ticked first checklist was wrong too often to skip the review; the review starts from it.
  const reviews = f.payloads.filter((payload) => lastUser(payload).includes(REVIEW));
  expect(reviews.length).toBeGreaterThan(0);
  expect(lastUser(reviews[0]!)).toContain("start from it: add what it missed and split what it merged");
  expect(lastUser(reviews[0]!)).toContain("Covered: <n> of <m> requirements.");
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ outcome: receipt.outcome, review: receipt.review, proof: receipt.proof?.status })
    .toEqual({ outcome: "verified", review: { done: ["sum.js is fixed — tests/check.sh"], open: [] }, proof: "proven" });
}, 60_000);

test("verification.review: false skips the review round; the change is still proven", async () => {
  const f = await fixture((_request, payload) => lastUser(payload).includes(REVIEW) ? TICKED
    : afterTool(payload) ? { text: "Fixed." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] });
  await fixProject(f);
  await writeFile(path.join(f.project, ".casper/project.yaml"), 'verify:\n  test: "grep -q fixed sum.js"\nverification:\n  review: false\n');
  const result = await f.run(["--json", "--verify", "Fix sum.js"]);
  expect(f.payloads.some((payload) => lastUser(payload).includes(REVIEW))).toBe(false);
  // No review follows, so the first turn itself asks for the checklist and a test that fails without the change.
  expect(asked(f.payloads[0], "Tick a requirement only when a test you can name asserts it")).toBe(true);
  expect(asked(f.payloads[0], "fail without your change")).toBe(true);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ outcome: receipt.outcome, proof: receipt.proof?.status, review: receipt.review }).toEqual({ outcome: "verified", proof: "proven", review: null });

  // The benchmark's casper-no-review sets it in the user configuration (~/.casper/config.yaml).
  const user = await fixture((_request, payload) => lastUser(payload).includes(REVIEW) ? TICKED
    : afterTool(payload) ? { text: "Fixed." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] });
  await fixProject(user);
  await mkdir(path.join(user.home, ".casper"), { recursive: true });
  await writeFile(path.join(user.home, ".casper/config.yaml"), "verification:\n  review: false\n");
  expect((await user.run(["--json", "--verify", "Fix sum.js"])).exit).toBe(0);
  expect(user.payloads.some((payload) => lastUser(payload).includes(REVIEW))).toBe(false);
}, 60_000);

test("the review round fixes a gap the model finds; a gap it admits keeps the change unverified", async () => {
  // The review finds that sum.js also needs a newline marker and fixes it; the checks rerun and pass.
  const fixed = await fixture((_request, payload) => {
    const prompt = lastUser(payload);
    // The delta answer: only the gap it fixed, and the count.
    if (prompt.includes(REVIEW)) return afterTool(payload) ? { text: "Requirements review:\n- [x] marker — test\nCovered: 2 of 2 requirements." }
      : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed marker\n" } }] };
    return afterTool(payload) ? { text: "Fixed." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] };
  });
  await fixProject(fixed);
  const reviewed = await fixed.run(["--json", "--verify", "Fix sum.js"]);
  const receipt = JSON.parse(reviewed.stdout.trim().split("\n").at(-1)!);
  expect({ exit: reviewed.exit, outcome: receipt.outcome, review: receipt.review, proof: receipt.proof?.status })
    .toEqual({ exit: 0, outcome: "verified", review: { done: ["marker — test"], open: [], total: 2 }, proof: "proven" });
  expect(receipt.text).toContain("• The model's review: all 2 requirements covered (1 gap fixed; its own claim, not checked by Casper)");
  expect(await readFile(path.join(fixed.project, "sum.js"), "utf8")).toBe("fixed marker\n");

  const admitted = await fixture((_request, payload) => lastUser(payload).includes(REVIEW)
    ? { text: "Requirements:\n- [x] sum.js is fixed — test\n- [ ] negative numbers — not implemented" }
    : afterTool(payload) ? { text: "Fixed." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] });
  await fixProject(admitted);
  const gap = await admitted.run(["--json", "--verify", "--require-verification", "Fix sum.js"]);
  const gapReceipt = JSON.parse(gap.stdout.trim().split("\n").at(-1)!);
  expect({ exit: gap.exit, outcome: gapReceipt.outcome }).toEqual({ exit: 3, outcome: "not_verified" });
  expect(gapReceipt.text).toContain("⚠ The model's review says not done: negative numbers — not implemented");
}, 90_000);

/** A model that fixes sum.js, then keeps editing through the whole review without ever ending it. */
const endlessReview = (_request: number, payload: Payload): Step => {
  if (lastUser(payload).includes(REVIEW)) return { tools: [{ name: "write", args: { path: `review-${payload.messages.length}.txt`, content: "x\n" } }] };
  return afterTool(payload) ? { text: "Fixed." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] };
};

test("the review stops at its own 12-turn budget; Casper still reruns the checks and proves the change", async () => {
  const f = await fixture(endlessReview);
  await fixProject(f);
  const result = await f.run(["--json", "--verify", "--require-verification", "Fix sum.js"]);
  expect(f.payloads.filter((payload) => lastUser(payload).includes(REVIEW)).length).toBe(12);
  const stream = events(result.stdout, "");
  const receipt = stream.at(-1);
  // The review edited files, so the checks ran again; then the proof. Not the task's own --max-turns stop.
  expect(stream.filter((event) => event.type === "check").length).toBe(2);
  expect({ exit: result.exit, outcome: receipt.outcome, turnLimit: receipt.turnLimit, proof: receipt.proof?.status, review: receipt.review })
    .toEqual({ exit: 0, outcome: "verified", turnLimit: null, proof: "proven", review: { missing: true, incomplete: true } });
  expect(receipt.text).toContain("• The model's review stopped at its 12-turn budget (its own claim so far, not checked by Casper)");
  expect(receipt.text).not.toContain("--max-turns");
}, 60_000);

test("a --max-turns below the review's budget still stops the task in the review: no proof, exit 2", async () => {
  const f = await fixture(endlessReview);
  await fixProject(f);
  const result = await f.run(["--json", "--verify", "--max-turns", "3", "Fix sum.js"]);
  expect(f.payloads.filter((payload) => lastUser(payload).includes(REVIEW)).length).toBe(3);
  const receipt = events(result.stdout, "").at(-1);
  expect({ exit: result.exit, outcome: receipt.outcome, turnLimit: receipt.turnLimit, proof: receipt.proof, review: receipt.review })
    .toEqual({ exit: 2, outcome: "incomplete", turnLimit: 3, proof: null, review: null });
  expect(receipt.text).toContain("✗ Stopped after 3 turns (--max-turns)");
}, 60_000);

test("the proof repair round has the same 12-turn budget; the proof then decides", async () => {
  const f = await fixture((_request, payload) => {
    const prompt = lastUser(payload);
    if (prompt.includes(PROOF_REPAIR)) return { tools: [{ name: "write", args: { path: `proof-${payload.messages.length}.txt`, content: "x\n" } }] };
    if (prompt.includes(REVIEW)) return TICKED;
    return afterTool(payload) ? { text: "Fixed sum.js." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] };
  });
  await weaklyTestedProject(f);
  const result = await f.run(["--json", "--verify", "--require-verification", "Fix sum.js"]);
  expect(f.payloads.filter((payload) => lastUser(payload).includes(PROOF_REPAIR)).length).toBe(12);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect({ exit: result.exit, outcome: receipt.outcome, turnLimit: receipt.turnLimit, proof: receipt.proof?.status })
    .toEqual({ exit: 3, outcome: "not_verified", turnLimit: null, proof: "unproven" });
}, 60_000);

test("--json ends with an error event when Casper stops before a receipt", async () => {
  const f = await fixture();
  const result = await f.run(["--json", "--model", "fixture/nope", "hi"]);
  expect(result.exit).toBe(64);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.map((line) => line.type)).toEqual(["error"]);
  expect(lines[0].message).toContain("Unknown model");
}, 30_000);

test("--json tells a check the model asked for (casper_check) from one Casper ran", async () => {
  const f = await fixture((request) => request === 0 ? { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] }
    : request === 1 ? { tools: [{ name: "casper_check", args: { check: "test" } }] } : { text: "Fixed." });
  await fixProject(f);
  const result = await f.run(["--json", "--verify", "Fix sum.js"]);
  expect(result.exit).toBe(0);
  const checks = events(result.stdout, "").filter((event) => event.type === "check");
  // Without a declared scope Casper cannot prove the model's pass is still fresh, so its final run repeats it.
  expect(checks.map((check) => [check.recordedBy, check.status, check.reused])).toEqual([["casper_check", "pass", false], ["casper", "pass", false]]);
}, 30_000);
