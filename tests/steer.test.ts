import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import type { AgentRuntime } from "../src/runtime/types";
import { richApp } from "./support/app";

const roots: string[] = [];
const servers: Array<{ stop(force: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const repo = path.resolve(import.meta.dir, "..");
setDefaultTimeout(20_000);

function chunk(delta: unknown, finish: string | null): string {
  return `data: ${JSON.stringify({ id: "steer", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}
const sse = (body: string) => new Response(body + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const answer = (text: string) => sse(chunk({ role: "assistant", content: text }, "stop"));
const listCall = () => sse(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "ls", arguments: "{}" } }] }, null) + chunk({}, "tool_calls"));

/** Runs `body` against a real PiRuntime session in a child process, with a local fixture provider. */
async function run(respond: (count: number) => Response, body: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-steer-"))); roots.push(root);
  const home = path.join(root, "home"); const project = path.join(root, "project"); const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(project); await mkdir(path.join(home, ".casper"));
  const payloads: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => { payloads.push(await request.json()); return respond(payloads.length); } });
  servers.push(server);
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture" }] } } }));
  const routing = { defaultProvider: "fixture", defaultModel: "fixture" };
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ ...routing, retry: { enabled: false } }));
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify(routing));
  const env = { ...isolatedEnvironment(home), TMPDIR: root, PI_CODING_AGENT_DIR: agent, CASPER_AGENT_DIR: agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd() });
    try { ${body} } finally { await runtime.dispose(); }`], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return { result: JSON.parse(stdout) as Record<string, unknown>, payloads };
}

test("a line steered in while the model works reaches it at its next step; with nothing running, steer says no", async () => {
  const { result, payloads } = await run(count => count === 1 ? listCall() : answer("DONE"), `
    const idle = await session.steer("too early");
    let steered;
    session.subscribe(event => { if (event.type === "tool_start" && steered === undefined) steered = session.steer("ALSO_MENTION_PINEAPPLE"); });
    await session.prompt("List the files");
    console.log(JSON.stringify({ idle, steered: await steered, unsent: session.takeUnsent() }));`);
  expect(result).toEqual({ idle: false, steered: true, unsent: [] });
  expect(JSON.stringify(payloads.at(-1)!.messages)).toContain("ALSO_MENTION_PINEAPPLE");
  expect(JSON.stringify(payloads[0]!.messages)).not.toContain("too early");
});

function fakeRuntime(state: { prompts: string[]; steered: string[]; steering: boolean; gates: Array<ReturnType<typeof Promise.withResolvers<void>>>; unsent?: string[] }): AgentRuntime {
  return {
    async start() {
      return {
        setTools: () => {},
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const }),
        getState: () => ({ cwd: "", isStreaming: false }),
        subscribe: () => () => {},
        abort: async () => {},
        steer: async (text: string) => { if (!state.steering) return false; state.steered.push(text); return true; },
        takeUnsent: () => state.unsent?.splice(0) ?? [],
        prompt: async (text: string) => { state.prompts.push(text); await state.gates[state.prompts.length - 1]?.promise; },
      };
    },
    async dispose() {},
  };
}

test("Enter mid-task sends the line to the AI while it works; otherwise it is queued and runs when the task ends", async () => {
  process.env.TERM = "xterm-256color";
  const state = { prompts: [] as string[], steered: [] as string[], steering: true, gates: [Promise.withResolvers<void>(), Promise.withResolvers<void>()] };
  const app = await richApp(() => fakeRuntime(state));
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("write a poem\r");
    await app.until(() => state.prompts.length === 1);
    app.input.write("make it rhyme\r");
    await app.until(text => text.includes("sent to the AI"));
    expect(state.steered).toEqual(["make it rhyme"]);
    state.steering = false;
    app.input.write("then add a title\r");
    await app.until(text => text.includes("queued · runs when this task ends"));
    expect(state.prompts).toHaveLength(1);
    state.gates[0]!.resolve();
    await app.until(() => state.prompts.length === 2);
    expect(state.prompts[1]).toContain("then add a title");
    state.gates[1]!.resolve();
    await app.until(text => text.lastIndexOf("idle") > text.lastIndexOf("then add a title"));
  } finally { for (const gate of state.gates) gate.resolve(); await app.close(); }
}, 30_000);

test("a queued line never answers an approval box, and Esc puts queued lines back in the prompt", async () => {
  process.env.TERM = "xterm-256color";
  const state = { prompts: [] as string[], steered: [] as string[], steering: false, gates: [Promise.withResolvers<void>()] };
  const app = await richApp(() => fakeRuntime(state));
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("write a poem\r");
    await app.until(() => state.prompts.length === 1);
    app.input.write("yes\r");
    await app.until(text => text.includes("queued · runs when this task ends"));
    const terminal = (app.app as unknown as { terminal: { confirm(preview: string, question: string): Promise<boolean> } }).terminal;
    let settled = false;
    const approval = terminal.confirm("Reach example.com?\n", "Type yes: ").then(answer => { settled = true; return answer; });
    await Bun.sleep(200);
    expect(settled).toBe(false);
    app.input.write("\x1b");
    expect(await approval).toBe(false);
    // Esc on the running task: the task stops and the queued line comes back as the draft, not as a request.
    app.input.write("\x1b");
    state.gates[0]!.resolve();
    await app.until(text => text.includes("back in the prompt"));
    expect(state.prompts).toHaveLength(1);
    const next = app.screen().length;
    app.input.write("\r");
    await app.until(() => state.prompts.length === 2);
    expect(state.prompts[1]).toContain("yes");
    expect(app.screen().slice(next)).toContain("❯ yes");
  } finally { for (const gate of state.gates) gate.resolve(); await app.close(); }
}, 30_000);

test("a line steered in that the AI never read runs next, as a request", async () => {
  process.env.TERM = "xterm-256color";
  const state = { prompts: [] as string[], steered: [] as string[], steering: true, unsent: [] as string[], gates: [Promise.withResolvers<void>(), Promise.withResolvers<void>()] };
  const app = await richApp(() => fakeRuntime(state));
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("write a poem\r");
    await app.until(() => state.prompts.length === 1);
    app.input.write("make it rhyme\r");
    await app.until(text => text.includes("sent to the AI"));
    state.unsent.push("make it rhyme");
    state.gates[0]!.resolve();
    await app.until(() => state.prompts.length === 2);
    expect(state.prompts[1]).toContain("make it rhyme");
  } finally { for (const gate of state.gates) gate.resolve(); await app.close(); }
}, 30_000);

test("a plain terminal no longer drops what you type during work: it goes to the same steer-or-queue", async () => {
  const { PassThrough } = await import("node:stream");
  const { InteractiveTerminal } = await import("../src/tui/terminal");
  const input = Object.assign(new PassThrough(), { isTTY: true });
  let output = "";
  const terminal = new InteractiveTerminal(input, { write: (text: string) => { output += text; } }, () => {}, () => {});
  const seen: Array<[string, boolean]> = [];
  terminal.setBusySubmit((line, plain) => { seen.push([line, Boolean(plain)]); return line.startsWith("/") ? `${line} waits until this task ends` : true; });
  try {
    terminal.start();
    const command = terminal.readCommand();
    input.write("work\n");
    expect(await command).toBe("work");
    await Bun.sleep(20);
    input.write("and add tests\n");
    await Bun.sleep(20);
    input.write("/undo\n");
    await Bun.sleep(20);
    expect(seen).toEqual([["and add tests", true], ["/undo", true]]);
    expect(output).toContain("[input] /undo waits until this task ends");
  } finally { terminal.close(); input.destroy(); }
});
