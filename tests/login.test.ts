import { afterEach, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { posixOnly } from "./support/platform";
import { isolatedEnvironment } from "../src/platform/environment";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const repo = path.resolve(import.meta.dir, "..");

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-login-"))); roots.push(root);
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(project);
  const env = { ...isolatedEnvironment(home), TMPDIR: root, PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  async function run(body: string, args: string[] = []) {
    const child = Bun.spawn([process.execPath, "-e", body, ...args], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      return stdout;
    } finally { clearTimeout(timer); }
  }
  return { root, home, project, env, run };
}

test("API-key login keeps secrets off screen and preserves unrelated credentials", async () => {
  for (const provider of ["anthropic", "openrouter"]) {
    const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR;
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(agent, "auth.json"), JSON.stringify({ unrelated: { type: "api_key", key: "keep" } }), { mode: 0o600 });
    const output = await f.run(`
      import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
      import { PassThrough } from 'node:stream';
      globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
      const runtime = new PiRuntime(); const input = new PassThrough(); let screen = '';
      try {
        const result = await runtime.authenticate({ provider: ${JSON.stringify(provider)}, terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) {
          screen += text;
          if (text.includes('Choose sign-in method')) setImmediate(() => input.write('\\r'));
          if (text.includes('Press Y')) setImmediate(() => input.write('Y'));
          if (text.includes('Private API key')) setImmediate(() => { input.write('\\x1b[200~synthetic-private-key\\x1b[201~'); setTimeout(() => input.write('\\r'), 20); });
        } } }) } });
        console.log(JSON.stringify({ result, screen }));
      } finally { await runtime.dispose(); input.destroy(); }
    `);
    const result = JSON.parse(output);
    expect(result.result).toEqual({ status: "saved" });
    expect(result.screen).not.toContain("synthetic-private-key");
    expect(JSON.parse(await readFile(path.join(agent, "auth.json"), "utf8"))).toEqual({ unrelated: { type: "api_key", key: "keep" }, [provider]: { type: "api_key", key: "synthetic-private-key" } });
    expect(await Bun.file(path.join(agent, "sessions")).exists()).toBe(false);
  }
});

test("Copilot device login discloses account policy changes and saves only Copilot", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    const calls = []; let consent = false; let screen = '';
    globalThis.fetch = async (input, init) => {
      if (!consent) throw new Error('TRANSPORT_BEFORE_CONSENT');
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
      const result = await runtime.authenticate({ provider: 'github-copilot', terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text; if (text.includes('Press Y')) setImmediate(() => { consent = true; input.write('Y'); });
      } } }) } });
      console.log(JSON.stringify({ result, screen, calls }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "saved" });
  expect(result.screen).toContain("enable model policies");
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
});

