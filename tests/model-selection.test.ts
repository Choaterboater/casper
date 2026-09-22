import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { needsPosixModes, needsSymlinks, posixOnly } from "./support/platform";
import { isolatedEnvironment } from "../src/platform/environment";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const adapter = path.resolve(import.meta.dir, "../src/runtime/pi.ts");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-models-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  const agent = path.join(home, ".pi/agent"); const casper = path.join(home, ".casper");
  await mkdir(agent, { recursive: true }); await mkdir(casper); await mkdir(path.join(project, ".pi"), { recursive: true });
  const shared = JSON.stringify({ defaultProvider: "fixture", defaultModel: "shared", defaultThinkingLevel: "high", retry: { enabled: false } });
  await writeFile(path.join(agent, "settings.json"), shared);
  await writeFile(path.join(project, ".pi/settings.json"), shared);
  await writeFile(path.join(agent, "auth.json"), "{}\n");
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: {
    fixture: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture-not-a-secret", models: [{ id: "first" }, { id: "second", reasoning: true }, { id: "shared" }] },
    missing: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "no-auth" }] },
  } }));
  const env = { ...isolatedEnvironment(home), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  async function run(body: string) {
    const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(adapter)};
const runtime = new PiRuntime();
try { const session = await runtime.start({ cwd: process.cwd() }); ${body} } finally { await runtime.dispose(); }`],
      { cwd: project, env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 25_000); // A real Pi runtime in a fresh Bun child; the Windows CI runner has needed more than 10 s.
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      return JSON.parse(stdout.split("RESULT=")[1]!);
    } finally { clearTimeout(timer); }
  }
  async function cli(...args: string[]) {
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/cli.ts"), ...args],
      { cwd: project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  }
  return { home, project, agent, casper, shared, env, run, cli };
}

/** Standalone picker host over raw IO: the same StreamTerminal lease the interactive surface uses. */
const MOUNT_HOST = `
const { TuiMainScreen } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-tui/dist/index.js"))});
const { StreamTerminal } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/tui/stream-terminal.ts"))});
const host = io => ({ run: operation => operation(io), mount: async operation => {
  const tui = new TuiMainScreen(new StreamTerminal(io, io.onEOF)); let started = false;
  try { return await operation({ tui, color: io.color, onEOF: io.onEOF, show: component => { tui.addChild(component); if (!started) { started = true; tui.start(); } } }); }
  finally { if (started) tui.stop(); }
} });`;

test("local diff remains usable when workspace changes exceed the display budget", async () => {
  const f = await fixture();
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: f.project, env: f.env, stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  };
  await writeFile(path.join(f.project, "tracked.txt"), "before\n");
  await git("init", "-b", "main"); await git("add", "tracked.txt"); await git("commit", "-m", "Temporary fixture baseline");
  await writeFile(path.join(f.project, "tracked.txt"), "after\n".repeat(15000));
  const result = await f.cli("/diff");
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("+after");
  expect(result.stdout).toContain("truncated");
  expect(await readFile(path.join(f.project, "tracked.txt"), "utf8")).toBe("after\n".repeat(15000));
}, 30_000);

test("context and usage are local; fresh conversations retain saved sessions without touching source files", async () => {
  const f = await fixture();
  await f.cli("/model", "fixture/second");
  const context = await f.cli("/context");
  expect(context.exit).toBe(0);
  expect(context.stdout).toContain("Context");
  const usage = await f.cli("/usage");
  expect(usage.exit).toBe(0);
  expect(usage.stdout).toContain("not a bill");
  expect((await f.cli("/clear")).exit).toBe(0);
  const listed = await f.cli("/resume");
  expect(listed.exit).toBe(0);
  expect(listed.stdout).toContain("Use /resume <exact-id>");
  const result = await f.run(`
const before = session.getSessionInfo();
await session.selectModel({ query: 'fixture/second', persist: false });
await session.clearConversation();
const after = session.getSessionInfo();
const saved = await session.listConversations();
await session.resumeConversation(before.sessionId);
console.log('RESULT=' + JSON.stringify({ before: before.sessionId, after: after.sessionId, saved, resumed: session.getSessionInfo().sessionId }));`);
  expect(result.after).not.toBe(result.before);
  expect(result.resumed).toBe(result.before);
  expect(result.saved.length).toBeGreaterThanOrEqual(2);
  expect(await readFile(path.join(f.project, ".pi/settings.json"), "utf8")).toBe(f.shared);
}, 30_000);

test("remembered effort survives switching away and back within the same conversation", async () => {
  const f = await fixture();
  const status = await f.run(`
await session.selectModel({ query: 'fixture/second', persist: true });
await session.setEffort('high', true);
await session.selectModel({ query: 'fixture/first', persist: false });
await session.selectModel({ query: 'fixture/second', persist: false });
console.log('RESULT=' + JSON.stringify(session.getStatus()));`);
  expect(status.thinkingLevel).toBe("high");
}, 30_000);

test("effort is validated, remembered for the default, and session-only changes stay local", async () => {
  const f = await fixture();
  await f.cli("/model", "fixture/second");
  const changed = await f.cli("/effort", "high");
  expect(changed.exit).toBe(0);
  expect(changed.stdout).toContain("high");
  expect(await f.run(`console.log('RESULT=' + JSON.stringify(session.getStatus()));`)).toMatchObject({ thinkingLevel: "high" });
  const rejected = await f.cli("/effort", "bananas");
  expect(rejected.exit).not.toBe(0);
  await f.cli("/effort", "low", "--session");
  expect(await f.run(`console.log('RESULT=' + JSON.stringify(session.getStatus()));`)).toMatchObject({ thinkingLevel: "high" });
  expect(await readFile(path.join(f.agent, "settings.json"), "utf8")).toBe(f.shared);
}, 30_000);

test("model selection changes the conversation without adopting or rewriting shared Pi defaults", async () => {
  const f = await fixture();
  const result = await f.run(`
const initial = session.getStatus();
const selected = await session.selectModel({ query: 'fixture/second', persist: false });
console.log('RESULT=' + JSON.stringify({ initial, selected, status: session.getStatus() }));`);
  expect(result.initial.model).toBeUndefined();
  expect(result.initial.blocked).toContain("/model");
  expect(result.status).toMatchObject({ provider: "fixture", model: "second", auth: "configured", selectionSource: "conversation" });
  expect(await readFile(path.join(f.agent, "settings.json"), "utf8")).toBe(f.shared);
  expect(await readFile(path.join(f.project, ".pi/settings.json"), "utf8")).toBe(f.shared);
  expect(await readFile(path.join(f.agent, "auth.json"), "utf8")).toBe("{}\n");
  expect(await readFile(path.join(f.casper, "settings.json"), "utf8").catch(() => "absent")).toBe("absent");
}, 30_000);

test("plain /model lists locally; an exact selection is remembered across fresh conversations", async () => {
  const f = await fixture();
  const listed = await f.cli("/model");
  expect(listed.exit).toBe(0);
  expect(listed.stdout).toContain("fixture/second");
  expect(listed.stdout).toContain("No Casper model selected");
  const selected = await f.cli("/model", "fixture/second");
  expect(selected.exit).toBe(0);
  expect(selected.stdout).toContain("conversation");
  const restored = await f.cli("/model");
  expect(restored.stdout).toContain("fixture / second");
  expect(restored.stdout).not.toContain("No Casper model selected");
  expect(restored.stdout).not.toContain("\u001b[");
  expect((await f.cli("/model", "--session", "fixture/first")).exit).toBe(0);
  expect((await f.cli("/model")).stdout).toContain("fixture / second");
}, 30_000);

// python3 runs the standard-library PTY fixture; Windows has no equivalent here.
posixOnly("production CLI hosts Pi's picker without losing terminal ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-model-pty-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const child = Bun.spawn(["python3", path.join(import.meta.dir, "fixtures/model-pty.py"), process.execPath, root], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("MODEL PTY PASS");
  } finally { clearTimeout(timer); }
}, 70_000);

test("picker catalog diagnostics stay readable without executing terminal controls in color or NO_COLOR", async () => {
  const f = await fixture();
  const provider = "broken\x1b]0;CASPER_DIAGNOSTIC_TITLE\x07\u009b2J\u202e";
  await writeFile(path.join(f.agent, "models.json"), JSON.stringify({ providers: { [provider]: { api: 123 } } }));
  const screens = await f.run(`${MOUNT_HOST}
const { PassThrough } = await import('node:stream');
const screens = [];
for (const color of [true, false]) {
  const input = new PassThrough(); let output = ''; let cancelling = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const result = await session.selectModel({ signal: controller.signal, picker: host({
      input, color, onEOF() {}, output: { columns: 160, rows: 40, write(text) {
        output += text;
        if (!cancelling && output.includes('Invalid models.json schema:')) {
          cancelling = true; setTimeout(() => input.write('\\x03'), 0);
        }
      } },
    }) });
    screens.push({ color, output, selected: result.selected });
  } finally { clearTimeout(timeout); input.destroy(); }
}
console.log('RESULT=' + JSON.stringify(screens));`);
  for (const screen of screens) {
    expect(screen.selected).toBe(false);
    expect(screen.output).toContain("Invalid models.json schema:");
    expect(screen.output).toContain("must be string");
    expect(screen.output).not.toContain("\x1b]0;");
    expect(screen.output).not.toMatch(/[\u009b\u202e]/u);
    expect(screen.output).toContain("\x1b[?2004h"); // Pi's own renderer controls must still work.
    expect(/\x1b\[[0-9;:]*m/.test(screen.output)).toBe(screen.color);
  }
}, 30_000);

test("picker refresh failures neutralize provider labels and thrown diagnostics without hiding the error", async () => {
  const f = await fixture();
  const screens = await f.run(`${MOUNT_HOST}
