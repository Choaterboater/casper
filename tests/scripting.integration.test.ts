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