test("browser sign-in completes through private manual input or real loopback callback and releases listeners", async () => {
  for (const provider of ["anthropic", "openrouter"]) for (const mode of ["manual", "callback", "cancel"]) {
    const f = await fixture();
    const output = await f.run(`
      import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
      import { PassThrough } from 'node:stream'; import { get, createServer } from 'node:http';
      const provider = ${JSON.stringify(provider)}; const mode = ${JSON.stringify(mode)};
      let screen = ''; let authUrl; let callbackUrl; let exchanges = 0; let callbackWork;
      globalThis.fetch = async (input, init) => {
        const url = String(input); const body = JSON.parse(init.body);
        if (url !== (provider === 'anthropic' ? 'https://platform.claude.com/v1/oauth/token' : 'https://openrouter.ai/api/v1/auth/keys')) throw new Error('UNEXPECTED_NETWORK');
        if (body.code !== 'synthetic-private-code' || !body.code_verifier) throw new Error('INVALID_EXCHANGE');
        exchanges++;
        return Response.json(provider === 'anthropic' ? { access_token: 'synthetic-private-access', refresh_token: 'synthetic-private-refresh', expires_in: 3600 } : { key: 'synthetic-private-access' });
      };
      const runtime = new PiRuntime(); const input = new PassThrough();
      try {
        const result = await runtime.authenticate({ provider, terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) {
          screen += text;
          if (text.includes('Choose sign-in method')) setImmediate(() => { input.write('\\x1b[B'); setTimeout(() => input.write('\\r'), 20); });
          if (text.includes('Press Y')) setImmediate(() => input.write('Y'));
          if (text.startsWith('1. Open this URL in your browser:')) {
            authUrl = new URL(text.split('\\n')[1]);
            callbackUrl = new URL(authUrl.searchParams.get(provider === 'anthropic' ? 'redirect_uri' : 'callback_url'));
          }
          if (text.includes('Private authorization code')) setImmediate(() => {
            if (mode === 'cancel') { input.write('\\x1b'); return; }
            if (mode === 'manual') { input.write('\\x1b[200~synthetic-private-code\\x1b[201~'); setTimeout(() => input.write('\\r'), 20); return; }
            const url = new URL(callbackUrl); url.hostname = '127.0.0.1'; url.searchParams.set('code', 'synthetic-private-code');
            if (provider === 'anthropic') url.searchParams.set('state', authUrl.searchParams.get('state'));
            callbackWork = new Promise((resolve, reject) => { get(url, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject); });
          });
        } } }) } });
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
}, 30_000);

test("private key entry rejects executable syntax, multiline and oversized unfinished pastes without saving", async () => {
  for (const key of ["!touch SHOULD_NOT_EXIST", "!id", "$SECRET_ENV", "line1\nline2", "x".repeat(40_000)]) {
    const f = await fixture();
    const output = await f.run(`
      import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))}; import { PassThrough } from 'node:stream';
      const input = new PassThrough(); const runtime = new PiRuntime(); let screen = '';
      globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
      try {
        const result = await runtime.authenticate({ provider: 'anthropic', terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) {
          screen += text;
          if (text.includes('Choose sign-in method')) setImmediate(() => input.write('\\r'));
          if (text.includes('Press Y')) setImmediate(() => input.write('Y'));
          if (text.includes('Private API key')) setImmediate(() => { input.write('\\x1b[200~' + ${JSON.stringify(key)} + ${key.length > 8192 ? "''" : "'\\x1b[201~'"}); setTimeout(() => input.write('\\r'), 20); });
        } } }) } });
        console.log(JSON.stringify({ result, safe: !screen.includes('SHOULD_NOT_EXIST') && !screen.includes('SECRET_ENV') && !screen.includes('line1') }));
      } finally { await runtime.dispose(); input.destroy(); }
    `);
    const result = JSON.parse(output);
    expect(["failed", "cancelled"]).toContain(result.result.status);
    expect(result.safe).toBe(true);
    expect(JSON.parse(await readFile(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8"))).toEqual({});
    expect(await Bun.file(path.join(f.project, "SHOULD_NOT_EXIST")).exists()).toBe(false);
  }
}, 25_000);

test("unsafe browser callback overrides fail before storage or provider transport", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))}; import { PassThrough } from 'node:stream';
    process.env.PI_OAUTH_CALLBACK_HOST = '0.0.0.0';
    globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
    const runtime = new PiRuntime(); const input = new PassThrough();
    try {
      const result = await runtime.authenticate({ provider: 'openrouter', terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) {
        if (text.includes('Choose sign-in method')) setImmediate(() => { input.write('\\x1b[B'); setTimeout(() => input.write('\\r'), 20); });
        if (text.includes('Press Y')) setImmediate(() => input.write('Y'));
      } } }) } }); console.log(JSON.stringify(result));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  expect(JSON.parse(output)).toEqual({ status: "failed", effect: "none", reason: "unavailable" });
  expect(await Bun.file(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json")).exists()).toBe(false);
});

test("API-key replacement refreshes the selected non-Codex parent without changing its conversation selection", async () => {
  const f = await fixture(); const agent = f.env.PI_CODING_AGENT_DIR;
  await mkdir(agent, { recursive: true });
  await writeFile(path.join(agent, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "synthetic-old" } }), { mode: 0o600 });
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))}; import { PassThrough } from 'node:stream';
    globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
    const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd() });
    const model = (await session.selectModel({})).models.find(item => item.provider === 'anthropic');
    await session.selectModel({ query: model.provider + '/' + model.id });
    const before = session.getStatus(); const input = new PassThrough();
    try {
      const result = await runtime.authenticate({ provider: 'anthropic', terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) {
        if (text.includes('Choose sign-in method')) setImmediate(() => input.write('\\r'));
        if (text.includes('Press Y')) setImmediate(() => input.write('Y'));
        if (text.includes('Private API key')) setImmediate(() => { input.write('synthetic-new'); setTimeout(() => input.write('\\r'), 20); });
      } } }) } }); console.log(JSON.stringify({ result, before, after: session.getStatus() }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "saved" });
  expect(result.after).toMatchObject({ provider: "anthropic", model: result.before.model, selectionSource: result.before.selectionSource, auth: "configured" });
  expect(JSON.parse(await readFile(path.join(agent, "auth.json"), "utf8")).anthropic.key).toBe("synthetic-new");
});

test("provider refusal and occupied browser port expose no diagnostics and preserve existing credentials", async () => {
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
        const result = await runtime.authenticate({ provider: 'anthropic', terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) {
          screen += text;
          if (text.includes('Choose sign-in method')) setImmediate(() => { input.write('\\x1b[B'); setTimeout(() => input.write('\\r'), 20); });
          if (text.includes('Press Y')) setImmediate(() => input.write('Y'));
          if (text.includes('Private authorization code')) setImmediate(() => { input.write('private-code'); setTimeout(() => input.write('\\r'), 20); });
        } } }) } }); console.log(JSON.stringify({ result, calls, safe: !screen.includes('PRIVATE_PROVIDER_DIAGNOSTIC') && !screen.includes('private-code') }));
      } finally { await runtime.dispose(); input.destroy(); if (occupied) await new Promise(resolve => server.close(resolve)); }
    `);
    const result = JSON.parse(output);
    expect(result.result.status).toBe("failed");
    expect(result.calls).toBe(occupied ? 0 : 1);
    expect(result.safe).toBe(true);
    expect(await readFile(path.join(agent, "auth.json"), "utf8")).toBe(original);
  }
});