const { PassThrough } = await import('node:stream');
const { ModelRuntime } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/index.js"))});
const original = ModelRuntime.prototype.refresh;
const marker = '\\x1b]0;CASPER_REFRESH_TITLE\\x07\\u009b2J\\u202e';
const screens = [];
try {
  for (const kind of ['single', 'multiple', 'exception', 'string']) for (const color of [true, false]) {
    // Fault injection at the external Pi SDK boundary, isolated to this subprocess.
    // The real picker, renderer and Casper runtime selection path still run.
    ModelRuntime.prototype.refresh = async () => {
      if (kind === 'exception') throw new Error('REFRESH_FAILED' + marker);
      if (kind === 'string') throw 'REFRESH_FAILED' + marker;
      const errors = new Map([['provider-one' + marker, new Error('local catalog failed')]]);
      if (kind === 'multiple') errors.set('provider-two' + marker, new Error('another catalog failed'));
      return { aborted: false, errors };
    };
    const input = new PassThrough(); let output = ''; let cancelling = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const result = await session.selectModel({ signal: controller.signal, picker: host({
        input, color, onEOF() {}, output: { columns: 160, rows: 40, write(text) {
          output += text;
          if (!cancelling && output.includes('Could not refresh')) {
            cancelling = true; setTimeout(() => input.write('\\x03'), 0);
          }
        } },
      }) });
      screens.push({ kind, color, output, selected: result.selected });
    } finally { clearTimeout(timeout); input.destroy(); }
  }
} finally { ModelRuntime.prototype.refresh = original; }
console.log('RESULT=' + JSON.stringify(screens));`);
  for (const screen of screens) {
    expect(screen.selected).toBe(false);
    expect(screen.output).toContain("Could not refresh");
    expect(screen.output).toContain(screen.kind === "single" ? "provider-one" : screen.kind === "multiple" ? "2 model catalogs" : "REFRESH_FAILED");
    expect(screen.output).not.toContain("\x1b]0;");
    expect(screen.output).not.toMatch(/[\u009b\u202e]/u);
    expect(/\x1b\[[0-9;:]*m/.test(screen.output)).toBe(screen.color);
  }
}, 30_000);

test("unavailable defaults and restored models block generation without choosing another provider", async () => {
  const f = await fixture();
  await writeFile(path.join(f.casper, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "removed" }));
  const result = await f.run(`
