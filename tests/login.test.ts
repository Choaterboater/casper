import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { flakyOn, posixOnly } from "./support/platform";
import { PTY_TEST_MS, runPtyFixture } from "./support/pty";
import { isolatedEnvironment } from "../src/platform/environment";
import os from "node:os";
import path from "node:path";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });
const repo = path.resolve(import.meta.dir, "..");
// Every test spawns a fresh Bun child running the real login flow; the 5 s default has
// tripped on the Windows CI runner, and so has 15 s: on a loaded 4-core runner a test that
// takes 5-12 s took 12-27 s.
setDefaultTimeout(30_000);

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-login-"))); roots.push(root);
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(project);
  const env = { ...isolatedEnvironment(home), TMPDIR: root, PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0",
    // Over SSH Codex signs in with a device code; the desktop browser test clears this.
    SSH_CONNECTION: "synthetic 1 synthetic 2" };
  async function run(body: string, args: string[] = []) {
    body = `import { withLoginSurface } from ${JSON.stringify(path.join(repo, "tests/support/login-surface.ts"))};\n${body}`;
    const child = Bun.spawn([process.execPath, "-e", body, ...args], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
    // A hang guard only; the test's own limit is the real bound.
    const timer = setTimeout(() => child.kill(), 60_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      return stdout;
    } finally { clearTimeout(timer); }
  }
  return { root, home, project, env, run };
}

flakyOn("win32")("API-key login verifies with the provider, keeps secrets off screen, and preserves unrelated credentials", async () => {
  for (const provider of ["anthropic", "openrouter"]) {
    const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR;
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(agent, "auth.json"), JSON.stringify({ unrelated: { type: "api_key", key: "keep" } }), { mode: 0o600 });
    const verificationUrl = provider === "anthropic" ? "https://api.anthropic.com/v1/models" : "https://openrouter.ai/api/v1/auth/key";
    const output = await f.run(`
      import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
      import { PassThrough } from 'node:stream';
      const calls = [];
      const headers = [];
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url === ${JSON.stringify(verificationUrl)}) { calls.push(url); headers.push(init?.headers ?? {}); return Response.json({}, { status: 200 }); }
        throw new Error('NETWORK_FORBIDDEN');
      };
      const runtime = new PiRuntime(); const input = new PassThrough(); let screen = '';
      try {
        const result = await runtime.authenticate({ provider: ${JSON.stringify(provider)}, terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
          screen += text;
          if (text.includes('Type a number')) setImmediate(() => input.write('\\r'));
          if (text.includes('Private API key')) setImmediate(() => { input.write('\\x1b[200~synthetic-private-key\\x1b[201~'); setTimeout(() => input.write('\\r'), 20); });
        } } }, operation) } });
        console.log(JSON.stringify({ result, screen, calls, headers }));
      } finally { await runtime.dispose(); input.destroy(); }
    `);
    const result = JSON.parse(output);
    expect(result.result).toEqual({ status: "saved" });
    expect(result.calls).toEqual([verificationUrl]);
    // OpenRouter verification carries Casper's app identity; other providers get none of it.
    const sent = result.headers[0] as Record<string, string>;
    if (provider === "openrouter") {
      expect([sent["HTTP-Referer"], sent["X-OpenRouter-Title"], sent["X-OpenRouter-Categories"], sent["X-OpenRouter-App-Visibility"], sent.authorization])
        .toEqual(["https://choaterboater.github.io/casper/", "Casper", "cli-agent", "hidden", "Bearer synthetic-private-key"]);
    } else {
      expect(Object.keys(sent).map((name) => name.toLowerCase())).not.toContain("http-referer");
    }
    expect(result.screen).not.toContain("synthetic-private-key");
    if (provider === "openrouter") {
      expect(result.screen).toContain("Sign in to OpenRouter");
      expect(result.screen).toContain("sign in with your browser");
      expect(result.screen).toContain("Usage is billed from your OpenRouter credits.");
    }
    expect(JSON.parse(await readFile(path.join(agent, "auth.json"), "utf8"))).toEqual({ unrelated: { type: "api_key", key: "keep" }, [provider]: { type: "api_key", key: "synthetic-private-key" } });
    expect(await Bun.file(path.join(agent, "sessions")).exists()).toBe(false);
  }
}, 60_000);

test("Enter at the numbered sign-in list picks OpenRouter with an API key", async () => {
  const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR;
  await mkdir(agent, { recursive: true });
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    globalThis.fetch = async (input) => {
      if (String(input) === 'https://openrouter.ai/api/v1/auth/key') return Response.json({}, { status: 200 });
      throw new Error('NETWORK_FORBIDDEN');
    };
    const runtime = new PiRuntime(); const input = new PassThrough(); let screen = '';
    try {
      const result = await runtime.authenticate({ terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text;
        if (text.includes('Type a number')) setImmediate(() => input.write('\\r'));
        if (text.includes('Private API key')) setImmediate(() => { input.write('synthetic-key'); setTimeout(() => input.write('\\r'), 20); });
      } } }, operation) } });
      console.log(JSON.stringify({ result, screen }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "saved" });
  expect(Bun.stripANSI(result.screen)).toContain("1 OpenRouter");
  expect(JSON.parse(await readFile(path.join(agent, "auth.json"), "utf8")).openrouter.key).toBe("synthetic-key");
});

