import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import type { AgentRuntime } from "../src/runtime/types";
import { currentShell } from "../src/app/runtime-start";
import { browserSession, serviceManager, taskServiceTool } from "../src/app/task-tools";
import type { BrowserSessionOptions } from "../src/browser/session";
import { richApp } from "./support/app";
import { removeTempDir } from "./support/temp-dir";

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
const listCall = () => sse(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "ls", arguments: "{}" } }] }, null) + chunk({}, "tool_calls"));

/** Runs `body` against a real PiRuntime session in a child process, with a local fixture provider. `prelude` runs
 * before the session starts; `startOptions` are added to its start options. */
async function run(respond: (count: number) => Response, body: string, prelude = "", startOptions = "") {
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
}, 90_000);

test("a line typed during work reaches the AI with a note to carry on with its task; the screen and the saved conversation keep the person's words", async () => {
  const { STEERED_NOTE } = await import("../src/runtime/steered-lines");
  const { result, payloads } = await run(count => count === 1 ? listCall() : answer(`DONE ${count}`), `
    const waiting = [];
    let steered;
    session.subscribe(event => {
      if (event.type === "waiting") waiting.push(event.lines);
      if (event.type === "tool_start" && steered === undefined) steered = session.steer("HOW_MANY_CARDS?");
    });
    await session.prompt("List the files");
    await steered;
    await session.prompt("Next task");
    const saved = await Bun.file(session.getSessionInfo().sessionFile).text();
    console.log(JSON.stringify({ waiting, saved }));`);
  const typed = (payload: (typeof payloads)[number]) => payload.messages.filter(message => JSON.stringify(message).includes("HOW_MANY_CARDS?"));
  expect(payloads.length).toBe(3);
  expect(typed(payloads[0]!)).toEqual([]);
  const [line] = typed(payloads[1]!);
  const text = JSON.stringify(line);
  expect(text.indexOf(JSON.stringify(STEERED_NOTE).slice(1, -1))).toBeGreaterThan(-1);
  expect(text.indexOf(JSON.stringify(STEERED_NOTE).slice(1, -1))).toBeLessThan(text.indexOf("HOW_MANY_CARDS?"));
  expect(JSON.stringify(payloads[1]!.messages).split(STEERED_NOTE.slice(0, 20)).length).toBe(2);
  // The next task's request carries the same bytes for that line, so the provider's cache still matches.
  expect(typed(payloads[2]!)).toEqual([line]);
  for (const request of ["List the files", "Next task"])
    expect(payloads[2]!.messages.filter(message => JSON.stringify(message).includes(request)).every(message => !JSON.stringify(message).includes(STEERED_NOTE.slice(0, 20)))).toBe(true);
  expect((result.waiting as string[][]).flat()).toContain("HOW_MANY_CARDS?");
  expect(JSON.stringify(result.waiting)).not.toContain(STEERED_NOTE.slice(0, 20));
  expect(result.saved as string).toContain("HOW_MANY_CARDS?");
  expect(result.saved as string).not.toContain(STEERED_NOTE.slice(0, 20));
}, 90_000);

const bashCall = (command: string) => sse(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }, null) + chunk({}, "tool_calls"));