const before = session.getStatus(); let failure;
try { await session.prompt('MUST_NOT_SEND'); } catch (error) { failure = error.message; }
console.log('RESULT=' + JSON.stringify({ before, failure }));`);
  expect(result.before).toMatchObject({ provider: "fixture", model: "removed", selectionSource: "default" });
  expect(result.before.blocked).toContain("unavailable");
  expect(result.failure).toContain("no fallback");
}, 30_000);

test("restoring an unavailable conversation never falls back to the usable Casper default", async () => {
  const f = await fixture();
  const saved = await f.run(`
await session.selectModel({ query: 'fixture/first', persist: true });
await session.selectModel({ query: 'fixture/second' });
console.log('RESULT=' + JSON.stringify(session.getSessionInfo()));`);
  const config = JSON.parse(await readFile(path.join(f.agent, "models.json"), "utf8"));
  config.providers.fixture.models = [{ id: "first" }];
  await writeFile(path.join(f.agent, "models.json"), JSON.stringify(config));
  const restored = await f.run(`
await session.switchSession({ cwd: process.cwd(), sessionFile: ${JSON.stringify(saved.sessionFile)} });
let failure; try { await session.prompt('MUST_NOT_SEND'); } catch (error) { failure = error.message; }
console.log('RESULT=' + JSON.stringify({ status: session.getStatus(), failure }));`);
  expect(restored.status).toMatchObject({ provider: "fixture", model: "second", selectionSource: "conversation", defaultModel: { provider: "fixture", id: "first" } });
  expect(restored.status.blocked).toContain("unavailable");
  expect(restored.failure).toContain("no fallback");
}, 30_000);

test("a restored model with missing auth stays identifiable and cannot send a prompt", async () => {
  const f = await fixture();
  const saved = await f.run(`
await session.selectModel({ query: 'fixture/second' });
console.log('RESULT=' + JSON.stringify(session.getSessionInfo()));`);
  const config = JSON.parse(await readFile(path.join(f.agent, "models.json"), "utf8"));
  delete config.providers.fixture.apiKey;
  await writeFile(path.join(f.agent, "models.json"), JSON.stringify(config));
  const restored = await f.run(`