test("picking a sign-in way is the consent: no confirm screen, and one plain line says where the key is saved", async () => {
  const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR;
  await mkdir(agent, { recursive: true });
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    globalThis.fetch = async (input) => {
      if (String(input) === 'https://openrouter.ai/api/v1/auth/key') return Response.json({}, { status: 200 });
      throw new Error('NETWORK_FORBIDDEN');
    };
    const runtime = new PiRuntime(); const input = new PassThrough(); let screen = '';
    try {
      const result = await runtime.authenticate({ provider: 'openrouter', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text;
        if (text.includes('Sign in to OpenRouter')) setImmediate(() => input.write('1'));
        if (text.includes('Private API key')) setImmediate(() => { input.write('synthetic-key'); setTimeout(() => input.write('\\r'), 20); });
      } } }, operation) } });
      console.log(JSON.stringify({ result, screen }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "saved" });
  const screen = Bun.stripANSI(result.screen).replace(/[│\s]+/g, " ");
  expect(screen).toContain("Saved in ~/.pi/agent/auth.json, only on this computer.");
  for (const jargon of ["Press Y", "consent", "parent/child", "loopback", "defaults will not change"]) expect(screen).not.toContain(jargon);
  expect(JSON.parse(await readFile(path.join(agent, "auth.json"), "utf8")).openrouter.key).toBe("synthetic-key");
});

test("a provider-rejected API key is never saved and prompts again", async () => {
  const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR;
  await mkdir(agent, { recursive: true });
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://openrouter.ai/api/v1/auth/key') {
        if (init?.headers?.authorization === 'Bearer synthetic-bad-key') { calls.push(401); return Response.json({}, { status: 401 }); }
        calls.push(200); return Response.json({}, { status: 200 });
      }
      throw new Error('NETWORK_FORBIDDEN');
    };
    const runtime = new PiRuntime(); const input = new PassThrough(); let screen = '';
    const keys = ['synthetic-bad-key', 'synthetic-good-key']; let sent = 0;
    try {
      const result = await runtime.authenticate({ provider: 'openrouter', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text;
        if (text.includes('Type a number')) setImmediate(() => input.write('\\r'));
        if (text.includes('Private API key') && sent < keys.length) {
          const key = keys[sent++];
          setImmediate(() => { input.write(key); setTimeout(() => input.write('\\r'), 20); });
        }
      } } }, operation) } });
      console.log(JSON.stringify({ result, screen, calls }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "saved" });
  expect(result.calls).toEqual([401, 200]);
  expect(result.screen).toContain("rejected by openrouter (HTTP 401)");
  expect(result.screen).not.toContain("synthetic-bad-key");
  expect(result.screen).not.toContain("synthetic-good-key");
  expect(JSON.parse(await readFile(path.join(agent, "auth.json"), "utf8")).openrouter.key).toBe("synthetic-good-key");
});

test("an unverifiable API key can be saved explicitly after the network-choice prompt", async () => {
  const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR;
  await mkdir(agent, { recursive: true });
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; throw new Error('NETWORK_DOWN'); };
    const runtime = new PiRuntime(); const input = new PassThrough(); let screen = '';
    try {
      const result = await runtime.authenticate({ provider: 'openrouter', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text;
        if (text.includes('Sign in to OpenRouter')) setImmediate(() => input.write('\\r'));
        if (text.includes('Private API key') && !screen.includes('Key could not be verified')) setImmediate(() => { input.write('synthetic-unverified-key'); setTimeout(() => input.write('\\r'), 20); });
        if (text.includes('Key could not be verified')) setImmediate(() => { input.write('\\x1b[B'); setTimeout(() => input.write('\\r'), 20); });
      } } }, operation) } });
      console.log(JSON.stringify({ result, screen, attempts }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "saved" });
  expect(result.attempts).toBe(1);
  expect(result.screen).toContain("Key could not be verified (network error)");
  expect(result.screen).toContain("Save without verification");
  expect(result.screen).not.toContain("synthetic-unverified-key");
  expect(JSON.parse(await readFile(path.join(agent, "auth.json"), "utf8")).openrouter.key).toBe("synthetic-unverified-key");
});