test.skipIf(process.platform === "win32")("a line steered in while a slow command runs reaches the model at once: the command moves to the background and keeps running", async () => {
  const module = (name: string) => JSON.stringify(path.join(repo, name));
  // The shell as the app holds it: slow commands on (a 60 s limit, far past this test) and listening for a line.
  const prelude = `const { BackgroundCommands } = await import(${module("src/runtime/background-commands.ts")});
    const { SteerWaits } = await import(${module("src/app/steer-waits.ts")});
    const waits = new SteerWaits(), listening = Promise.withResolvers();
    const commands = new BackgroundCommands({ notify: () => {}, limitSeconds: 60 });`;
  const shell = "shell: { wrap: async (command) => ({ command }), background: () => commands, whenSteered: (end) => { listening.resolve(); return waits.listen(end); } }";
  const { result, payloads } = await run(count => count === 1 ? bashCall("echo started; sleep 20; echo finished") : answer("DONE"), `
    // As steerOrQueue does once the command waits: the line goes to the model, then the waits end.
    const steered = Promise.race([listening.promise.then(async () => ({ sent: await session.steer("ALSO_MENTION_PINEAPPLE"), ended: waits.steered() })),
      new Promise(resolve => setTimeout(() => resolve("the command never listened"), 30_000).unref())]);
    await session.prompt("Run the slow command");
    console.log(JSON.stringify({ steered: await steered, running: commands.list().map(entry => entry.id), unsent: session.takeUnsent() }));
    await commands.close();`, prelude, shell);
  expect(result).toEqual({ steered: { sent: true, ended: 1 }, running: ["cmd-1"], unsent: [] });
  expect(payloads).toHaveLength(2);
  // The command's result (its output so far, not its last line) and then the line, in the same next request.
  const next = payloads[1]!.messages;
  const output = JSON.stringify(next.find(message => message.role === "tool"));
  expect(output).toContain("this moved to the background as cmd-1");
  expect(output).not.toContain("finished");
  expect(JSON.stringify(next.slice(next.findIndex(message => message.role === "tool")))).toContain("ALSO_MENTION_PINEAPPLE");
}, 90_000);

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
    await app.until(text => text.includes("sent to Casper"));
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
    // Echoed once, with ❯, when it was typed; not again as "> then add a title" when it runs.
    expect(app.screen()).toContain("❯ then add a title");
    expect(app.screen()).not.toContain("> then add a title");
  } finally { for (const gate of state.gates) gate.resolve(); await app.close(); }
}, 30_000);

const SERVICE = `"${process.execPath}" "${path.join(import.meta.dir, "fixtures", "service-server.ts")}"`;

test("a line that reaches the AI ends the steps only waiting then: the AI's shell, a service start and the sign-in window; a queued line ends none", async () => {
  process.env.TERM = "xterm-256color";
  const state = { prompts: [] as string[], steered: [] as string[], steering: true, gates: [Promise.withResolvers<void>(), Promise.withResolvers<void>()] };
  const app = await richApp(() => fakeRuntime(state));
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("write a poem\r");
    await app.until(() => state.prompts.length === 1);
    const casper = app.app;
    const ended: string[] = [];
    // How the AI's shell and the sign-in window listen while they wait (each ends its own wait when told).
    currentShell(casper).whenSteered!(() => ended.push("shell"));
    (browserSession(casper) as unknown as { options: BrowserSessionOptions }).options.whenSteered!(() => ended.push("sign-in"));
    // A service start that never gets ready: the line ends the wait, and the call says it is starting.
    casper.projectContext!.services = { api: { command: SERVICE, port: "auto", ready: { log: "a line it never prints" }, timeoutMs: 60_000 } };
    const start = taskServiceTool(casper).execute({ action: "start", service: "api" }, new AbortController().signal);
    for (let i = 0; i < 200 && serviceManager(casper).status()[0]?.state !== "starting"; i++) await Bun.sleep(25);
    app.input.write("make it rhyme\r");
    await app.until(text => text.includes("sent to Casper"));
    expect(state.steered).toEqual(["make it rhyme"]);
    const envelope = JSON.parse((await start).text);
    expect((envelope.data ?? envelope).service).toMatchObject({ name: "api", state: "starting" });
    expect(ended).toEqual(["shell", "sign-in"]);
    await app.until(text => text.includes("[browser] Closing the sign-in window so Casper reads your line; a sign-in you finished there is kept."));
    // While Casper runs checks or writes the receipt the line is queued, and no wait ends for it.
    state.steering = false;
    currentShell(casper).whenSteered!(() => ended.push("not this time"));
    app.input.write("then add a title\r");
    await app.until(text => text.includes("queued · runs when this task ends"));
    expect(ended).toEqual(["shell", "sign-in"]);
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
    const terminal = (app.app as unknown as { terminal: { approve(preview: string, question: string, options: { label: string }[]): Promise<string | undefined> } }).terminal;
    let settled = false;
    const approval = terminal.approve("Reach example.com?\n", "Allow it?", [{ label: "No" }, { label: "Yes, this once" }]).then(answer => { settled = true; return answer; });
    await Bun.sleep(200);
    expect(settled).toBe(false);
    app.input.write("\x1b");
    expect(await approval).toBeUndefined();
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
    await app.until(text => text.includes("sent to Casper"));
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

test("a line typed as the task ends is never stranded: it comes back in the prompt", async () => {
  process.env.TERM = "xterm-256color";
  const gate = Promise.withResolvers<void>();
  const prompts: string[] = [];
  let holder: { app?: unknown };
  const runtime: AgentRuntime = {
    async start() {
      return {
        setTools: () => {}, getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const }),
        getState: () => ({ cwd: "", isStreaming: false }), subscribe: () => () => {}, abort: async () => {},
        // The model's run ends while Casper offers it the line, so it was not taken.
        steer: async () => {
          gate.resolve();
          for (let i = 0; i < 400 && (holder.app as unknown as { commandActive: boolean } | undefined)?.commandActive !== false; i++) await Bun.sleep(10);
          return false;
        },
        prompt: async (text: string) => { prompts.push(text); if (prompts.length === 1) await gate.promise; },
      };
    },
    async dispose() {},
  };
  holder = {};
  const app = await richApp(() => runtime);
  holder.app = app.app;
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("write a poem\r");
    await app.until(() => prompts.length === 1);
    app.input.write("make it rhyme\r");
    await app.until(text => text.includes("your line is back in the prompt"), 8000);
    app.input.write("\r");
    await app.until(() => prompts.length === 2);
    expect(prompts[1]).toContain("make it rhyme");
  } finally { gate.resolve(); await app.close(); }
}, 30_000);