await session.switchSession({ cwd: process.cwd(), sessionFile: ${JSON.stringify(saved.sessionFile)} });
let failure; try { await session.prompt('MUST_NOT_SEND'); } catch (error) { failure = error.message; }
console.log('RESULT=' + JSON.stringify({ status: session.getStatus(), failure }));`);
  expect(restored.status).toMatchObject({ provider: "fixture", model: "second", auth: "missing", selectionSource: "conversation" });
  expect(restored.failure).toContain("/login");
}, 30_000);

test("missing auth, unknown models and cancelled selection leave the active model and default unchanged", async () => {
  const f = await fixture();
  const result = await f.run(`
await session.selectModel({ query: 'fixture/first', persist: true });
const failures = [];
for (const query of ['missing/no-auth', 'fixture/not-real']) {
  try { await session.selectModel({ query, persist: true }); } catch (error) { failures.push(error.message); }
}
const controller = new AbortController(); controller.abort();
try { await session.selectModel({ query: 'fixture/second', signal: controller.signal }); } catch (error) { failures.push(error.name); }
console.log('RESULT=' + JSON.stringify({ failures, status: session.getStatus() }));`);
  expect(result.failures[0]).toContain("/login");
  expect(result.failures[1]).toContain("Unknown model");
  expect(result.failures[2]).toBe("AbortError");
  expect(result.status).toMatchObject({ model: "first", defaultModel: { provider: "fixture", id: "first" } });
}, 30_000);

test("ambiguous bare model IDs require a provider instead of silently choosing one", async () => {
  const f = await fixture();
  const config = JSON.parse(await readFile(path.join(f.agent, "models.json"), "utf8"));
  config.providers.other = { ...config.providers.fixture, models: [{ id: "first" }] };
  await writeFile(path.join(f.agent, "models.json"), JSON.stringify(config));
  const result = await f.run(`
await session.selectModel({ query: 'fixture/second' });
let failure; try { await session.selectModel({ query: 'first' }); } catch (error) { failure = error.message; }
const unchanged = session.getStatus();
await session.selectModel({ query: 'OTHER/FIRST' });
console.log('RESULT=' + JSON.stringify({ failure, unchanged, selected: session.getStatus() }));`);
  expect(result.failure).toContain("Ambiguous");
  expect(result.unchanged).toMatchObject({ provider: "fixture", model: "second" });
  expect(result.selected).toMatchObject({ provider: "other", model: "first" });
}, 30_000);

needsPosixModes("failed default persistence reports failure while retaining the explicitly selected conversation model", async () => {
  const f = await fixture();
  const result = await f.run(`
const { chmodSync } = await import('node:fs');
const dir = process.env.HOME + '/.casper';
chmodSync(dir, 0o500);
let failure;
try { await session.selectModel({ query: 'fixture/second', persist: true }); } catch (error) { failure = error.message; }
finally { chmodSync(dir, 0o700); }
console.log('RESULT=' + JSON.stringify({ failure, status: session.getStatus() }));`);
  expect(result.failure).toContain("default could not be saved");
  expect(result.status.model).toBe("second");
  expect(result.status.defaultModel).toBeUndefined();
  expect(await readFile(path.join(f.agent, "settings.json"), "utf8")).toBe(f.shared);
}, 30_000);

test("cancelling a pending Pi auth check cannot later select or persist a model", async () => {
  const f = await fixture();
  const result = await f.run(`
await session.selectModel({ query: 'fixture/first' });
const { ModelRuntime } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/index.js"))});
const original = ModelRuntime.prototype.checkAuth;
let release; const pending = new Promise(resolve => { release = resolve; });
ModelRuntime.prototype.checkAuth = async () => { await pending; return { source: 'fixture', type: 'api_key' }; };
const controller = new AbortController();
const selection = session.selectModel({ query: 'fixture/second', persist: true, signal: controller.signal });
controller.abort(); release();
let failure;
try { await selection; } catch (error) { failure = error.name; }
finally { ModelRuntime.prototype.checkAuth = original; }
console.log('RESULT=' + JSON.stringify({ failure, status: session.getStatus() }));`);
  expect(result.failure).toBe("AbortError");
  expect(result.status.model).toBe("first");
  expect(result.status.defaultModel).toBeUndefined();
}, 30_000);

test("disposing during model auth prevents a late selection or default write", async () => {
  const f = await fixture();
  const result = await f.run(`