test("OpenRouter browser sign-in exchanges the pasted authorization code and saves an oauth credential", async () => {
  const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR;
  await mkdir(agent, { recursive: true });
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://openrouter.ai/api/v1/auth/keys' && init?.method === 'POST') {
        const body = JSON.parse(init.body); calls.push(url);
        if (body.code !== 'synthetic-private-code' || !body.code_verifier) throw new Error('INVALID_EXCHANGE');
        return Response.json({ key: 'sk-or-synthetic-key' });
      }
      throw new Error('UNEXPECTED_NETWORK');
    };
    const runtime = new PiRuntime(); const input = new PassThrough(); let screen = ''; let authorized = false;
    try {
      const result = await runtime.authenticate({ provider: 'openrouter', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text;
        if (text.includes('Type a number')) setImmediate(() => { input.write('\\x1b[B'); setTimeout(() => input.write('\\r'), 20); });
        const displayed = Bun.stripANSI(text).replace(/[\\r\\n]/g, '');
        if (!authorized && displayed.includes('https://openrouter.ai/auth')) authorized = true;
        if (authorized && text.includes('Private authorization code')) setImmediate(() => { input.write('synthetic-private-code'); setTimeout(() => input.write('\\r'), 20); });
      } } }, operation) } });
      console.log(JSON.stringify({ result, screen, calls, authorized }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "saved" });
  expect(result.authorized).toBe(true);
  expect(result.calls).toEqual(["https://openrouter.ai/api/v1/auth/keys"]);
  expect(result.screen).toContain("sign in with your browser");
  expect(result.screen).toContain("https://openrouter.ai/auth");
  expect(result.screen).not.toContain("sk-or-synthetic-key");
  expect(result.screen).not.toContain("synthetic-private-code");
  const saved = JSON.parse(await readFile(path.join(agent, "auth.json"), "utf8")).openrouter;
  expect(saved.type).toBe("oauth");
  expect(saved.access).toBe("sk-or-synthetic-key");
});

flakyOn("win32")("Copilot device login discloses account policy changes and saves only Copilot", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    const calls = []; let screen = '';
    globalThis.fetch = async (input, init) => {
      const url = String(input); calls.push([url, init?.method ?? 'GET']);
      if (url === 'https://github.com/login/device/code') return Response.json({ device_code: 'synthetic-device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', interval: 0, expires_in: 60 });
      if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'synthetic-github-secret' });
      if (url === 'https://api.github.com/copilot_internal/v2/token') return Response.json({ token: 'synthetic-copilot-secret', expires_at: Math.floor(Date.now()/1000) + 3600 });
      if (url === 'https://api.individual.githubcopilot.com/models') return Response.json({ data: [{ id: 'claude-haiku-4.5', model_picker_enabled: true, policy: { state: 'unconfigured' } }] });
      if (url === 'https://api.individual.githubcopilot.com/models/claude-haiku-4.5/policy' && init?.method === 'POST') return Response.json({});
      throw new Error('UNEXPECTED_NETWORK');
    };
    const runtime = new PiRuntime(); const input = new PassThrough();
    try {
      const result = await runtime.authenticate({ provider: 'github-copilot', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text;
      } } }, operation) } });
      console.log(JSON.stringify({ result, screen, calls }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "saved" });
  expect(result.screen).toContain("may turn on model policies on your GitHub account");
  expect(result.screen).not.toContain("synthetic-github-secret");
  expect(result.screen).not.toContain("synthetic-copilot-secret");
  expect(result.calls).toEqual([
    ["https://github.com/login/device/code", "POST"],
    ["https://github.com/login/oauth/access_token", "POST"],
    ["https://api.github.com/copilot_internal/v2/token", "GET"],
    ["https://api.individual.githubcopilot.com/models", "GET"],
    ["https://api.individual.githubcopilot.com/models/claude-haiku-4.5/policy", "POST"],
  ]);
  const auth = JSON.parse(await readFile(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8"));
  expect(Object.keys(auth)).toEqual(["github-copilot"]);
  expect(auth["github-copilot"].availableModelIds).toContain("claude-haiku-4.5");
}, 60_000);