test("cancelling between provider selection and consent is cancellation, not login failure", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))}; import { PassThrough } from 'node:stream';
    const runtime = new PiRuntime(); const input = new PassThrough();
    try {
      const result = await runtime.authenticate({ terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) {
        if (text.includes('Choose provider')) setImmediate(() => { input.write('\\r'); queueMicrotask(() => input.write('\\x03')); });
      } } }) } }); console.log(JSON.stringify(result));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  expect(JSON.parse(output)).toEqual({ status: "cancelled", effect: "none" });
  expect(await Bun.file(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json")).exists()).toBe(false);
});

test("runtime login cancellation before consent never creates auth or starts a session", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    const runtime = new PiRuntime(); const input = new PassThrough(); let screen = '';
    globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
    try {
      const result = await runtime.authenticate({ provider: 'openai-codex', terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text; if (text.includes('Press Y')) setTimeout(() => input.write('\\x1b'), 0);
      } } }) } });
      console.log(JSON.stringify({ result, screen }));
    } finally { await runtime.dispose(); input.destroy(); }
  `);
  const result = JSON.parse(output);
  expect(result.result).toEqual({ status: "cancelled", effect: "none" });
  const consent = Bun.stripANSI(result.screen).split(/\r?\n/).map(line => line.replace(/^│\s?|\s?│$/g, "").trim()).join("");
  expect(consent).toContain(f.env.PI_CODING_AGENT_DIR + "/auth.json");
  expect(await Bun.file(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json")).exists()).toBe(false);
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
      const result = await runtime.authenticate({ provider: 'openai-codex', terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text;
        if (text.includes('Press Y')) setImmediate(() => input.write('Y'));
      } } }) } });
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
      const result = await runtime.authenticate({ provider: 'openai-codex', terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) { if (text.includes('Press Y')) setImmediate(() => input.write('Y')); } } }) } });
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
});

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
      const pending = runtime.authenticate({ provider: 'openai-codex', terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text; if (text.includes('Press Y')) setImmediate(() => input.write('Y'));
        if (text.includes('Waiting for authorization')) setImmediate(() => input.write('\\x1b'));
      } } }) } });
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
      const result = await runtime.authenticate({ provider: 'openai-codex', terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text; if (text.includes('Press Y')) setImmediate(() => input.write('Y'));
      } } }) } });
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
      try { const result = await runtime.authenticate({ provider: 'openai-codex', terminalHost: { run: operation => operation({ input, color: false, onEOF() {}, output: { write(text) { if (text.includes('Press Y')) setImmediate(() => input.write('Y')); } } }) } });
        console.log(JSON.stringify({ result, fetches })); } finally { await runtime.dispose(); input.destroy(); }
    `);
    expect(JSON.parse(output)).toEqual({ result: { status: "failed", effect: "none", reason: "destination" }, fetches: 0 });
    if (kind === "mode") expect((await stat(auth)).mode & 0o777).toBe(0o644);
    expect(await readFile(other, "utf8")).toBe("{}");
  }
});

