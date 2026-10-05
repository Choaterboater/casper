import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../../src/platform/environment";

/**
 * The scripted loopback provider and project helpers shared by the scripting.*.integration test files. They are
 * split so a parallel run can spread these slow, real-CLI tests over several workers.
 */
const cli = path.resolve(import.meta.dir, "../../src/cli.ts");
const cleanup: Array<() => Promise<unknown>> = [];
/** Call once at the top of each test file: removes each test's homes and stops its provider afterwards. */
export function cleanUpAfterEach(): void {
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
}

export interface Payload { model: string; messages: Array<{ role: string; content: unknown }>; reasoning_effort?: string }
export type Step = { text: string } | { tools: Array<{ name: string; args: unknown }> };

export function chunk(delta: unknown, finishReason: string | null, usage?: unknown): string {
  return `data: ${JSON.stringify({ id: "scripting", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`;
}
/** Every response reports 100 prompt and 20 completion tokens. */
export const USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
export function respond(step: Step): Response {
  const body = "text" in step
    ? chunk({ role: "assistant", content: step.text }, "stop", USAGE)
    : chunk({ role: "assistant", tool_calls: step.tools.map((tool, index) => ({ index, id: `call_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) }, null) + chunk({}, "tool_calls", USAGE);
  return new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

/** An isolated home whose Casper default is fixture/first, served by a scripted loopback provider. */
export async function fixture(script: (request: number, payload: Payload) => Step = () => ({ text: "LOCAL_RESPONSE" })) {
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
  async function run(args: string[], cwd = project, extra: Record<string, string> = {}, input?: string) {
    const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: { ...env, ...extra }, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
    // A hang guard only: under a loaded parallel run one CLI run can take well over 20 s.
    const timer = setTimeout(() => child.kill(), 60_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, exit };
    } finally { clearTimeout(timer); }
  }
  return { root, home, project, settings, payloads, run };
}


/** Saved conversation IDs, newest first, from the local /resume listing (no model call). */
export async function savedConversations(f: Awaited<ReturnType<typeof fixture>>): Promise<string[]> {
  const listing = await f.run(["/resume"]);
  expect(listing.exit).toBe(0);
  return listing.stdout.split("\n").map((line) => /^([0-9a-f-]{8,})\s/.exec(line)?.[1]).filter((id): id is string => Boolean(id));
}
export const userText = (payload: Payload) => JSON.stringify(payload.messages.filter((message) => message.role === "user"));

/** Parse every stdout line as a v1 event and replace run-specific values with stable markers. */
export function events(stdout: string, project: string) {
  const lines = stdout.split("\n").filter(Boolean);
  return lines.map((line) => {
    const event = JSON.parse(line);
    expect(event.v).toBe(1);
    for (const key of ["ms"]) if (key in event) event[key] = typeof event[key] === "number" ? "<ms>" : event[key];
    if (event.type === "session_start") {
      expect(event.session).toMatch(/^[0-9a-f-]{36}$/);
      // The folder as the run spelled it: macOS adds /private, and a Windows TEMP can be a short 8.3 name (RUNNER~1).
      Object.assign(event, { casper: "<version>", session: "<id>", cwd: realpathSync.native(event.cwd) === project ? "<project>" : event.cwd });
    }
    if (event.type === "receipt") event.checks = event.checks.map((check: { ms: number }) => ({ ...check, ms: "<ms>" }));
    if (event.type === "phase") event.atMs = "<ms>";
    return event;
  });
}

/**
 * The fix and proof projects check with POSIX shell commands (sh, grep, test). Windows has them only when Git's tools
 * are on PATH (Git Bash has them, PowerShell usually not), so tests that run those checks skip without them.
 */
export const posixShellTools = ["sh", "grep", "test"].every((tool) => Bun.which(tool) !== null);
export const shellCheckTest = test.skipIf(!posixShellTools);

export async function fixProject(f: Awaited<ReturnType<typeof fixture>>, test = "grep -q fixed sum.js") {
  await mkdir(path.join(f.project, ".casper"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(test)}\n`);
  await writeFile(path.join(f.project, "sum.js"), "broken\n");
}

/** The text of the prompt being answered, and whether the model is answering a tool result. */
export const lastUser = (payload: Payload | undefined) => JSON.stringify([...(payload?.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? "");
export const afterTool = (payload: Payload) => payload.messages.at(-1)?.role === "tool";
export const REVIEW = "Casper requirements review";
/** The requirements review is off by default; a test about the review turns it on in the project. */
export const reviewOn = (f: Awaited<ReturnType<typeof fixture>>) => appendFile(path.join(f.project, ".casper/project.yaml"), "verification:\n  review: true\n");
export const PROOF_REPAIR = "also passes without it";

/** A project whose test passes on the unfixed code too: it cannot prove a fix to sum.js. */
export async function weaklyTestedProject(f: Awaited<ReturnType<typeof fixture>>) {
  await mkdir(path.join(f.project, ".casper"));
  await mkdir(path.join(f.project, "tests"));
  await writeFile(path.join(f.project, ".casper/project.yaml"), 'verify:\n  test: "sh tests/check.sh"\n');
  await writeFile(path.join(f.project, "tests/check.sh"), "test -f sum.js\n");
  await writeFile(path.join(f.project, "sum.js"), "broken\n");
}
export const asked = (payload: Payload | undefined, text: string) => JSON.stringify(payload?.messages ?? []).includes(text);
export const TICKED = { text: "Requirements:\n- [x] sum.js is fixed — tests/check.sh" };

export const ACCEPTANCE = "Casper independent acceptance.";
// Reasoning models get the system prompt as a "developer" message.
export const isAcceptance = (payload: Payload) => payload.messages.some((message) => ["system", "developer"].includes(message.role) && JSON.stringify(message.content).includes(ACCEPTANCE));

export const CHECKLIST = "Casper checklist.";
export const isChecklist = (payload: Payload) => payload.messages.some((message) => ["system", "developer"].includes(message.role) && JSON.stringify(message.content).includes(CHECKLIST));

/** A model that fixes sum.js, then keeps editing through the whole review without ever ending it. */
export const endlessReview = (_request: number, payload: Payload): Step => {
  if (lastUser(payload).includes(REVIEW)) return { tools: [{ name: "write", args: { path: `review-${payload.messages.length}.txt`, content: "x\n" } }] };
  return afterTool(payload) ? { text: "Fixed." } : { tools: [{ name: "write", args: { path: "sum.js", content: "fixed\n" } }] };
};