test("Anthropic browser sign-in completes through private manual input or real loopback callback and releases listeners", async () => {
  for (const mode of ["manual", "callback", "cancel"]) {
    const provider = "anthropic";
    const f = await fixture();
    const output = await f.run(`
      import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
      import { PassThrough } from 'node:stream'; import { get, createServer } from 'node:http';
      const provider = ${JSON.stringify(provider)}; const mode = ${JSON.stringify(mode)};
      let screen = ''; let authUrl; let callbackUrl; let exchanges = 0; let callbackWork;
      globalThis.fetch = async (input, init) => {
        const url = String(input); const body = JSON.parse(init.body);
        if (url !== 'https://platform.claude.com/v1/oauth/token') throw new Error('UNEXPECTED_NETWORK');
        if (body.code !== 'synthetic-private-code' || !body.code_verifier) throw new Error('INVALID_EXCHANGE');
        exchanges++;
        return Response.json({ access_token: 'synthetic-private-access', refresh_token: 'synthetic-private-refresh', expires_in: 3600 });
      };
      const runtime = new PiRuntime(); const input = new PassThrough();
      try {
        const result = await runtime.authenticate({ provider, terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
          screen += text;
          if (text.includes('Type a number')) setImmediate(() => { input.write('\\x1b[B'); setTimeout(() => input.write('\\r'), 20); });
          const displayed = Bun.stripANSI(text).replace(/[\\r\\n]/g, '');
          const url = displayed.match(/https:\\/\\/[^ ╭┌]+/)?.[0];
          if (url && !authUrl) {
            authUrl = new URL(url);
            callbackUrl = new URL(authUrl.searchParams.get('redirect_uri'));
          }
          if (text.includes('Private authorization code')) setImmediate(() => {
            if (mode === 'cancel') { input.write('\\x1b'); return; }
            if (mode === 'manual') { input.write('\\x1b[200~synthetic-private-code\\x1b[201~'); setTimeout(() => input.write('\\r'), 20); return; }
            const url = new URL(callbackUrl); url.hostname = '127.0.0.1'; url.searchParams.set('code', 'synthetic-private-code');
            url.searchParams.set('state', authUrl.searchParams.get('state'));
            callbackWork = new Promise((resolve, reject) => { get(url, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject); });
          });
        } } }, operation) } });
        const callbackStatus = await callbackWork;
        const server = createServer();
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(callbackUrl.port), '127.0.0.1', resolve); });
        await new Promise(resolve => server.close(resolve));
        console.log(JSON.stringify({ result, exchanges, callbackStatus, safe: !screen.includes('synthetic-private-'), released: true }));
      } finally { await runtime.dispose(); input.destroy(); }
    `);
    const result = JSON.parse(output);
    expect(result.result.status).toBe(mode === "cancel" ? "cancelled" : "saved");
    expect(result.exchanges).toBe(mode === "cancel" ? 0 : 1);
    expect(result.safe).toBe(true);
    expect(result.released).toBe(true);
    if (mode === "callback") expect(result.callbackStatus).toBe(200);
    const auth = JSON.parse(await readFile(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8"));
    expect(Object.keys(auth)).toEqual(mode === "cancel" ? [] : [provider]);
    if (mode !== "cancel") expect(auth[provider].access).toBe("synthetic-private-access");
  }
}, 90_000);

test("private key entry rejects executable syntax, multiline and oversized unfinished pastes without saving", async () => {
  for (const key of ["!touch SHOULD_NOT_EXIST", "!id", "$SECRET_ENV", "line1\nline2", "x".repeat(40_000)]) {
    const f = await fixture();
    // Build the oversized paste inside the child: a 40k literal exceeds Windows' argument length limit.
    const literal = key.length > 8192 ? `'x'.repeat(${key.length})` : JSON.stringify(key);
    const output = await f.run(`
      import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))}; import { PassThrough } from 'node:stream';
      const input = new PassThrough(); const runtime = new PiRuntime(); let screen = '';
      globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
      try {
        const result = await runtime.authenticate({ provider: 'anthropic', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
          screen += text;
          if (text.includes('Type a number')) setImmediate(() => input.write('\\r'));
          if (text.includes('Private API key')) setImmediate(() => { input.write('\\x1b[200~' + ${literal} + ${key.length > 8192 ? "''" : "'\\x1b[201~'"}); setTimeout(() => input.write('\\r'), 20); });
        } } }, operation) } });
        console.log(JSON.stringify({ result, safe: !screen.includes('SHOULD_NOT_EXIST') && !screen.includes('SECRET_ENV') && !screen.includes('line1') }));
      } finally { await runtime.dispose(); input.destroy(); }
    `);
    const result = JSON.parse(output);
    expect(["failed", "cancelled"]).toContain(result.result.status);
    expect(result.safe).toBe(true);
    expect(JSON.parse(await readFile(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8"))).toEqual({});
    expect(await Bun.file(path.join(f.project, "SHOULD_NOT_EXIST")).exists()).toBe(false);
  }
}, 120_000);

flakyOn("win32")("API-key replacement refreshes the selected non-Codex parent without changing its conversation selection", async () => {
  const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR;
  await mkdir(agent, { recursive: true });
  await writeFile(path.join(agent, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "synthetic-old" } }), { mode: 0o600 });
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))}; import { PassThrough } from 'node:stream';
    const calls = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.anthropic.com/v1/models') { calls.push(url); return Response.json({}, { status: 200 }); }
      throw new Error('NETWORK_FORBIDDEN');
    };
    const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd() });
    const model = (await session.selectModel({})).models.find(item => item.provider === 'anthropic');
    await session.selectModel({ query: model.provider + '/' + model.id });
    const before = session.getStatus(); const input = new PassThrough();
    try {
      const result = await runtime.authenticate({ provider: 'anthropic', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        if (text.includes('Type a number')) setImmediate(() => input.write('\\r'));
        if (text.includes('Private API key')) setImmediate(() => { input.write('synthetic-new'); setTimeout(() => input.write('\\r'), 20); });
      } } }, operation) } }); console.log(JSON.stringify({ result, before, after: session.getStatus() }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "saved" });
  expect(result.after).toMatchObject({ provider: "anthropic", model: result.before.model, selectionSource: result.before.selectionSource, auth: "configured" });
  expect(JSON.parse(await readFile(path.join(agent, "auth.json"), "utf8")).anthropic.key).toBe("synthetic-new");
}, 60_000);