await session.selectModel({ query: 'fixture/first' });
const { ModelRuntime } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/index.js"))});
const original = ModelRuntime.prototype.checkAuth;
let release; const pending = new Promise(resolve => { release = resolve; });
ModelRuntime.prototype.checkAuth = async () => { await pending; return { source: 'fixture', type: 'api_key' }; };
const selection = session.selectModel({ query: 'fixture/second', persist: true }).then(() => 'selected', error => error.name);
const closing = runtime.dispose(); release();
const outcome = await selection; await closing;
ModelRuntime.prototype.checkAuth = original;
console.log('RESULT=' + JSON.stringify({ outcome }));`);
  expect(result.outcome).toBe("AbortError");
  expect(await readFile(path.join(f.casper, "settings.json"), "utf8").catch(() => "absent")).toBe("absent");
}, 30_000);

test("explicit compaction uses the local provider, cancels active work, and pre-aborted compact sends nothing", async () => {
  const f = await fixture();
  let requests = 0;
  const marker = path.join(f.home, "compaction-arrived");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch() {
    requests++;
    if (requests === 5) {
      await writeFile(marker, "arrived");
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    }
    const event = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "first", choices: [{ index: 0, delta: { role: "assistant", content: "LOCAL_COMPACTION_SUMMARY" }, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 } };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(async () => { server.stop(true); });
  const config = JSON.parse(await readFile(path.join(f.agent, "models.json"), "utf8"));
  config.providers.fixture.baseUrl = `http://127.0.0.1:${server.port}/v1`;
  await writeFile(path.join(f.agent, "models.json"), JSON.stringify(config));
  await writeFile(path.join(f.agent, "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 10, reserveTokens: 100 }, retry: { enabled: false } }));
  const result = await f.run(`
await session.selectModel({ query: 'fixture/first', persist: false });
await session.prompt('Explain this synthetic context. '.repeat(100));
await session.prompt('One more local fixture response.');
await session.compact('Keep the fixture facts.');
const controller = new AbortController(); controller.abort();
let aborted = false;
try { await session.compact(undefined, controller.signal); } catch (error) { aborted = error.name === 'AbortError'; }
await session.prompt('Additional synthetic context. '.repeat(100));
const activeController = new AbortController();
const active = session.compact(undefined, activeController.signal).then(() => false, () => true);
while (!await Bun.file(${JSON.stringify(marker)}).exists()) await Bun.sleep(10);
activeController.abort();
const activeAborted = await active;
console.log('RESULT=' + JSON.stringify({ aborted, activeAborted, file: session.getSessionInfo().sessionFile, usage: session.getUsage() }));`);
  expect(requests).toBe(5);
  expect(result.aborted).toBe(true);
  expect(result.activeAborted).toBe(true);
  expect(result.usage.tokens.total).toBeGreaterThan(0);
  const transcript = await readFile(result.file, "utf8");
  expect(transcript).toContain('"type":"compaction"');
  expect(transcript).toContain("LOCAL_COMPACTION_SUMMARY");
}, 30_000);