test("a line taken back before the model's next step never reaches it; taking back the newest leaves the rest to be read", async () => {
  const { result, payloads } = await run(count => count === 1 ? listCall() : answer("DONE"), `
    const waiting = [];
    let taken;
    session.subscribe(event => {
      if (event.type === "waiting") waiting.push(event.lines);
      if (event.type === "tool_start" && taken === undefined) {
        taken = (async () => {
          await session.steer("KEEP_PINEAPPLE"); await session.steer("DROP_MANGO"); await session.steer("DROP_KIWI");
          const newest = session.unsteer(true);
          await Bun.sleep(0);
          return { newest, all: [] };
        })();
      }
    });
    await session.prompt("List the files");
    console.log(JSON.stringify({ taken: await taken, waiting, unsent: session.takeUnsent() }));`);
  expect((result.taken as { newest: string[] }).newest).toEqual(["DROP_KIWI"]);
  const sent = JSON.stringify(payloads.at(-1)!.messages);
  expect(sent).toContain("KEEP_PINEAPPLE");
  expect(sent).toContain("DROP_MANGO");
  expect(sent).not.toContain("DROP_KIWI");
  // The screen hears each change, and the last says nothing waits.
  expect((result.waiting as string[][]).some(lines => lines.includes("DROP_KIWI"))).toBe(true);
  expect((result.waiting as string[][]).at(-1)).toEqual([]);
}, 90_000);

test("unsteer() takes every waiting line out before the model reads any", async () => {
  const { result, payloads } = await run(count => count === 1 ? listCall() : answer("DONE"), `
    let taken;
    session.subscribe(event => {
      if (event.type === "tool_start" && taken === undefined) taken = session.steer("NEVER_SENT_FIG").then(() => session.unsteer());
    });
    await session.prompt("List the files");
    console.log(JSON.stringify({ taken: await taken, unsent: session.takeUnsent() }));`);
  expect(result).toEqual({ taken: ["NEVER_SENT_FIG"], unsent: [] });
  expect(JSON.stringify(payloads)).not.toContain("NEVER_SENT_FIG");
}, 90_000);