flakyOn("win32")("provider refusal and occupied browser port expose no diagnostics and preserve existing credentials", async () => {
  for (const occupied of [false, true]) {
    const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR;
    await mkdir(agent, { recursive: true });
    const original = JSON.stringify({ anthropic: { type: "api_key", key: "synthetic-old" } });
    await writeFile(path.join(agent, "auth.json"), original, { mode: 0o600 });
    const output = await f.run(`
      import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))}; import { PassThrough } from 'node:stream'; import { createServer } from 'node:http';
      const server = createServer(); const occupied = ${occupied};
      if (occupied) await new Promise(resolve => server.listen(53692, '127.0.0.1', resolve));
      let screen = ''; let calls = 0;
      globalThis.fetch = () => { calls++; return Response.json({ error: 'PRIVATE_PROVIDER_DIAGNOSTIC' }, { status: 403 }); };
      const runtime = new PiRuntime(); const input = new PassThrough();
      try {
        const result = await runtime.authenticate({ provider: 'anthropic', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
          screen += text;
          if (text.includes('Type a number')) setImmediate(() => { input.write('\\x1b[B'); setTimeout(() => input.write('\\r'), 20); });
          if (text.includes('Private authorization code')) setImmediate(() => { input.write('private-code'); setTimeout(() => input.write('\\r'), 20); });
        } } }, operation) } }); console.log(JSON.stringify({ result, calls, safe: !screen.includes('PRIVATE_PROVIDER_DIAGNOSTIC') && !screen.includes('private-code') }));
      } finally { await runtime.dispose(); input.destroy(); if (occupied) await new Promise(resolve => server.close(resolve)); }
    `);
    const result = JSON.parse(output);
    expect(result.result.status).toBe("failed");
    expect(result.calls).toBe(occupied ? 0 : 1);
    // The reason Casper has, in plain words, with no provider text.
    if (!occupied) expect(result.result.detail).toBe("Anthropic (Claude) refused the sign-in");
    expect(result.safe).toBe(true);
    expect(await readFile(path.join(agent, "auth.json"), "utf8")).toBe(original);
  }
}, 60_000);

test("Ctrl+C at the sign-in list is cancellation, not login failure", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))}; import { PassThrough } from 'node:stream';
    const runtime = new PiRuntime(); const input = new PassThrough();
    try {
      const result = await runtime.authenticate({ terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        if (text.includes('Type a number')) setImmediate(() => input.write('\\x03'));
      } } }, operation) } }); console.log(JSON.stringify(result));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  expect(JSON.parse(output)).toEqual({ status: "cancelled", effect: "none" });
  expect(await Bun.file(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json")).exists()).toBe(false);
});

test("Esc at the sign-in list never creates auth or starts a session, and the list says where a key would be saved", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    const runtime = new PiRuntime(); const input = new PassThrough(); let screen = '';
    globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
    try {
      const result = await runtime.authenticate({ terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text; if (text.includes('Type a number')) setTimeout(() => input.write('\\x1b'), 0);
      } } }, operation) } });
      console.log(JSON.stringify({ result, screen }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "cancelled", effect: "none" });
  const list = Bun.stripANSI(result.screen).split(/\r?\n/).map(line => line.replace(/^│\s?|\s?│$/g, "").trim()).join(" ");
  expect(list).toContain("Saved in ~/.pi/agent/auth.json, only on this computer.");
  expect(await Bun.file(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json")).exists()).toBe(false);
});

test("when Casper opens sign-in by itself, a provider with one way still shows the numbered list; /login <provider> skips it", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    const runtime = new PiRuntime(); const input = new PassThrough(); let screen = '';
    globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
    try {
      const result = await runtime.authenticate({ provider: 'github-copilot', list: true, terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text; if (text.includes('Esc cancels')) setTimeout(() => input.write('\\x1b'), 0);
      } } }, operation) } });
      console.log(JSON.stringify({ result, screen }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "cancelled", effect: "none" });
  const visible = Bun.stripANSI(result.screen);
  expect(visible).toContain("Sign in to GitHub Copilot");
  expect(visible).toContain("1 GitHub Copilot · enter a code at github.com");
  expect(visible).toContain("Enter continues · Esc cancels");
  expect(await Bun.file(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json")).exists()).toBe(false);
});

