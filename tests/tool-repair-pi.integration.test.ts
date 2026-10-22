import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { posixOnly } from "./support/platform";
import { cleanEnv } from "./support/env";
import { childTestLimit, finished } from "./support/limits";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

interface Payload { messages: Array<{ role: string; content: unknown }> }
function stream(delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({ id: "repair", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
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
  if (typeof last?.content === "string") return last.content;
  return Array.isArray(last?.content) ? last.content.map((part: { text?: string }) => part.text ?? "").join("\n") : "";
}

/** A weak model's near misses run through the real Pi runtime: each is repaired and its result says the right form. */
posixOnly("a misnamed field, an array sent as a JSON string and a single value for an array are repaired, with a note; what Pi repairs itself gets none", async () => {
  let step = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-tool-repair-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"); const project = path.join(root, "project"); const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(project);
  await writeFile(path.join(project, "notes.txt"), "REPAIR_NOTES_TEXT\n");
  const payloads: Payload[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    payloads.push(await request.json());
    const now = step++;
    if (now === 0) return call(now, "read", { file_path: "notes.txt" });
    if (now === 1) return call(now, "edit", { path: "notes.txt", edits: JSON.stringify([{ oldText: "REPAIR_NOTES_TEXT", newText: "EDITED" }]) });
    if (now === 2) return call(now, "pick", { names: '["one"]' });
    if (now === 3) return call(now, "pick", { names: "two" });
    if (now === 4) return call(now, "read", { path: "notes.txt" });
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
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/pi-tool-repair.ts"), project], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  // payloads[n] carries the result of the call made at step n - 1.
  expect(lastToolText(payloads[1])).toContain("REPAIR_NOTES_TEXT");
  expect(lastToolText(payloads[1])).toContain('Next time use "path", not "file_path".');
  // Pi's edit already takes "edits" as a JSON string quietly (some strong models send it so): no note.
  expect(lastToolText(payloads[2])).not.toContain("repaired");
  expect(lastToolText(payloads[3])).toContain('send "names" as JSON, not a string holding JSON');
  expect(lastToolText(payloads[4])).toContain('send "names" as an array');
  // A call that needed nothing gets no note.
  expect(lastToolText(payloads[5])).toContain("EDITED");
  expect(lastToolText(payloads[5])).not.toContain("repaired");
  expect(await readFile(path.join(project, "notes.txt"), "utf8")).toBe("EDITED\n");
  const result = JSON.parse(stdout.slice(stdout.indexOf("REPAIR_RESULT=") + "REPAIR_RESULT=".length).trim());
  expect(result.toolEnds.map((end: { toolName: string; isError: boolean }) => [end.toolName, end.isError]))
    .toEqual([["read", false], ["edit", false], ["pick", false], ["pick", false], ["read", false]]);
  expect(result.picked).toEqual([["one"], ["two"]]);
}, 20_000);

/** The text of every tool result the model was sent, in order. */
function toolTexts(payload: Payload | undefined): string[] {
  return (payload?.messages ?? []).filter((message) => message.role === "tool").map((message) => typeof message.content === "string" ? message.content
    : Array.isArray(message.content) ? message.content.map((part: { text?: string }) => part.text ?? "").join("\n") : "");
}

/** The fixture session on the real Pi runtime, its model a loopback server. `reply` answers by how many tool results
 * the request carries, so a guarded restart (tests/support/limits.ts) starts the script again from the top. */
async function fixtureSession(reply: (step: number) => Response) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-tool-text-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"); const project = path.join(root, "project"); const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(project);
  const payloads: Payload[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const payload = await request.json() as Payload;
    payloads.push(payload);
    return reply(toolTexts(payload).length);
  } });
  cleanup.push(async () => { server.stop(true); });
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture" }],
  } } }));
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", retry: { enabled: false } }));
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }));
  const env = cleanEnv({ HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" });
  const run = await finished(() => Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/pi-tool-repair.ts"), project], { cwd: project, env, stdout: "pipe", stderr: "pipe" }));
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
  const result = JSON.parse(run.stdout.slice(run.stdout.indexOf("REPAIR_RESULT=") + "REPAIR_RESULT=".length).trim());
  return { project, sent: toolTexts(payloads.at(-1)), toolEnds: result.toolEnds.map((end: { toolName: string; isError: boolean }) => [end.toolName, end.isError]) };
}

/** A weak model's write with a number for its path and false for its content: Pi would turn them into "33" and
 * "false" and make that file. Casper refuses the call before it runs, and the model's corrected call works. */
posixOnly("a write whose path and content are not text is refused and makes no file; the corrected write works", async () => {
  const { project, sent, toolEnds } = await fixtureSession((step) => step === 0 ? call(0, "write", { path: 33, content: false })
    : step === 1 ? call(1, "write", { path: "notes.txt", content: "fixed\n" }) : answer("done"));
  expect(sent[0]).toContain("write did not run: path must be a string, not the number 33; content must be a string, not the boolean false. Send them as strings.");
  expect(await readdir(project)).toEqual(["notes.txt"]);
  expect(await readFile(path.join(project, "notes.txt"), "utf8")).toBe("fixed\n");
  expect(sent[1]).not.toContain("did not run");
  expect(toolEnds).toEqual([["write", true], ["write", false]]);
}, childTestLimit());
