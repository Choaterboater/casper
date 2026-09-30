import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanEnv } from "./support/env";

/** The real source CLI and real Pi against a local model server that reports a priced, expensive turn. */
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function chunk(body: unknown): string { return `data: ${JSON.stringify(body)}\n\n`; }
/** One model turn: a bash call, with usage that costs about $5.40 at the fixture's price. */
function expensiveToolCall(command: string): Response {
  const base = { id: "spend", object: "chat.completion.chunk", created: 1, model: "fixture" };
  const tool_calls = [{ index: 0, id: "call_0", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }];
  return new Response(
    chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] })
    + chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
    + chunk({ ...base, choices: [], usage: { prompt_tokens: 540_000, completion_tokens: 100, total_tokens: 540_100 } })
    + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function answer(text: string): Response {
  const base = { id: "spend", object: "chat.completion.chunk", created: 1, model: "fixture" };
  return new Response(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }] }) + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-spend-real-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); const project = path.join(root, "project"); const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(project); await mkdir(path.join(home, ".casper"));
  await writeFile(path.join(project, "notes.txt"), "keep me\n");
  let requests = 0;
  const marker = path.join(project, "TOOL_RAN");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    await request.json();
    return requests++ === 0 ? expensiveToolCall(`touch ${marker}`) : answer("Stopped as asked.");
  } });
  cleanup.push(async () => { server.stop(true); });
  // $10 per million input tokens: 540k tokens is about $5.40, past the $5 pause.
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret",
    models: [{ id: "fixture", cost: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false } }));
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }));
  const env = cleanEnv({ HOME: home, CASPER_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", NO_COLOR: "1" });
  async function run(args: string[]) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/cli.ts"), ...args], { cwd: project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  }
  return { project, marker, run, requests: () => requests };
}

test("real one-shot: past $5 the next tool call never runs, the run stops without waiting, and the receipt says so", async () => {
  const f = await fixture();
  const result = await f.run(["tidy the notes"]);
  expect(await Bun.file(f.marker).exists()).toBe(false);
  expect(result.stdout).toContain("[spend] This task has used $5.40.");
  expect(result.stdout).toContain("• Incomplete — stopped at $5.40, the $5 limit for one task");
  // The stopped call reads as not run, not as a failure, and the model's instruction stays off the screen.
  expect(result.stdout).toMatch(/• bash · touch [^\n]*— not run \(spend limit\)/);
  expect(result.stdout).not.toContain("Do not call more tools");
  expect(result.stdout).not.toMatch(/✗ bash/);
  expect(result.exit).toBe(2);
  // The model got one reason back and Pi ended the turn: no further model request after the stop.
  expect(f.requests()).toBe(1);
  expect(await readFile(path.join(f.project, "notes.txt"), "utf8")).toBe("keep me\n");
}, 30_000);

test("real --json: the run stops at the limit without waiting, stdout stays JSON, and the receipt has spendLimit", async () => {
  const f = await fixture();
  const result = await f.run(["--json", "tidy the notes"]);
  expect(await Bun.file(f.marker).exists()).toBe(false);
  const events = result.stdout.trim().split("\n").map(line => JSON.parse(line) as { type: string; spendLimit?: unknown; exitCode?: number });
  const receipt = events.find(event => event.type === "receipt")!;
  expect(receipt.spendLimit).toEqual({ spent: expect.closeTo(5.4, 2), limit: 5 });
  expect(receipt.exitCode).toBe(2);
  expect(result.stderr).toContain("[spend] This task has used $5.40.");
  expect(result.exit).toBe(2);
}, 30_000);
