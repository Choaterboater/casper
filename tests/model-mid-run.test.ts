import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const adapter = path.resolve(import.meta.dir, "../src/runtime/pi.ts");

/** A real Pi runtime against a local fake provider: the first answer is a tool call, held until the child says go; the
 * second request is the model's next step. */
test("during a run, /model and /effort apply from the model's next step on the real runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-mid-run-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(path.join(home, ".casper")); await mkdir(project);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  await writeFile(path.join(agent, "auth.json"), "{}\n");
  const requests: Array<{ model: string; reasoning_effort?: string }> = [];
  const { promise: go, resolve: release } = Promise.withResolvers<void>();
  const sse = (delta: Record<string, unknown>, finish: string, model: string) => new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/go") { release(); return new Response("ok"); }
    const body = await req.json();
    requests.push({ model: body.model, ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}) });
    if (requests.length === 1) {
      await go;
      return sse({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "ls", arguments: "{\"path\":\".\"}" } }] }, "tool_calls", body.model);
    }
    return sse({ role: "assistant", content: "done" }, "stop", body.model);
  } });
  cleanup.push(async () => { server.stop(true); });
  const base = `http://127.0.0.1:${server.port}`;
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: {
    fixture: { baseUrl: `${base}/v1`, api: "openai-completions", apiKey: "fixture-not-a-secret",
      models: [{ id: "first", reasoning: true }, { id: "second", reasoning: true }] },
  } }));
  const env = { ...isolatedEnvironment(home), CASPER_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(adapter)};
const runtime = new PiRuntime();
try {
  const session = await runtime.start({ cwd: process.cwd(), localModels: false });
  await session.selectModel({ query: 'fixture/first:low' });
  const running = session.prompt('list the files');
  while (!session.getState().isStreaming) await new Promise(resolve => setTimeout(resolve, 10));
  const model = await session.selectModel({ query: 'fixture/second', persist: false });
  const effort = await session.setEffort('high', false);
  await fetch(${JSON.stringify(`${base}/go`)});
  await running;
  console.log('RESULT=' + JSON.stringify({ selected: model.selected, effort: effort.thinkingLevel, status: session.getStatus() }));
} finally { await runtime.dispose(); }`], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(stdout.split("RESULT=")[1]!);
    expect(result).toMatchObject({ selected: true, effort: "high", status: { model: "second", thinkingLevel: "high" } });
    // The step already running kept its model and effort; the next step used the new ones.
    expect(requests).toEqual([{ model: "first", reasoning_effort: "low" }, { model: "second", reasoning_effort: "high" }]);
  } finally { clearTimeout(timer); }
}, 90_000);