test("raw TUI logging refuses login before terminal or auth ownership", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    process.env.PI_TUI_WRITE_LOG = '/tmp/must-not-log-device-code'; let runs = 0;
    const runtime = new PiRuntime(); try { const result = await runtime.authenticate({ provider: 'openai-codex', terminalHost: { async run() { runs++; throw new Error('MUST_NOT_RUN'); } } }); console.log(JSON.stringify({ result, runs })); } finally { await runtime.dispose(); }
  `);
  expect(JSON.parse(output)).toEqual({ result: { status: "failed", effect: "none", reason: "unavailable" }, runs: 0 });
  expect(await Bun.file(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json")).exists()).toBe(false);
});

// python3 runs the standard-library PTY fixture; Windows has no equivalent here.
posixOnly("production CLI owns device-code input safely in a real terminal", async () => {
  const f = await fixture();
  const child = Bun.spawn(["python3", path.join(repo, "tests/fixtures/login-pty.py"), process.execPath, f.root], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 35_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("LOGIN PTY PASS");
  } finally { clearTimeout(timer); child.kill(); }
}, 40_000);

posixOnly("production CLI keeps multi-provider secrets private in a real terminal", async () => {
  const f = await fixture();
  const child = Bun.spawn(["python3", path.join(repo, "tests/fixtures/multi-login-pty.py"), process.execPath, f.root], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 45_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("MULTI LOGIN PTY PASS");
  } finally { clearTimeout(timer); child.kill(); }
}, 50_000);

test("plain login arguments stay local and never reflect supplied credential-like arguments", async () => {
  const f = await fixture();
  const output = await f.run(`
    import { CasperApp } from ${JSON.stringify(path.join(repo, "src/app.ts"))};
    const app = new CasperApp({ runtimeFactory() { throw new Error('MUST_NOT_LOAD'); } });
    try { for (const command of ['/login', '/login openai-codex', '/login github-copilot', '/login anthropic', '/login openrouter', '/login secret-provider', '/login openai-codex SECRET_ARGUMENT']) await app.runOnce(command); }
    finally { await app.close(); }
  `);
  expect(output).toContain("device-code");
  expect(output).toContain("Usage: /login [openai-codex|github-copilot|anthropic|openrouter]");
  expect(output).not.toContain("SECRET_ARGUMENT");
  expect(output).not.toContain("secret-provider");
  expect(await Bun.file(path.join(f.env.PI_CODING_AGENT_DIR, "auth.json")).exists()).toBe(false);
});
