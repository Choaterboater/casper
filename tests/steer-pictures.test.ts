import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import type { AgentRuntime, RuntimeImage } from "../src/runtime/types";
import { richApp } from "./support/app";
import { removeTempDir } from "./support/temp-dir";

/** A picture during a task goes to the AI with the line, read as a request's pictures are. Placeholder pictures only. */
const roots: string[] = [];
const servers: Array<{ stop(force: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) await removeTempDir(root);
});
const repo = path.resolve(import.meta.dir, "..");
setDefaultTimeout(20_000);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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
  // Only the model's POSTs: in the full suite a stray GET / from another test once reached this port and failed the test.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    payloads.push(await request.json()); return respond(payloads.length);
  } });
  servers.push(server);
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [{ id: "fixture", input: ["text", "image"] }] } } }));
  const routing = { defaultProvider: "fixture", defaultModel: "fixture" };
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ ...routing, retry: { enabled: false } }));
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify(routing));
  const env = { ...isolatedEnvironment(home), TMPDIR: root, PI_CODING_AGENT_DIR: agent, CASPER_AGENT_DIR: agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd(), localModels: false });
    try { ${body} } finally { await runtime.dispose(); }`], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return { result: JSON.parse(stdout) as Record<string, unknown>, payloads };
}

test("a picture steered in while the model works reaches its next request with the line", async () => {
  const { result, payloads } = await run(count => count === 1 ? listCall() : answer("DONE"), `
    let steered;
    session.subscribe(event => { if (event.type === "tool_start" && steered === undefined) steered = session.steer("LOOK_AT_THIS", [{ data: ${JSON.stringify(PNG)}, mimeType: "image/png" }]); });
    await session.prompt("List the files");
    console.log(JSON.stringify({ steered: await steered }));`);
  expect(result).toEqual({ steered: true });
  const last = JSON.stringify(payloads.at(-1)!.messages);
  expect(last).toContain("LOOK_AT_THIS");
  expect(last).toContain(PNG);
}, 90_000);

test("taking back the newest waiting line leaves the other lines their pictures", async () => {
  const { result, payloads } = await run(count => count === 1 ? listCall() : answer("DONE"), `
    let taken;
    session.subscribe(event => {
      if (event.type === "tool_start" && taken === undefined) {
        taken = (async () => {
          await session.steer("KEEP_THIS_PICTURE", [{ data: ${JSON.stringify(PNG)}, mimeType: "image/png" }]);
          await session.steer("TAKE_THIS_BACK");
          const newest = session.unsteer(true);
          await Bun.sleep(0);
          return newest;
        })();
      }
    });
    await session.prompt("List the files");
    console.log(JSON.stringify({ taken: await taken }));`);
  expect(result).toEqual({ taken: ["TAKE_THIS_BACK"] });
  // Pi's queue gives back only the text: the line put back in goes with its picture all the same.
  const sent = JSON.stringify(payloads.at(-1)!.messages);
  expect(sent).toContain("KEEP_THIS_PICTURE");
  expect(sent).toContain(PNG);
  expect(sent).not.toContain("TAKE_THIS_BACK");
}, 90_000);

interface State { prompts: Array<{ text: string; images: readonly RuntimeImage[] }>; steered: Array<{ text: string; images: readonly RuntimeImage[] }>; steering: boolean; sees: boolean; gates: Array<ReturnType<typeof Promise.withResolvers<void>>> }
function fakeRuntime(state: State): AgentRuntime {
  return {
    async start() {
      return {
        setTools: () => {},
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const, images: state.sees }),
        getState: () => ({ cwd: "", isStreaming: true }),
        subscribe: () => () => {},
        abort: async () => {},
        steer: async (text: string, images?: readonly RuntimeImage[]) => { if (!state.steering) return false; state.steered.push({ text, images: images ?? [] }); return true; },
        takeUnsent: () => [],
        prompt: async (text: string, _signal?: AbortSignal, options?: { images?: readonly RuntimeImage[] }) => {
          state.prompts.push({ text, images: options?.images ?? [] }); await state.gates[state.prompts.length - 1]?.promise;
        },
      };
    },
    async dispose() {},
  };
}
const fresh = (over: Partial<State> = {}): State => ({ prompts: [], steered: [], steering: true, sees: true, gates: [Promise.withResolvers<void>(), Promise.withResolvers<void>()], ...over });
type Pasting = { terminal: { takePastedImages(): Map<number, RuntimeImage> } };

test("a picture file dropped during a task goes to the AI with the line, not after the task", async () => {
  process.env.TERM = "xterm-256color";
  const state = fresh();
  const app = await richApp(() => fakeRuntime(state));
  try {
    await writeFile(path.join(app.project, "shot.png"), Buffer.from(PNG, "base64"));
    await app.until(text => text.includes("idle"));
    app.input.write("fix the layout\r");
    await app.until(() => state.prompts.length === 1);
    app.input.write(`${path.join(app.project, "shot.png")} this is what I see\r`);
    await app.until(() => state.steered.length === 1);
    expect(state.steered[0]!.images).toEqual([{ data: PNG, mimeType: "image/png" }]);
    expect(state.steered[0]!.text).toContain("[image 1] this is what I see");
    expect(state.steered[0]!.text).toContain(`[image 1] is the file ${path.join(app.project, "shot.png")}`);
    await app.until(text => text.includes("sent to Casper with your picture"));
    expect(app.screen()).not.toContain("waits until this task ends");
  } finally { for (const gate of state.gates) gate.resolve(); await app.close(); }
}, 30_000);

test("a picture pasted with Ctrl+V during a task goes with the line; queued, it goes with the next request", async () => {
  process.env.TERM = "xterm-256color";
  const state = fresh();
  const app = await richApp(() => fakeRuntime(state));
  const terminal = (app.app as unknown as Pasting).terminal;
  const original = terminal.takePastedImages.bind(terminal);
  let next: Map<number, RuntimeImage> | undefined;
  terminal.takePastedImages = () => { const taken = next ?? original(); next = undefined; return taken; };
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("fix the layout\r");
    await app.until(() => state.prompts.length === 1);
    next = new Map([[1, { data: PNG, mimeType: "image/png" }]]);
    app.input.write("[image 1] like this\r");
    await app.until(() => state.steered.length === 1);
    expect(state.steered[0]!.images).toEqual([{ data: PNG, mimeType: "image/png" }]);
    // The AI isn't working right now: the line is queued, and its picture runs with it.
    state.steering = false;
    next = new Map([[2, { data: PNG, mimeType: "image/png" }]]);
    app.input.write("[image 2] and this one\r");
    await app.until(text => text.includes("queued · runs when this task ends"));
    state.gates[0]!.resolve();
    await app.until(() => state.prompts.length === 2);
    expect(state.prompts[1]!.text).toContain("[image 2] and this one");
    expect(state.prompts[1]!.images).toEqual([{ data: PNG, mimeType: "image/png" }]);
  } finally { for (const gate of state.gates) gate.resolve(); await app.close(); }
}, 30_000);

test("a line sent with a picture is like any other: ↑ takes it back, and a step that only waits ends so the AI reads it now", async () => {
  process.env.TERM = "xterm-256color";
  const state = fresh();
  const app = await richApp(() => fakeRuntime(state));
  const terminal = (app.app as unknown as Pasting).terminal;
  const original = terminal.takePastedImages.bind(terminal);
  let next: Map<number, RuntimeImage> | undefined;
  terminal.takePastedImages = () => { const taken = next ?? original(); next = undefined; return taken; };
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("sign me in\r");
    await app.until(() => state.prompts.length === 1);
    // A step that only waits (the sign-in window, a slow command) listens for a line.
    const ended: string[] = [];
    (app.app as unknown as { steerWaits: { listen(end: () => void): () => void } }).steerWaits.listen(() => ended.push("wait"));
    next = new Map([[1, { data: PNG, mimeType: "image/png" }]]);
    app.input.write("[image 1] signed in, see\r");
    await app.until(text => text.includes("sent to Casper with your picture · it reads this when its current step ends · ↑ takes it back"));
    expect(state.steered[0]!.images).toEqual([{ data: PNG, mimeType: "image/png" }]);
    expect(ended).toEqual(["wait"]);
  } finally { for (const gate of state.gates) gate.resolve(); await app.close(); }
}, 30_000);

test("the prompt's rules hold: a file that isn't a picture stays words, and a model that can't see gets the line alone", async () => {
  process.env.TERM = "xterm-256color";
  const state = fresh({ sees: false });
  const app = await richApp(() => fakeRuntime(state));
  try {
    await writeFile(path.join(app.project, "fake.png"), "not a picture");
    await writeFile(path.join(app.project, "shot.png"), Buffer.from(PNG, "base64"));
    await app.until(text => text.includes("idle"));
    app.input.write("fix the layout\r");
    await app.until(() => state.prompts.length === 1);
    app.input.write(`see ${path.join(app.project, "fake.png")}\r`);
    await app.until(() => state.steered.length === 1);
    expect(state.steered[0]).toEqual({ text: `see ${path.join(app.project, "fake.png")}`, images: [] });
    app.input.write(`${path.join(app.project, "shot.png")} here\r`);
    await app.until(() => state.steered.length === 2);
    expect(state.steered[1]!.images).toEqual([]);
    expect(state.steered[1]!.text).toContain("is the file");
    await app.until(text => text.includes("This model can't see pictures; the AI gets your line without it."));
  } finally { for (const gate of state.gates) gate.resolve(); await app.close(); }
}, 30_000);