test("selection before the first response keeps Pi persistence writable for the next prompt", async () => {
  const f = await fixture();
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    const event = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "second", choices: [{ index: 0, delta: { role: "assistant", content: "MODEL_SELECTION_REPLY" }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(async () => { server.stop(true); });
  const config = JSON.parse(await readFile(path.join(f.agent, "models.json"), "utf8"));
  config.providers.fixture.baseUrl = `http://127.0.0.1:${server.port}/v1`;
  await writeFile(path.join(f.agent, "models.json"), JSON.stringify(config));
  const result = await f.run(`
await session.selectModel({ query: 'fixture/second' });
const errors = []; session.subscribe(event => { if (event.type === 'error') errors.push(event.message); });
await session.prompt('LOCAL_PROTOCOL_FIXTURE');
console.log('RESULT=' + JSON.stringify({ errors, file: session.getSessionInfo().sessionFile }));`);
  expect(requests).toBe(1);
  expect(result.errors).toEqual([]);
  expect(await readFile(result.file, "utf8")).toContain("MODEL_SELECTION_REPLY");
}, 30_000);

test("selecting in a persisted session preserves inactive transcript branches", async () => {
  const f = await fixture();
  const result = await f.run(`
const { SessionManager } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/index.js"))});
const manager = SessionManager.create(process.cwd());
manager.appendModelChange('fixture', 'first');
const root = manager.appendMessage({ role: 'user', content: 'ROOT', timestamp: 1 });
manager.appendMessage({ role: 'assistant', content: [{type: 'text', text: 'OLD_BRANCH'}], api: 'openai-completions', provider: 'fixture', model: 'first', usage: {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}, stopReason: 'stop', timestamp: 2 });
manager.branch(root);
manager.appendMessage({ role: 'user', content: 'ACTIVE_BRANCH', timestamp: 3 });
await session.switchSession({ cwd: process.cwd(), sessionFile: manager.getSessionFile() });
await session.selectModel({ query: 'fixture/second' });
console.log('RESULT=' + JSON.stringify({ entries: SessionManager.open(manager.getSessionFile()).getEntries() }));`);
  expect(JSON.stringify(result.entries)).toContain("OLD_BRANCH");
  expect(JSON.stringify(result.entries)).toContain("ACTIVE_BRANCH");
}, 30_000);

test("concurrent model changes and prompts cannot race an active selection", async () => {
  const f = await fixture();
  const result = await f.run(`
await session.selectModel({ query: 'fixture/first' });
const { ModelRuntime } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/index.js"))});
const original = ModelRuntime.prototype.checkAuth;
let release; const pending = new Promise(resolve => { release = resolve; });
ModelRuntime.prototype.checkAuth = async () => { await pending; return { source: 'fixture', type: 'api_key' }; };
const selection = session.selectModel({ query: 'fixture/second' });
const failures = [];
try { await session.selectModel({ query: 'fixture/first', persist: true }); } catch (error) { failures.push(error.message); }
try { await session.prompt('MUST_NOT_SEND'); } catch (error) { failures.push(error.message); }
release(); await selection;
ModelRuntime.prototype.checkAuth = original;
console.log('RESULT=' + JSON.stringify({ failures, status: session.getStatus() }));`);
  expect(result.failures[0]).toContain("active work");
  expect(result.failures[1]).toContain("selection is in progress");
  expect(result.status).toMatchObject({ model: "second", selectionSource: "conversation" });
  expect(result.status.defaultModel).toBeUndefined();
}, 30_000);

test("a prompt in auth preflight excludes model switching until cancellation settles", async () => {
  const f = await fixture();
  const result = await f.run(`
await session.selectModel({ query: 'fixture/first' });
const { ModelRuntime } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/index.js"))});
const original = ModelRuntime.prototype.checkAuth; const configured = ModelRuntime.prototype.hasConfiguredAuth;
let checks = 0; ModelRuntime.prototype.hasConfiguredAuth = function (...args) { return checks++ === 0 ? configured.apply(this, args) : false; };
let release; const pending = new Promise(resolve => { release = resolve; });
ModelRuntime.prototype.checkAuth = async () => { await pending; return { source: 'fixture', type: 'api_key' }; };
const controller = new AbortController();
const prompt = session.prompt('MUST_NOT_SEND', controller.signal).catch(() => {});
let failure; try { await session.selectModel({ query: 'fixture/second' }); } catch (error) { failure = error.message; }
controller.abort(); release(); await prompt;
ModelRuntime.prototype.checkAuth = original; ModelRuntime.prototype.hasConfiguredAuth = configured;
console.log('RESULT=' + JSON.stringify({ failure, status: session.getStatus() }));`);
  expect(result.failure).toContain("active work");
  expect(result.status.model).toBe("first");
}, 30_000);

test("corrupt Casper defaults fail visibly without resetting the file or adopting Pi preferences", async () => {
  const f = await fixture();
  await writeFile(path.join(f.casper, "settings.json"), '{"defaultProvider":');
  const result = await f.cli("/model");
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("Cannot read Casper model defaults");
  expect(await readFile(path.join(f.casper, "settings.json"), "utf8")).toBe('{"defaultProvider":');
  expect(await readFile(path.join(f.agent, "settings.json"), "utf8")).toBe(f.shared);
}, 30_000);

needsSymlinks("a Casper settings alias cannot rewrite shared Pi settings", async () => {
  const f = await fixture();
  await symlink(path.join(f.agent, "settings.json"), path.join(f.casper, "settings.json"));
  const result = await f.cli("/model", "fixture/second");
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("unshared");
  expect(await readFile(path.join(f.agent, "settings.json"), "utf8")).toBe(f.shared);
}, 30_000);

test("explicit default save is Casper-owned; restored conversations and forks retain their own model", async () => {
  const f = await fixture();
  const first = await f.run(`
await session.selectModel({ query: 'fixture/first', persist: true });
const defaultStatus = session.getStatus();
await session.selectModel({ query: 'fixture/second' });
const main = session.getSessionInfo();
const fork = await session.forkSession({ cwd: process.cwd(), name: 'model-fork' });
const forkStatus = session.getStatus();
await session.selectModel({ query: 'fixture/first' });
await session.switchSession({ cwd: main.cwd, sessionFile: main.sessionFile });
console.log('RESULT=' + JSON.stringify({ defaultStatus, main, forkStatus, returned: session.getStatus() }));`);
  expect(first.defaultStatus.defaultModel).toEqual({ provider: "fixture", id: "first" });
  expect(first.forkStatus.model).toBe("second");
  expect(first.returned.model).toBe("second");
  const restored = await f.run(`
const fresh = session.getStatus();
await session.switchSession({ cwd: process.cwd(), sessionFile: ${JSON.stringify(first.main.sessionFile)} });
console.log('RESULT=' + JSON.stringify({ fresh, restored: session.getStatus() }));`);
  expect(restored.fresh).toMatchObject({ model: "first", selectionSource: "default" });
  expect(restored.restored).toMatchObject({ model: "second", selectionSource: "conversation" });
  expect(JSON.parse(await readFile(path.join(f.casper, "settings.json"), "utf8"))).toEqual({ defaultProvider: "fixture", defaultModel: "first", defaultThinkingLevel: "off", modelThinkingLevels: { "fixture/first": "off" } });
  expect(await readFile(path.join(f.agent, "settings.json"), "utf8")).toBe(f.shared);
  expect(await readFile(path.join(f.project, ".pi/settings.json"), "utf8")).toBe(f.shared);
}, 30_000);

test("role edits do not reroute an existing conversation and children use explicit Casper roles", async () => {
  const f = await fixture();
  const result = await f.run(`
await session.selectModel({ query: 'fixture/first', persist: true });
await session.setModelRole('review', 'fixture/second:high');
const unchanged = session.getStatus();
await session.selectModel({ query: '@review:auto', persist: false });
const selected = session.getStatus();
const saved = session.getSessionInfo();
await session.setModelRole('review', 'fixture/first');
await session.clearConversation();
await session.resumeConversation(saved.sessionId);
const restored = session.getStatus();
const childRuntime = new PiRuntime();
try {
 const child = await childRuntime.startReadOnly({ cwd: process.cwd(), signal: new AbortController().signal, maxTurns: 1, maxToolCalls: 1, modelRole: 'review' });
 console.log('RESULT=' + JSON.stringify({ unchanged, selected, restored, child: child.getStatus() }));
} finally { await childRuntime.dispose(); }`);
  expect(result.unchanged.model).toBe("first");
  expect(result.selected).toMatchObject({ model: "second", modelRole: "review", configuredEffort: "auto" });
  expect(result.restored).toMatchObject({ model: "second", configuredEffort: "auto" });
  expect(result.child.model).toBe("first");
  expect(await readFile(path.join(f.agent, "settings.json"), "utf8")).toBe(f.shared);
}, 30_000);

test("cancellation after Pi activates a model retains truthful conversation state without saving defaults", async () => {
  const f = await fixture();
  await mkdir(path.join(f.agent, "extensions"));
  await writeFile(path.join(f.agent, "extensions/selection-boundary.ts"), `
export default pi => {
  pi.on("model_select", async event => {
    const probe = globalThis.modelSwitchProbe;
    if (event.model.id === "second" && probe) {
      probe.entered.resolve();
      await probe.release.promise;
    }
  });
};
`);
  const result = await f.run(`
await session.selectModel({ query: 'fixture/first', persist: true });
const probe = globalThis.modelSwitchProbe = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
const controller = new AbortController();
const pending = session.selectModel({ query: 'fixture/second:medium', persist: true, signal: controller.signal }).catch(error => error.name);
await probe.entered.promise;
controller.abort(); probe.release.resolve();
const error = await pending;
const current = session.getStatus();
const saved = session.getSessionInfo();
await session.clearConversation();
await session.resumeConversation(saved.sessionId);
console.log('RESULT=' + JSON.stringify({ error, current, restored: session.getStatus() }));`);
  expect(result.error).toBe("AbortError");
  expect(result.current).toMatchObject({ model: "second", thinkingLevel: "medium", configuredEffort: "medium" });
  expect(result.current.blocked).toBeUndefined();
  expect(result.restored).toMatchObject({ model: "second", configuredEffort: "medium" });
  expect(result.restored.blocked).toBeUndefined();
  const preferences = JSON.parse(await readFile(path.join(f.casper, "settings.json"), "utf8"));
  expect(preferences.defaultModel).toBe("first");
}, 30_000);

test("automatic effort classifies only the raw request, affects generation and survives resume without changing defaults", async () => {
  const f = await fixture();
  const requests: Array<{ model: string; reasoning_effort?: string; messages: Array<{ role: string; content: unknown }> }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json(); requests.push(body);
    const content = body.model === "first" ? '{"effort":"low"}' : "AUTO_EFFORT_REPLY";
    const event = { id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(async () => { server.stop(true); });
  const config = JSON.parse(await readFile(path.join(f.agent, "models.json"), "utf8"));
  config.providers.fixture.baseUrl = `http://127.0.0.1:${server.port}/v1`;
  await writeFile(path.join(f.agent, "models.json"), JSON.stringify(config));
  const result = await f.run(`
await session.selectModel({ query: 'fixture/second:auto', persist: true });
await session.setModelRole('fast', 'fixture/first');
await session.prompt('PRIVATE_SKILL_AND_CONTEXT raw objective', undefined, { request: 'raw objective' });
const classified = session.getStatus(); const usage = session.getUsage();
const saved = session.getSessionInfo();
await session.clearConversation();
const fresh = session.getStatus();
await session.resumeConversation(saved.sessionId);
const restored = session.getStatus();
await session.setEffort('medium', false);
await session.prompt('FIXED_EFFORT_REQUEST');
console.log('RESULT=' + JSON.stringify({ classified, usage, fresh, restored, fixed: session.getStatus() }));`);
  expect(requests.map(request => request.model)).toEqual(["first", "second", "second"]);
  expect(JSON.stringify(requests[0])).not.toContain("PRIVATE_SKILL_AND_CONTEXT");
  expect(requests[0]!.messages.filter(message => message.role === "user")).toEqual([{ role: "user", content: "raw objective" }]);
  expect(requests[1]!.reasoning_effort).toBe("low");
  expect(requests[2]!.reasoning_effort).toBe("medium");
  expect(result.classified).toMatchObject({ configuredEffort: "auto", thinkingLevel: "low", autoEffort: { state: "classified", classifier: "fixture/first" } });
  expect(result.usage.effortClassification).toMatchObject({ requests: 1, tokens: { total: 14 } });
  expect(result.fresh).toMatchObject({ configuredEffort: "auto", thinkingLevel: "high" });
  expect(result.restored).toMatchObject({ configuredEffort: "auto", thinkingLevel: "low" });
  expect(result.fixed).toMatchObject({ configuredEffort: "medium", thinkingLevel: "medium" });
}, 30_000);

test("classifier cancellation prevents generation and late results cannot alter effort", async () => {
  const f = await fixture();
  const result = await f.run(`
const { ModelRuntime } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/index.js"))});
await session.selectModel({ query: 'fixture/second:auto' });
const entered = Promise.withResolvers(); const late = Promise.withResolvers();
const original = ModelRuntime.prototype.completeSimple;
ModelRuntime.prototype.completeSimple = async () => { entered.resolve(); return late.promise; };
const events = []; session.subscribe(event => events.push(event.type));
const pending = session.prompt('DO_NOT_GENERATE').catch(error => error.name);
await entered.promise;
const blocked = [];
for (const transition of [
 () => session.forkSession({ cwd: process.cwd(), name: 'blocked' }),
 () => session.switchSession({ cwd: process.cwd(), sessionFile: session.getSessionInfo().sessionFile }),
]) { try { await transition(); } catch (error) { blocked.push(error.message); } }
await session.abort();
const error = await pending;
late.resolve({ role: 'assistant', content: [{type:'text',text:'{"effort":"low"}'}], stopReason:'stop', usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{total:0}} });
await late.promise; await Promise.resolve(); await Promise.resolve();
ModelRuntime.prototype.completeSimple = original;
console.log('RESULT=' + JSON.stringify({ error, events, blocked, status: session.getStatus() }));`);
  expect(result.error).toBe("AbortError");
  expect(result.blocked).toHaveLength(2);
  expect(result.blocked.every((message: string) => message.includes("active work"))).toBe(true);
  expect(result.events).not.toContain("assistant_response_start");
  expect(result.events).not.toContain("model_controls_changed");
  expect(result.status.thinkingLevel).toBe("high");
}, 30_000);

test.each(["malformed", "length"])("classifier %s failure retains effort and observed usage while generation continues", async failure => {
  const f = await fixture();
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    const content = requests === 1 ? failure === "malformed" ? "not a classification" : '{"effort":"low"}' : "FALLBACK_REPLY";
    const event = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "second",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: requests === 1 && failure === "length" ? "length" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(async () => { server.stop(true); });
  const config = JSON.parse(await readFile(path.join(f.agent, "models.json"), "utf8"));
  config.providers.fixture.baseUrl = `http://127.0.0.1:${server.port}/v1`;
  config.providers.fixture.models.find((model: { id: string }) => model.id === "second").cost = { input: 2, output: 4, cacheRead: 1, cacheWrite: 1 };
  await writeFile(path.join(f.agent, "models.json"), JSON.stringify(config));
  const result = await f.run(`
await session.selectModel({ query: 'fixture/second:auto' });
await session.prompt('FALLBACK_FIXTURE');
console.log('RESULT=' + JSON.stringify({ status: session.getStatus(), usage: session.getUsage() }));`);
  expect(requests).toBe(2);
  expect(result.status).toMatchObject({ model: "second", thinkingLevel: "high", configuredEffort: "auto", autoEffort: { state: "fallback" } });
  expect(result.usage.effortClassification).toMatchObject({ requests: 1, tokens: { input: 10, output: 4, total: 14 } });
  expect(result.usage.effortClassification.estimatedCost).toBeGreaterThan(0);
}, 30_000);

test("a fresh automatic default survives forking and resuming before its first prompt", async () => {
  const f = await fixture();
  await writeFile(path.join(f.casper, "settings.json"), JSON.stringify({
    defaultProvider: "fixture", defaultModel: "second", autoEffortModels: ["fixture/second"],
  }));
  const result = await f.run(`
const initial = session.getSessionInfo();
await session.forkSession({ cwd: process.cwd(), name: 'before-first-prompt' });
const fork = session.getStatus();
await session.clearConversation();
await session.resumeConversation(initial.sessionId);
console.log('RESULT=' + JSON.stringify({ fork, resumed: session.getStatus() }));`);
  expect(result.fork).toMatchObject({ model: "second", configuredEffort: "auto" });
  expect(result.resumed).toMatchObject({ model: "second", configuredEffort: "auto" });
}, 30_000);