/** A runtime that behaves as Pi does on an abort: a line still waiting goes into the conversation. */
function waitingRuntime(state: { prompts: string[]; waiting: string[]; conversation: string[]; order: string[]; gate: ReturnType<typeof Promise.withResolvers<void>> }) {
  let listener: ((event: import("../src/runtime/types").RuntimeEvent) => void) | undefined;
  const say = () => listener?.({ type: "waiting", lines: [...state.waiting] });
  const runtime: AgentRuntime = {
    async start() {
      return {
        setTools: () => {}, getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const }),
        getState: () => ({ cwd: "", isStreaming: true }),
        subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
        abort: async () => { state.order.push("abort"); state.conversation.push(...state.waiting.splice(0)); say(); state.gate.resolve(); },
        steer: async (text: string) => { state.waiting.push(text); say(); return true; },
        unsteer: (newest?: boolean) => { state.order.push("unsteer"); const taken = newest ? state.waiting.splice(-1) : state.waiting.splice(0); say(); return taken; },
        takeUnsent: () => [],
        prompt: async (text: string) => { state.prompts.push(text); state.conversation.push(text); await state.gate.promise; },
      };
    },
    async dispose() {},
  };
  return { runtime, read: () => { state.conversation.push(...state.waiting.splice(0)); say(); } };
}
type Surface = { waitingRows(width: number): string[] };
const surfaceOf = (app: Awaited<ReturnType<typeof richApp>>) => (app.app as unknown as { terminal: { surface: Surface } }).terminal.surface;

test("Esc during a step puts a waiting line back in the prompt, never in the conversation", async () => {
  process.env.TERM = "xterm-256color";
  const state = { prompts: [] as string[], waiting: [] as string[], conversation: [] as string[], order: [] as string[], gate: Promise.withResolvers<void>() };
  const app = await richApp(() => waitingRuntime(state).runtime);
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("sign me in\r");
    await app.until(() => state.prompts.length === 1);
    app.input.write("good to go\r");
    await app.until(text => text.includes("sent to Casper · it reads this when its current step ends · ↑ takes it back"));
    app.input.write("\x1b");
    await app.until(text => text.includes("back in the prompt"));
    // Taken out first, then aborted: the line never joined the conversation.
    expect(state.order.slice(0, 2)).toEqual(["unsteer", "abort"]);
    expect(state.conversation).toHaveLength(1);
    expect(state.conversation.join("\n")).not.toContain("good to go");
    app.input.write("\r");
    await app.until(() => state.prompts.length === 2);
    expect(state.prompts[1]).toContain("good to go");
  } finally { state.gate.resolve(); await app.close(); }
}, 30_000);

test("a waiting line shows above the prompt until the AI reads it; ↑ on an empty prompt takes the newest back", async () => {
  process.env.TERM = "xterm-256color";
  const state = { prompts: [] as string[], waiting: [] as string[], conversation: [] as string[], order: [] as string[], gate: Promise.withResolvers<void>() };
  const fake = waitingRuntime(state);
  const app = await richApp(() => fake.runtime);
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("write a poem\r");
    await app.until(() => state.prompts.length === 1);
    app.input.write("make it rhyme\r");
    app.input.write("and short\r");
    await app.until(() => state.waiting.length === 2);
    await app.until(() => surfaceOf(app).waitingRows(100).length === 2);
    const rows = surfaceOf(app).waitingRows(100).map(row => Bun.stripANSI(row));
    expect(rows).toEqual(["↳ waiting: make it rhyme", "↳ waiting: and short · ↑ takes it back"]);
    // ↑ takes back the newest: it leaves the runtime and comes back as the draft, unsent.
    app.input.write("\x1b[A");
    await app.until(() => state.waiting.length === 1);
    expect(state.order).toEqual(["unsteer"]);
    await app.until(() => surfaceOf(app).waitingRows(100).length === 1);
    const editor = (app.app as unknown as { terminal: { surface: { editor: { getText(): string } } } }).terminal.surface.editor;
    expect(editor.getText()).toBe("and short");
    // The AI reads the other: its row clears.
    fake.read();
    await app.until(() => surfaceOf(app).waitingRows(100).length === 0);
    expect(state.conversation.slice(1)).toEqual(["make it rhyme"]);
  } finally { state.gate.resolve(); await app.close(); }
}, 30_000);