test("Codex on a desktop signs in with the browser (device code only over SSH or with no display)", async () => {
  const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR;
  await mkdir(agent, { recursive: true });
  const output = await f.run(`
    delete process.env.SSH_CONNECTION; process.env.DISPLAY = ':0';
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { signInWays } from ${JSON.stringify(path.join(repo, "src/runtime/pi-auth.ts"))};
    import { PassThrough } from 'node:stream';
    const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url');
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input); calls.push(url);
      if (url === 'https://auth.openai.com/oauth/token') {
        const body = new URLSearchParams(String(init.body));
        if (body.get('code') !== 'synthetic-private-code' || body.get('redirect_uri') !== 'http://localhost:1455/auth/callback') throw new Error('INVALID_EXCHANGE');
        return Response.json({ access_token: 'x.' + payload + '.x', refresh_token: 'synthetic-refresh', expires_in: 3600 });
      }
      throw new Error('UNEXPECTED_NETWORK');
    };
    const label = signInWays('openai-codex')[0].label;
    const runtime = new PiRuntime(); const input = new PassThrough(); let screen = ''; let shown = false;
    try {
      const result = await runtime.authenticate({ provider: 'openai-codex', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text;
        if (Bun.stripANSI(text).replace(/[\\r\\n]/g, '').includes('https://auth.openai.com/oauth/authorize')) shown = true;
        if (shown && text.includes('Private authorization code')) setImmediate(() => { input.write('synthetic-private-code'); setTimeout(() => input.write('\\r'), 20); });
      } } }, operation) } });
      console.log(JSON.stringify({ result, calls, shown, label, safe: !screen.includes('synthetic-private-code') }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.label).toContain("sign in with your browser");
  expect(result.result).toEqual({ status: "saved" });
  expect(result.shown).toBe(true);
  expect(result.calls).toEqual(["https://auth.openai.com/oauth/token"]);
  expect(result.safe).toBe(true);
  expect(JSON.parse(await readFile(path.join(agent, "auth.json"), "utf8"))["openai-codex"].refresh).toBe("synthetic-refresh");
});

test("pinned Codex device flow saves provider-scoped credentials and refreshes an active parent without changing its model", async () => {
  const f = await fixture();
  const agent = f.env.PI_CODING_AGENT_DIR;
  await mkdir(agent, { recursive: true });
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url");
  const oldAccess = `x.${payload}.x`;
  await writeFile(path.join(agent, "auth.json"), JSON.stringify({ unrelated: { type: "api_key", key: "synthetic-unrelated" }, "openai-codex": { type: "oauth", access: oldAccess, refresh: "synthetic-old", expires: Date.now() + 60000, accountId: "synthetic-account" } }), { mode: 0o600 });
  await chmod(path.join(agent, "auth.json"), 0o600);
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    const calls = [];
    const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url');
    const access = 'x.' + payload + '.x';
    globalThis.fetch = async (input, init) => {
      const url = String(input); calls.push(url);
      if (url.endsWith('/api/accounts/deviceauth/usercode')) return Response.json({ device_auth_id: 'synthetic-device', user_code: 'ABCD-EFGH', interval: 0 });
      if (url.endsWith('/api/accounts/deviceauth/token')) return Response.json({ authorization_code: 'synthetic-code', code_verifier: 'synthetic-verifier' });
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: access, refresh_token: 'synthetic-new', expires_in: 3600 });
      throw new Error('UNEXPECTED_NETWORK');
    };
    const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd() });
    const listed = await session.selectModel({}); const chosen = listed.models.find(model => model.provider === 'openai-codex');
    if (!chosen) throw new Error('Missing built-in Codex model');
    await session.selectModel({ query: chosen.provider + '/' + chosen.id });
    const before = session.getStatus(); const input = new PassThrough(); let screen = '';
    try {
      const result = await runtime.authenticate({ provider: 'openai-codex', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text;
      } } }, operation) } });
      const after = session.getStatus();
      console.log(JSON.stringify({ result, before, after, calls, safeScreen: !screen.includes('synthetic-new') && !screen.includes('synthetic-code') }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "saved" });
  expect(result.after).toMatchObject({ provider: result.before.provider, model: result.before.model, selectionSource: result.before.selectionSource, auth: "configured" });
  expect(result.calls).toEqual([
    "https://auth.openai.com/api/accounts/deviceauth/usercode",
    "https://auth.openai.com/api/accounts/deviceauth/token",
    "https://auth.openai.com/oauth/token",
  ]);
  expect(result.safeScreen).toBe(true);
  const saved = JSON.parse(await readFile(path.join(agent, "auth.json"), "utf8"));
  expect(saved.unrelated.type).toBe("api_key");
  expect(saved["openai-codex"].refresh).toBe("synthetic-new");
});

test("a committed credential with failed synchronization blocks stale parent auth without retrying login", async () => {
  const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR;
  await mkdir(agent, { recursive: true });
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url");
  await writeFile(path.join(agent, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: `x.${payload}.x`, refresh: "old", expires: Date.now() + 60000, accountId: "synthetic-account" } }), { mode: 0o600 });
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { ModelRuntime } from ${JSON.stringify(path.join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"))};
    import { PassThrough } from 'node:stream';
    const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url');
    const access = 'x.' + payload + '.x'; let fetches = 0;
    globalThis.fetch = async input => { fetches++; const url = String(input);
      if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'id', user_code: 'ABCD-EFGH', interval: 0 });
      if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'code', code_verifier: 'verifier' });
      return Response.json({ access_token: access, refresh_token: 'committed', expires_in: 3600 }); };
    const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd() });
    const chosen = (await session.selectModel({})).models.find(model => model.provider === 'openai-codex');
    await session.selectModel({ query: chosen.provider + '/' + chosen.id }); const before = session.getStatus();
    const original = ModelRuntime.prototype.refresh; ModelRuntime.prototype.refresh = async () => { throw new Error('synthetic sync failure'); };
    const input = new PassThrough();
    try {
      const result = await runtime.authenticate({ provider: 'openai-codex', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write() {} } }, operation) } });
      let blocked; try { await session.prompt('MUST_NOT_SEND'); } catch (error) { blocked = error.message; }
      console.log(JSON.stringify({ result, before, after: session.getStatus(), blocked, fetches }));
    } finally { ModelRuntime.prototype.refresh = original; await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "saved-needs-refresh" });
  expect(result.after).toMatchObject({ provider: result.before.provider, model: result.before.model, auth: "unknown" });
  expect(result.after.blocked).toContain("needs local refresh");
  expect(result.blocked).toContain("do not repeat login");
  expect(result.fetches).toBe(3);
  expect(JSON.parse(await readFile(path.join(agent, "auth.json"), "utf8"))["openai-codex"].refresh).toBe("committed");
}, 30_000);

test("cancellation while polling prevents late provider completion from saving", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url');
    let release; const late = new Promise(resolve => { release = resolve; });
    globalThis.fetch = async input => { const url = String(input);
      if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'id', user_code: 'ABCD-EFGH', interval: 0 });
      if (url.endsWith('/deviceauth/token')) return late;
      return Response.json({ access_token: 'x.' + payload + '.x', refresh_token: 'LATE_SECRET', expires_in: 3600 }); };
    const runtime = new PiRuntime(); const input = new PassThrough(); let screen = '';
    try {
      const pending = runtime.authenticate({ provider: 'openai-codex', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text;
        if (text.includes('Waiting for authorization')) setImmediate(() => input.write('\\x1b'));
      } } }, operation) } });
      const result = await pending;
      release(Response.json({ authorization_code: 'late', code_verifier: 'late' })); await Bun.sleep(50);
      console.log(JSON.stringify({ result, safe: !screen.includes('LATE_SECRET') }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "cancelled", effect: "unknown" });
  expect(result.safe).toBe(true);
  expect(await Bun.file(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json")).text()).toBe("{}");
});

test("hostile device fields fail closed without saving or rendering controls", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    globalThis.fetch = async input => Response.json({ device_auth_id: 'synthetic-device', user_code: 'BAD\\x1b]0;TITLE\\x07', interval: 0 });
    const runtime = new PiRuntime(); const input = new PassThrough(); let screen = '';
    try {
      const result = await runtime.authenticate({ provider: 'openai-codex', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text;
      } } }, operation) } });
      console.log(JSON.stringify({ result, screen }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "failed", effect: "unknown", reason: "provider" });
  expect(result.screen).not.toContain("TITLE");
  expect(await Bun.file(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json")).text()).toBe("{}");
});

// POSIX file modes and symlink denial; Windows has no 0o644 mode to preserve.
posixOnly("unsafe auth files fail before network without repairing modes or following links", async () => {
  for (const kind of ["mode", "hardlink", "symlink"] as const) {
    const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR; await mkdir(agent, { recursive: true });
    const auth = path.join(agent, "auth.json"); const other = path.join(f.root, "other.json");
    await writeFile(other, "{}", { mode: kind === "mode" ? 0o644 : 0o600 });
    if (kind === "hardlink") await link(other, auth);
    else if (kind === "symlink") await symlink(other, auth);
    else await writeFile(auth, "{}", { mode: 0o644 });
    const output = await f.run(`
      import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))}; import { PassThrough } from 'node:stream';
      let fetches = 0; globalThis.fetch = async () => { fetches++; throw new Error('NETWORK_FORBIDDEN'); };
      const runtime = new PiRuntime(); const input = new PassThrough();
      try { const result = await runtime.authenticate({ provider: 'openai-codex', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write() {} } }, operation) } });
        console.log(JSON.stringify({ result, fetches })); } finally { await runtime.dispose(); input.destroy(); }
    `);
    expect(JSON.parse(output)).toMatchObject({ result: { status: "failed", effect: "none", reason: "destination" }, fetches: 0 });
    expect(JSON.parse(output).result.detail).toContain(JSON.stringify(auth));
    if (kind === "mode") expect((await stat(auth)).mode & 0o777).toBe(0o644);
    expect(await readFile(other, "utf8")).toBe("{}");
  }
});

// Symlinked ancestors of HOME (macOS /tmp, ostree /home -> var/home) are canonicalized, not refused.
posixOnly("login saves through a symlinked HOME ancestor", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, "real")); await symlink(path.join(f.root, "real"), path.join(f.root, "alias"));
  const agent = path.join(f.root, "alias", "home", ".pi", "agent"); f.env.PI_CODING_AGENT_DIR = agent;
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))}; import { PassThrough } from 'node:stream';
    globalThis.fetch = async (input) => { if (String(input) === 'https://api.anthropic.com/v1/models') return Response.json({}); throw new Error('NETWORK_FORBIDDEN'); };
    const runtime = new PiRuntime(); const input = new PassThrough();
    try {
      const result = await runtime.authenticate({ provider: 'anthropic', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        if (text.includes('Type a number')) setImmediate(() => input.write('\\r'));
        if (text.includes('Private API key')) setImmediate(() => { input.write('\\x1b[200~synthetic-private-key\\x1b[201~'); setTimeout(() => input.write('\\r'), 20); });
      } } }, operation) } });
      console.log(JSON.stringify(result));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  expect(JSON.parse(output)).toEqual({ status: "saved" });
  expect(JSON.parse(await readFile(path.join(f.root, "real", "home", ".pi", "agent", "auth.json"), "utf8"))).toEqual({ anthropic: { type: "api_key", key: "synthetic-private-key" } });
});

// The credential directory Casper controls stays strict, and the refusal names it before any picker or consent.
posixOnly("an unsafe credential directory is refused before provider choice with the offending path", async () => {
  const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR;
  await mkdir(path.join(f.root, "elsewhere")); await mkdir(path.dirname(agent), { recursive: true }); await symlink(path.join(f.root, "elsewhere"), agent);
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    let runs = 0; const runtime = new PiRuntime();
    try { const result = await runtime.authenticate({ terminalHost: { async run() { runs++; throw new Error('MUST_NOT_RUN'); } } }); console.log(JSON.stringify({ result, runs })); } finally { await runtime.dispose(); }
  `);
  const parsed = JSON.parse(output);
  expect(parsed).toMatchObject({ result: { status: "failed", effect: "none", reason: "destination" }, runs: 0 });
  expect(parsed.result.detail).toContain(JSON.stringify(agent));
  expect(parsed.result.detail).toContain("symbolic link");
  expect(await Bun.file(path.join(f.root, "elsewhere", "auth.json")).exists()).toBe(false);
});

