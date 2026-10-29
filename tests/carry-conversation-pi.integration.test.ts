import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { removeTempDir } from "./support/temp-dir";

/** "Switch there" carries the conversation: a real PiRuntime forks it into the work's folder, and a new runtime there lists
 * it and continues it with its history. */
const roots: string[] = [];
const servers: Array<{ stop(force: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) await removeTempDir(root);
});
const repo = path.resolve(import.meta.dir, "..");
setDefaultTimeout(20_000);

function chunk(delta: unknown, finish: string | null): string {
  return `data: ${JSON.stringify({ id: "steer", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}
const sse = (body: string) => new Response(body + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const answer = (text: string) => sse(chunk({ role: "assistant", content: text }, "stop"));

/** Runs `body` against a real PiRuntime session in a child process, with a local fixture provider. `prelude` runs
 * before the session starts; `startOptions` are added to its start options. */
async function run(respond: (count: number) => Response, body: string, prelude = "", startOptions = "") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-steer-"))); roots.push(root);
  const home = path.join(root, "home"); const project = path.join(root, "project"); const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(path.join(project, "moldable"), { recursive: true }); await mkdir(path.join(home, ".casper"));
  const payloads: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  // Only the model's POSTs: in the full suite a stray GET / from another test once reached this port and failed the test.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    payloads.push(await request.json()); return respond(payloads.length);
  } });
  servers.push(server);
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture" }] } } }));
  const routing = { defaultProvider: "fixture", defaultModel: "fixture" };
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ ...routing, retry: { enabled: false } }));
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify(routing));
  const env = { ...isolatedEnvironment(home), TMPDIR: root, PI_CODING_AGENT_DIR: agent, CASPER_AGENT_DIR: agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    ${prelude}
    const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd(), localModels: false, ${startOptions} });
    try { ${body} } finally { await runtime.dispose(); }`], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return { result: JSON.parse(stdout) as Record<string, unknown>, payloads };
}

test("a conversation forked into the work's folder is listed there and continues with its history", async () => {
  const { result, payloads } = await run(count => answer(count === 1 ? "NOTED_OTTO_PLAN" : "DONE"), `
    await session.prompt("Remember the Otto plan");
    const there = require("node:path").join(process.cwd(), "moldable");
    const forked = await session.forkSession({ cwd: there, name: "otto", context: "Casper moved this conversation to " + there });
    await runtime.dispose();
    const { PiRuntime: Next } = await import(${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))});
    const next = new Next(); const moved = await next.start({ cwd: there, localModels: false });
    const listed = (await moved.listConversations()).map(item => item.id);
    await moved.resumeConversation(forked.sessionId, { keepUnwritten: false });
    await moved.prompt("Keep going");
    console.log(JSON.stringify({ forked: forked.sessionId, cwd: forked.cwd === there, listed, info: moved.getSessionInfo().sessionId }));
    await next.dispose();`);
  expect(result.cwd).toBe(true);
  expect(result.listed).toContain(result.forked);
  expect(result.info).toBe(result.forked);
  // The request in the new folder carries the earlier turns.
  expect(JSON.stringify(payloads.at(-1)!.messages)).toContain("NOTED_OTTO_PLAN");
  expect(JSON.stringify(payloads.at(-1)!.messages)).toContain("Remember the Otto plan");
}, 90_000);
