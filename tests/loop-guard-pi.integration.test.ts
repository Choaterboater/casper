import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REPEAT_NOTE } from "../src/runtime/loop-guard";
import { ELISION_NOTE } from "../src/runtime/elision";
import { posixOnly } from "./support/platform";
import { cleanEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

interface Payload { messages: Array<{ role: string; content: unknown }> }
function stream(delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({ id: "loop", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}
function answer(text: string): Response {
  return new Response(stream({ role: "assistant", content: text }, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function call(step: number, name: string, args: unknown): Response {
  const tool_calls = [{ index: 0, id: `call_${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }];
  return new Response(stream({ role: "assistant", tool_calls }, null) + stream({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function lastToolText(payload: Payload | undefined): string {
  const last = payload?.messages.at(-1);
  return typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
}

/** The same read with nothing changed: a note on the 3rd, skipped on the 5th, and a write starts the count again. */
posixOnly("a repeated read gets a note, then is skipped, until a write resets it; a write with a placeholder gets a note", async () => {
  let step = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-loop-guard-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"); const project = path.join(root, "project"); const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(project);
  await writeFile(path.join(project, "notes.txt"), "LOOP_NOTES_TEXT\n");
  const payloads: Payload[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    payloads.push(await request.json());
    const now = step++;
    if (now < 5 || now === 6) return call(now, "read", { path: "notes.txt" });
    if (now === 5) return call(now, "write", { path: "other.txt", content: "x\n# ... rest unchanged\n" });
    return answer("done");
  } });
  cleanup.push(async () => { server.stop(true); });
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture" }],
  } } }));
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false } }));
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }));
  const env = cleanEnv({ HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" });
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/pi-loop-guard.ts"), project], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  // payloads[n] carries the result of the call made at step n - 1.
  expect(lastToolText(payloads[2])).not.toContain(REPEAT_NOTE);
  expect(lastToolText(payloads[3])).toContain(REPEAT_NOTE);
  expect(lastToolText(payloads[5])).toContain("Skipped as a repeat");
  expect(lastToolText(payloads[5])).toContain("LOOP_NOTES_TEXT");
  // The write left a placeholder where code was: its result carries the note (src/runtime/elision.ts).
  expect(lastToolText(payloads[6])).toContain(ELISION_NOTE);
  expect(lastToolText(payloads[5])).not.toContain(ELISION_NOTE);
  expect(lastToolText(payloads[7])).toContain("LOOP_NOTES_TEXT");
  expect(lastToolText(payloads[7])).not.toContain(REPEAT_NOTE);
  expect(lastToolText(payloads[7])).not.toContain("Skipped");
  const result = JSON.parse(stdout.slice(stdout.indexOf("LOOP_RESULT=") + "LOOP_RESULT=".length).trim());
  expect(result.toolEnds.map((end: { toolName: string; isError: boolean }) => [end.toolName, end.isError]))
    .toEqual([["read", false], ["read", false], ["read", false], ["read", false], ["read", true], ["write", false], ["read", false]]);
  // The skipped 5th read still reached the spend pause: the guard runs after the other gates.
  expect(result.waits).toEqual(["read", "read", "read", "read", "read", "write", "read"]);
}, 20_000);
