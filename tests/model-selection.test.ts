import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    fixture: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture-not-a-secret", models: [{ id: "first" }, { id: "second" }, { id: "shared" }] },
    missing: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "no-auth" }] },
  } }));
  const env = { HOME: home, PATH: process.env.PATH!, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  async function run(body: string) {
    const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(adapter)};
const runtime = new PiRuntime();
try { const session = await runtime.start({ cwd: process.cwd() }); ${body} } finally { await runtime.dispose(); }`],
      { cwd: project, env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 10_000);
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

test("model selection changes the conversation without adopting or rewriting shared Pi defaults", async () => {
  const f = await fixture();
  const result = await f.run(`
const initial = session.getStatus();
const selected = await session.selectModel({ query: 'fixture/second' });
console.log('RESULT=' + JSON.stringify({ initial, selected, status: session.getStatus() }));`);
  expect(result.initial.model).toBeUndefined();
  expect(result.initial.blocked).toContain("/model");
  expect(result.status).toMatchObject({ provider: "fixture", model: "second", auth: "configured", selectionSource: "conversation" });
  expect(await readFile(path.join(f.agent, "settings.json"), "utf8")).toBe(f.shared);
  expect(await readFile(path.join(f.project, ".pi/settings.json"), "utf8")).toBe(f.shared);
  expect(await readFile(path.join(f.agent, "auth.json"), "utf8")).toBe("{}\n");
  expect(await readFile(path.join(f.casper, "settings.json"), "utf8").catch(() => "absent")).toBe("absent");
}, 15_000);

test("plain /model lists locally; an exact selection does not become a fresh conversation's default", async () => {
  const f = await fixture();
  const listed = await f.cli("/model");
  expect(listed.exit).toBe(0);
  expect(listed.stdout).toContain("fixture/second");
  expect(listed.stdout).toContain("No Casper model selected");
  const selected = await f.cli("/model", "fixture/second");
  expect(selected.exit).toBe(0);
  expect(selected.stdout).toContain("conversation");
  const restored = await f.cli("/model");
  expect(restored.stdout).toContain("No Casper model selected");
  expect(restored.stdout).not.toContain("\u001b[");
}, 15_000);

test("production CLI hosts Pi's picker without losing terminal ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-model-pty-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const child = Bun.spawn(["python3", path.join(import.meta.dir, "fixtures/model-pty.py"), process.execPath, root], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("MODEL PTY PASS");
  } finally { clearTimeout(timer); }
}, 30_000);

test("picker catalog diagnostics stay readable without executing terminal controls in color or NO_COLOR", async () => {
  const f = await fixture();
  const provider = "broken\x1b]0;CASPER_DIAGNOSTIC_TITLE\x07\u009b2J\u202e";
  await writeFile(path.join(f.agent, "models.json"), JSON.stringify({ providers: { [provider]: { api: 123 } } }));
  const screens = await f.run(`
const { PassThrough } = await import('node:stream');
const screens = [];
for (const color of [true, false]) {
  const input = new PassThrough(); let output = ''; let cancelling = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const result = await session.selectModel({ signal: controller.signal, picker: { run: operation => operation({
      input, color, onEOF() {}, output: { columns: 160, rows: 40, write(text) {
        output += text;
        if (!cancelling && output.includes('Invalid models.json schema:')) {
          cancelling = true; setTimeout(() => input.write('\\x03'), 0);
        }
      } },
    }) } });
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
}, 15_000);

test("picker refresh failures neutralize provider labels and thrown diagnostics without hiding the error", async () => {
  const f = await fixture();
  const screens = await f.run(`
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
      const result = await session.selectModel({ signal: controller.signal, picker: { run: operation => operation({
        input, color, onEOF() {}, output: { columns: 160, rows: 40, write(text) {
          output += text;
          if (!cancelling && output.includes('Could not refresh')) {
            cancelling = true; setTimeout(() => input.write('\\x03'), 0);
          }
        } },
      }) } });
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
}, 15_000);

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
}, 15_000);

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
}, 15_000);

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
}, 15_000);

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
}, 15_000);

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
}, 15_000);

test("failed default persistence reports failure while retaining the explicitly selected conversation model", async () => {
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
}, 15_000);

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
}, 15_000);

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
}, 15_000);

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
}, 15_000);

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
  expect(result.entries.at(-1)).toMatchObject({ type: "model_change", provider: "fixture", modelId: "second" });
}, 15_000);

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
}, 15_000);

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
}, 15_000);

test("corrupt Casper defaults fail visibly without resetting the file or adopting Pi preferences", async () => {
  const f = await fixture();
  await writeFile(path.join(f.casper, "settings.json"), '{"defaultProvider":');
  const result = await f.cli("/model");
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("Cannot read Casper model defaults");
  expect(await readFile(path.join(f.casper, "settings.json"), "utf8")).toBe('{"defaultProvider":');
  expect(await readFile(path.join(f.agent, "settings.json"), "utf8")).toBe(f.shared);
}, 15_000);

test("a Casper settings alias cannot rewrite shared Pi settings", async () => {
  const f = await fixture();
  const { symlink } = await import("node:fs/promises");
  await symlink(path.join(f.agent, "settings.json"), path.join(f.casper, "settings.json"));
  const result = await f.cli("/model", "fixture/second");
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("unshared");
  expect(await readFile(path.join(f.agent, "settings.json"), "utf8")).toBe(f.shared);
}, 15_000);

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
  expect(JSON.parse(await readFile(path.join(f.casper, "settings.json"), "utf8"))).toEqual({ defaultProvider: "fixture", defaultModel: "first" });
  expect(await readFile(path.join(f.agent, "settings.json"), "utf8")).toBe(f.shared);
  expect(await readFile(path.join(f.project, ".pi/settings.json"), "utf8")).toBe(f.shared);
}, 15_000);
