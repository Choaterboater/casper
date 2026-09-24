import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

interface Payload { model: string; messages: Array<{ role: string; content: unknown }>; reasoning_effort?: string }
type Step = { text: string } | { tools: Array<{ name: string; args: unknown }> };

function chunk(delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({ id: "scripting", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}
function respond(step: Step): Response {
  const body = "text" in step
    ? chunk({ role: "assistant", content: step.text }, "stop")
    : chunk({ role: "assistant", tool_calls: step.tools.map((tool, index) => ({ index, id: `call_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) }, null) + chunk({}, "tool_calls");
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
    fixture: { baseUrl, api: "openai-completions", apiKey: "synthetic", models: [{ id: "first" }, { id: "second", reasoning: true }] },
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

test("an unknown --model or unsupported --effort is a usage error before any model request", async () => {
  const f = await fixture();
  for (const [args, message] of [
    [["--model", "fixture/nope", "hi"], "Unknown model"],
    [["--model", "fixture/first", "--effort", "high", "hi"], "Unsupported effort"],
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

test("--continue picks up the latest conversation and --resume the one whose ID starts with a prefix", async () => {
  const f = await fixture();
  const fresh = await f.run(["--continue", "remember ALPHA"]);
  expect({ exit: fresh.exit, stderr: fresh.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(fresh.stdout).toContain("[session] No earlier conversation in this workspace; starting a new one.");
  await Bun.sleep(20);
  expect((await f.run(["remember BRAVO"])).exit).toBe(0);
  const [bravo, alpha] = await savedConversations(f);
  expect(alpha && bravo).toBeTruthy();

  const continued = await f.run(["--continue", "which word?"]);
  expect({ exit: continued.exit, stderr: continued.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(continued.stdout).toContain(`[session] Continuing conversation ${bravo}.`);
  expect(userText(f.payloads.at(-1)!)).toContain("remember BRAVO");
  expect(userText(f.payloads.at(-1)!)).not.toContain("remember ALPHA");

  const resumed = await f.run(["--resume", alpha!.slice(0, 12), "which word?"]);
  expect({ exit: resumed.exit, stderr: resumed.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(userText(f.payloads.at(-1)!)).toContain("remember ALPHA");
  expect(userText(f.payloads.at(-1)!)).not.toContain("remember BRAVO");

  const requests = f.payloads.length;
  let shared = 0;
  while (alpha![shared] === bravo![shared]) shared++;
  if (shared) {
    const ambiguous = await f.run(["--resume", alpha!.slice(0, shared), "hi"]);
    expect({ exit: ambiguous.exit, stderr: ambiguous.stderr }).toMatchObject({ exit: 64 });
    expect(ambiguous.stderr).toContain("matches 2 conversations; give more of the ID");
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
