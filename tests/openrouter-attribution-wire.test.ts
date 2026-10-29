import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const adapter = path.resolve(import.meta.dir, "../src/runtime/pi.ts");
const attribution = path.resolve(import.meta.dir, "../src/runtime/openrouter-attribution.ts");
const NAMES = ["http-referer", "x-openrouter-title", "x-openrouter-categories", "x-openrouter-app-visibility"];

/** The headers a real Pi runtime puts on the wire to OpenRouter (a local fake), with telemetry turned off after the
 * session started (as `telemetry: off` in your config is read) or left on. The engine adds its own attribution below
 * the request headers, so Casper's hook can't see it; it must still be taken out. */
async function sentAttribution(off: boolean): Promise<Record<string, string>> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-or-wire-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"), project = path.join(root, "project"), agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(path.join(home, ".casper")); await mkdir(project);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  await writeFile(path.join(agent, "auth.json"), "{}\n");
  const seen: Array<Record<string, string>> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const headers: Record<string, string> = {};
    for (const name of NAMES) { const value = req.headers.get(name); if (value !== null) headers[name] = value; }
    seen.push(headers);
    const body = await req.json() as { model: string };
    return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(async () => { server.stop(true); });
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: {
    openrouter: { baseUrl: `http://127.0.0.1:${server.port}/api/v1`, api: "openai-completions", apiKey: "fixture-not-a-secret",
      models: [{ id: "wire-fixture", reasoning: false }] },
  } }));
  const env: Record<string, string> = { ...isolatedEnvironment(home), CASPER_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1" };
  delete env.CASPER_TELEMETRY; delete env.PI_TELEMETRY;
  const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(adapter)};
import { useTelemetrySetting } from ${JSON.stringify(attribution)};
const runtime = new PiRuntime();
try {
  const session = await runtime.start({ cwd: process.cwd(), localModels: false });
  await session.selectModel({ query: 'openrouter/wire-fixture', persist: false });
  ${off ? "useTelemetrySetting(() => false);" : ""}
  await session.prompt('hi');
} finally { await runtime.dispose(); }`], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  } finally { clearTimeout(timer); }
  expect(seen.length).toBeGreaterThan(0);
  return seen[0]!;
}

test("telemetry off: an OpenRouter request on the wire carries neither Casper's nor the engine's app name", async () => {
  expect(await sentAttribution(true)).toEqual({});
}, 90_000);

test("telemetry on: an OpenRouter request on the wire carries Casper's app name, not the engine's", async () => {
  expect(await sentAttribution(false)).toEqual({
    "http-referer": "https://choaterboater.github.io/casper/", "x-openrouter-title": "Casper",
    "x-openrouter-categories": "cli-agent", "x-openrouter-app-visibility": "hidden",
  });
}, 90_000);