flakyOn("win32")("CASPER_TUI_WRITE_LOG refuses login before terminal or auth ownership", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    process.env.CASPER_TUI_WRITE_LOG = '/tmp/must-not-log-device-code'; let runs = 0;
    const runtime = new PiRuntime(); try { const result = await runtime.authenticate({ provider: 'openai-codex', terminalHost: { async run() { runs++; throw new Error('MUST_NOT_RUN'); } } }); console.log(JSON.stringify({ result, runs })); } finally { await runtime.dispose(); }
  `);
  expect(JSON.parse(output)).toEqual({ result: { status: "failed", effect: "none", reason: "unavailable", detail: "CASPER_TUI_WRITE_LOG is set" }, runs: 0 });
  expect(await Bun.file(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json")).exists()).toBe(false);
}, 60_000);

flakyOn("win32")("CASPER_OAUTH_CALLBACK_HOST cannot expose browser sign-in on a public listener", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    process.env.CASPER_OAUTH_CALLBACK_HOST = '0.0.0.0';
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error('NETWORK_FORBIDDEN'); };
    const runtime = new PiRuntime(); const input = new PassThrough(); let chosen = false;
    try {
      const result = await runtime.authenticate({ provider: 'anthropic', terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        if (!chosen && text.includes('Type a number')) { chosen = true; setImmediate(() => input.write('\\x1b[B\\r')); }
        if (text.includes('Private authorization')) setImmediate(() => input.write('\\x1b'));
      } } }, operation) } });
      console.log(JSON.stringify({ result, requests }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  expect(JSON.parse(output)).toEqual({ result: { status: "failed", effect: "none", reason: "unavailable" }, requests: 0 });
}, 60_000);

// python3 runs the standard-library PTY fixture; Windows has no equivalent here.
posixOnly("production CLI owns device-code input safely in a real terminal", async () => {
  const f = await fixture();
  const { exit, stdout, stderr } = await runPtyFixture("login-pty.py", [f.root]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("LOGIN PTY PASS");
}, PTY_TEST_MS);

posixOnly("production CLI keeps multi-provider secrets private in a real terminal", async () => {
  const f = await fixture();
  const { exit, stdout, stderr } = await runPtyFixture("multi-login-pty.py", [f.root]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("MULTI LOGIN PTY PASS");
}, PTY_TEST_MS);

test("plain login arguments stay local and never reflect supplied credential-like arguments", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { CasperApp } from ${JSON.stringify(path.join(repo, "src/app.ts"))};
    const app = new CasperApp({ runtimeFactory() { throw new Error('MUST_NOT_LOAD'); } });
    try { for (const command of ['/login', '/login openai-codex', '/login github-copilot', '/login anthropic', '/login openrouter', '/login secret-provider', '/login openai-codex SECRET_ARGUMENT']) await app.runOnce(command); }
    finally { await app.close(); }
  `);
  expect(output).toContain("Run casper and type /login");
  expect(output).toContain("Usage: /login [openai-codex|github-copilot|anthropic|openrouter]");
  expect(output).not.toContain("SECRET_ARGUMENT");
  expect(output).not.toContain("secret-provider");
  expect(await Bun.file(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json")).exists()).toBe(false);
});
