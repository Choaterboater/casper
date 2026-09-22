import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { posixOnly } from "./support/platform";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

interface Payload { messages: Array<{ role: string; content: unknown }> }
function stream(delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({ id: "gate", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}
function answer(text: string): Response {
  return new Response(stream({ role: "assistant", content: text }, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function calls(tools: Array<{ name: string; args: unknown }>): Response {
  const tool_calls = tools.map((tool, index) => ({ index, id: `call_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }));
  return new Response(stream({ role: "assistant", tool_calls }, null) + stream({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

/** beforeToolGate blocks the first native write with its reason; a recorded ask reopens it. */
posixOnly("the beforeChanges gate blocks a native write until the gate opens", async () => {
  let step = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-pi-gate-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); const project = path.join(root, "project"); const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(project);
  const payloads: Payload[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    payloads.push(await request.json());
    switch (step++) {
      case 0: return calls([{ name: "write", args: { path: "GATE_MARKER", content: "GATE_OPENED\n" } }]);
      case 1: return calls([{ name: "write", args: { path: "GATE_MARKER", content: "GATE_OPENED\n" } }]);
      default: return answer("done");
    }
  } });
  cleanup.push(async () => { server.stop(true); });
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture" }],
  } } }));
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false } }));
  // Parent sessions use Casper-owned routing defaults, never shared Pi routing.
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }));
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/pi-gate.ts"), project], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const result = JSON.parse(stdout.slice(stdout.indexOf("GATE_RESULT=") + "GATE_RESULT=".length).trim());
  const writes = result.toolEnds.filter((event: { toolName: string }) => event.toolName === "write");
  expect(writes).toHaveLength(2);
  expect(writes[0].isError).toBe(true);
  expect(writes[0].output?.text).toBe("ask before write");
  expect(writes[1].isError).toBe(false);
  expect(result.gateConsults).toBe(2);
  expect(JSON.stringify(payloads[1]?.messages)).toContain("ask before write");
  expect(await readFile(path.join(project, "GATE_MARKER"), "utf8")).toBe("GATE_OPENED\n");
}, 20_000);
