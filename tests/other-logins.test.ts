import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { copilotFromGithub, copilotTokenKind, findOtherLogins, otherLoginPaths, readOtherKey, saveCredential } from "../src/runtime/other-logins";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });
const repo = path.resolve(import.meta.dir, "..");
// The /login tests run the real sign-in flow in fresh Bun children, as tests/login.test.ts does.
setDefaultTimeout(30_000);

async function tempHome() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-other-logins-"))); roots.push(root);
  const home = path.join(root, "home"); await mkdir(home);
  return { root, home };
}
async function put(file: string, text: string) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text, { mode: 0o600 }); }
const ids = (env: Record<string, string>, signedIn: string[] = [], platform: NodeJS.Platform = "linux") =>
  findOtherLogins(new Set(signedIn), env, platform).map((login) => login.id);

test("nothing found in an empty home; each tool's sign-in is found from its own file, reading no secret to find it", async () => {
  const { home } = await tempHome();
  const env = { HOME: home };
  expect(ids(env)).toEqual([]);
  // Claude Code signed in with a plan (macOS keeps the token in the Keychain; the settings file names the account).
  await put(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "user@example.com" } }));
  expect(ids(env)).toEqual(["claude-code:own"]);
  // Linux and Windows keep the plan sign-in in .credentials.json.
  await put(path.join(home, ".claude.json"), "{}");
  await put(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic" } }));
  expect(ids(env)).toEqual(["claude-code:own"]);
  await put(path.join(home, ".claude.json"), JSON.stringify({ primaryApiKey: "sk-ant-synthetic" }));
  expect(ids(env)).toEqual(["claude-code:key"]);
  await put(path.join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-synthetic", tokens: { refresh_token: "synthetic" } }));
  await put(path.join(home, ".config", "gh", "hosts.yml"), "github.com:\n    user: someone\n    git_protocol: https\n");
  expect(ids(env)).toEqual(["claude-code:key", "codex:own", "codex:key", "gh:copilot"]);
  // A provider that already has a sign-in (saved or a key variable) is not offered again.
  expect(ids(env, ["anthropic", "openai-codex", "openai", "github-copilot"])).toEqual([]);
  // A Codex API-key sign-in has no plan tokens; a null key is no key.
  await put(path.join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: null }));
  expect(ids(env)).toEqual(["claude-code:key", "gh:copilot"]);
  // gh signed in only to another host offers nothing for Copilot.
  await put(path.join(home, ".config", "gh", "hosts.yml"), "ghe.example.com:\n    user: someone\n");
  expect(ids(env)).toEqual(["claude-code:key"]);
  // Broken files are nothing found, not a crash.
  await put(path.join(home, ".claude.json"), "{not json");
  expect(ids(env)).toEqual(["claude-code:own"]);
});

test("each tool's own folder setting wins, and Windows finds the files under %USERPROFILE% and %APPDATA%", async () => {
  const { root, home } = await tempHome();
  const claude = path.join(root, "claude"); const codex = path.join(root, "codex"); const gh = path.join(root, "gh");
  expect(otherLoginPaths({ HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, GH_CONFIG_DIR: gh })).toEqual({
    claudeCredentials: path.join(claude, ".credentials.json"), claudeConfig: path.join(claude, ".claude.json"),
    codexAuth: path.join(codex, "auth.json"), ghHosts: path.join(gh, "hosts.yml") });
  expect(otherLoginPaths({ HOME: home, XDG_CONFIG_HOME: path.join(root, "xdg") }).ghHosts).toBe(path.join(root, "xdg", "gh", "hosts.yml"));
  const appData = path.join(root, "AppData");
  const windows = otherLoginPaths({ USERPROFILE: home, APPDATA: appData }, "win32");
  expect(windows).toEqual({ claudeCredentials: path.join(home, ".claude", ".credentials.json"), claudeConfig: path.join(home, ".claude.json"),
    codexAuth: path.join(home, ".codex", "auth.json"), ghHosts: path.join(appData, "GitHub CLI", "hosts.yml") });
  await put(windows.ghHosts, "github.com:\r\n    user: someone\r\n");
  await put(windows.codexAuth, JSON.stringify({ OPENAI_API_KEY: "sk-synthetic" }));
  expect(ids({ USERPROFILE: home, APPDATA: appData }, [], "win32")).toEqual(["codex:key", "gh:copilot"]);
});

test("a key is read only when picked, and only a plain one-line key", async () => {
  const { home } = await tempHome();
  await put(path.join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: " sk-synthetic \n" }));
  const [login] = findOtherLogins(new Set(), { HOME: home }, "linux");
  expect(readOtherKey(login!, { HOME: home }, "linux")).toBe("sk-synthetic");
  await put(path.join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "two words" }));
  expect(readOtherKey(login!, { HOME: home }, "linux")).toBeUndefined();
});

test("Copilot takes gh's own sign-in and fine-grained tokens, never a classic one", () => {
  expect(copilotTokenKind("gho_" + "a".repeat(36))).toBe("ok");
  expect(copilotTokenKind("github_pat_" + "a".repeat(60))).toBe("ok");
  expect(copilotTokenKind("ghu_" + "a".repeat(36))).toBe("ok");
  expect(copilotTokenKind("ghp_" + "a".repeat(36))).toBe("classic");
  expect(copilotTokenKind("something else")).toBe("unknown");
});

test("the Copilot exchange keeps the GitHub token as it is and never shows GitHub's words", async () => {
  const real = globalThis.fetch;
  const seen: string[] = [];
  const access = "tid=synthetic;proxy-ep=proxy.individual.githubcopilot.com";
  const api = "https://api.individual.githubcopilot.com";
  try {
    // Like Pi's own sign-in: exchange, read the model list, turn on "unconfigured" models Pi knows, save what is usable.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${init?.method ?? "GET"} ${url} ${(init!.headers as Record<string, string>).Authorization}`);
      if (url === "https://api.github.com/copilot_internal/v2/token") return Response.json({ token: access, expires_at: 2_000_000_000 });
      if (url === `${api}/models`) return Response.json({ data: [
        { id: "gpt-5.5", model_picker_enabled: true, policy: { state: "enabled" } },
        { id: "claude-haiku-4.5", model_picker_enabled: true, policy: { state: "unconfigured" } },
        { id: "unknown-to-pi", model_picker_enabled: true, policy: { state: "unconfigured" } },
        { id: "grok-4.5", model_picker_enabled: true, policy: { state: "disabled" } }] });
      if (url === `${api}/models/claude-haiku-4.5/policy` && init?.method === "POST") return Response.json({});
      throw new Error("NETWORK_FORBIDDEN");
    }) as typeof fetch;
    const ok = await copilotFromGithub("gho_synthetic", AbortSignal.timeout(5_000));
    expect(ok).toEqual({ ok: true, credential: { type: "oauth", refresh: "gho_synthetic", access, expires: 2_000_000_000_000 - 300_000,
      availableModelIds: ["gpt-5.5", "claude-haiku-4.5", "unknown-to-pi"] } });
    expect(seen).toEqual([`GET https://api.github.com/copilot_internal/v2/token Bearer gho_synthetic`,
      `GET ${api}/models Bearer ${access}`, `POST ${api}/models/claude-haiku-4.5/policy Bearer ${access}`]);
    globalThis.fetch = (async () => new Response("secret-looking provider text", { status: 404 })) as unknown as typeof fetch;
    const refused = await copilotFromGithub("gho_synthetic", AbortSignal.timeout(5_000));
    expect(refused).toEqual({ ok: false, detail: "GitHub didn't give GitHub CLI's sign-in Copilot access (HTTP 404); pick Sign in separately" });
    // A model list Copilot won't give is a plain failure: nothing is saved, no provider text.
    globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith("/v2/token")
      ? Response.json({ token: access, expires_at: 2_000_000_000 }) : new Response("secret-looking provider text", { status: 500 })) as typeof fetch;
    expect(await copilotFromGithub("gho_synthetic", AbortSignal.timeout(5_000))).toEqual({ ok: false, detail: "Copilot didn't give its model list (HTTP 500); try again, or pick Sign in separately" });
  } finally { globalThis.fetch = real; }
});

test("turning on Copilot models stops at the first rate limit, as Pi's sign-in does", async () => {
  const real = globalThis.fetch;
  const posts: string[] = [];
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v2/token")) return Response.json({ token: "tid=synthetic", expires_at: 2_000_000_000 });
      if (url.endsWith("/models")) return Response.json({ data: ["claude-haiku-4.5", "gpt-5.4", "gpt-5.5"].map((id) => ({ id, model_picker_enabled: true, policy: { state: "unconfigured" } })) });
      posts.push(url);
      return url.includes("gpt-5.4/") ? new Response("", { status: 429 }) : Response.json({});
    }) as typeof fetch;
    const result = await copilotFromGithub("gho_synthetic", AbortSignal.timeout(5_000));
    expect(posts).toEqual(["https://api.individual.githubcopilot.com/models/claude-haiku-4.5/policy", "https://api.individual.githubcopilot.com/models/gpt-5.4/policy"]);
    expect(result.ok && result.credential.availableModelIds).toEqual(["claude-haiku-4.5", "gpt-5.4", "gpt-5.5"]);
  } finally { globalThis.fetch = real; }
});

test("saving keeps other providers, makes a new file private, waits on Pi's lock and never quotes a broken file", async () => {
  const { home } = await tempHome();
  const file = path.join(home, ".casper", "agent", "auth.json");
  await saveCredential(file, "openai", { type: "api_key", key: "sk-synthetic" }, AbortSignal.timeout(5_000));
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  await writeFile(file, JSON.stringify({ keep: { type: "api_key", key: "keep" } }));
  await saveCredential(file, "openai", { type: "api_key", key: "sk-synthetic" }, AbortSignal.timeout(5_000));
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ keep: { type: "api_key", key: "keep" }, openai: { type: "api_key", key: "sk-synthetic" } });
  await mkdir(`${file}.lock`);
  await expect(saveCredential(file, "openai", { type: "api_key", key: "x" }, AbortSignal.timeout(10_000))).rejects.toThrow("another Casper is saving a sign-in; try again");
  await removeTempDir(`${file}.lock`);
  await writeFile(file, "sk-private-text-not-json");
  const error = await saveCredential(file, "openai", { type: "api_key", key: "x" }, AbortSignal.timeout(5_000)).catch((caught: Error) => caught);
  expect(String(error)).not.toContain("sk-private");
  expect(await readFile(file, "utf8")).toBe("sk-private-text-not-json");
});

/** /login in a fresh Bun child with a temporary home, answering each screen as it appears. */
async function login(home: string, root: string, answers: Record<string, string>, options = "", fetchBody = "throw new Error('NETWORK_FORBIDDEN');", extraEnv: Record<string, string> = {}) {
  const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true });
  const env = { ...isolatedEnvironment(home), TMPDIR: root, PI_CODING_AGENT_DIR: agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0",
    SSH_CONNECTION: "synthetic 1 synthetic 2", ...extraEnv };
  const body = `import { withLoginSurface } from ${JSON.stringify(path.join(repo, "tests/support/login-surface.ts"))};
    import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { PassThrough } from 'node:stream';
    const calls = [];
    globalThis.fetch = async (input, init) => { const url = String(input); calls.push(url); ${fetchBody} };
    const answers = ${JSON.stringify(answers)};
    const runtime = new PiRuntime(); const input = new PassThrough(); let screen = '';
    try {
      const result = await runtime.authenticate({ ${options} terminalHost: { run: operation => withLoginSurface({ input, color: false, onEOF() {}, output: { write(text) {
        screen += text;
        for (const [shown, key] of Object.entries(answers)) if (text.includes(shown)) { delete answers[shown]; setImmediate(() => input.write(key)); }
      } } }, operation) } });
      console.log(JSON.stringify({ result, screen: Bun.stripANSI(screen).replace(/[│\\s]+/g, " "), calls }));
    } finally { await runtime.dispose(); input.destroy(); }`;
  const child = Bun.spawn([process.execPath, "-e", body], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    return { ...JSON.parse(stdout) as { result: unknown; screen: string; calls: string[] }, auth: path.join(agent, "auth.json") };
  } finally { clearTimeout(timer); }
}

test("/login offers Codex CLI's API key first: 1 uses it after OpenAI accepts it, and the key never reaches the screen", async () => {
  const { root, home } = await tempHome();
  await put(path.join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-synthetic-codex-key", tokens: null }));
  const run = await login(home, root, { "Found a Codex CLI sign-in on this computer": "1" }, "",
    "if (url === 'https://api.openai.com/v1/models' && init.headers.authorization === 'Bearer sk-synthetic-codex-key') return Response.json({ data: [] }); throw new Error('NETWORK_FORBIDDEN');");
  expect(run.result).toEqual({ status: "saved" });
  expect(run.screen).toContain("1 Codex CLI · use its OpenAI API key 2 Sign in separately 3 Not now");
  expect(run.screen).not.toContain("sk-synthetic-codex-key");
  expect(run.calls).toEqual(["https://api.openai.com/v1/models"]);
  expect(JSON.parse(await readFile(run.auth, "utf8"))).toEqual({ openai: { type: "api_key", key: "sk-synthetic-codex-key" } });
  // Codex's own file is untouched.
  expect(JSON.parse(await readFile(path.join(home, ".codex", "auth.json"), "utf8"))).toEqual({ OPENAI_API_KEY: "sk-synthetic-codex-key", tokens: null });
});

test("a refused key is not saved and the reason is plain words; Not now saves nothing; Sign in separately opens the usual list", async () => {
  const { root, home } = await tempHome();
  await put(path.join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-synthetic-codex-key" }));
  const refused = await login(home, root, { "Found a Codex CLI sign-in": "1" }, "", "return new Response('provider words', { status: 401 });");
  expect(refused.result).toEqual({ status: "failed", effect: "none", reason: "provider", detail: "OpenAI refused Codex CLI's key (HTTP 401)" });
  const later = await login(home, root, { "Found a Codex CLI sign-in": "3" });
  expect(later.result).toEqual({ status: "cancelled", effect: "none" });
  const separately = await login(home, root, { "Found a Codex CLI sign-in": "2", "OpenRouter · paste an API key": "\x1b" });
  expect(separately.screen).toContain("1 OpenRouter · paste an API key");
  expect(separately.result).toEqual({ status: "cancelled", effect: "none" });
  const saved = await readFile(refused.auth, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>, () => ({} as Record<string, unknown>));
  expect(saved.openai).toBeUndefined();
});

test("Claude Code's plan sign-in is never copied: picking it starts Casper's own Claude sign-in", async () => {
  const { root, home } = await tempHome();
  await put(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" } }));
  const run = await login(home, root, { "Found a Claude Code sign-in on this computer": "1", "API use is billed per token": "\x1b" }, "provider: 'anthropic',");
  expect(run.screen).toContain("1 Claude Code · sign in to the same Claude account here 2 Sign in separately 3 Not now");
  expect(run.screen).toContain("A plan sign-in is not copied: sharing it would sign the other tool out.");
  // Casper's own sign-in starts (claude.ai's page), never a copy of Claude Code's tokens.
  expect(run.screen).toContain("https://claude.ai/oauth/authorize");
  expect(run.screen).not.toContain("synthetic-");
  expect(run.result).toMatchObject({ status: "cancelled" });
});

test("with the setting off, or a sign-in already there, /login shows only its own list", async () => {
  const { root, home } = await tempHome();
  await put(path.join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-synthetic" }));
  const off = await login(home, root, { "OpenRouter · paste an API key": "\x1b" }, "others: false,");
  expect(off.screen).not.toContain("Found");
  const keyed = await login(home, root, { "OpenRouter · paste an API key": "\x1b" }, "", undefined, { OPENAI_API_KEY: "sk-env" });
  expect(keyed.screen).not.toContain("Found");
});

posixOnly("GitHub CLI's sign-in is exchanged for Copilot the way Pi's own sign-in is, and gh keeps its token", async () => {
  const { root, home } = await tempHome();
  await put(path.join(home, ".config", "gh", "hosts.yml"), "github.com:\n    user: someone\n");
  const bin = path.join(root, "bin"); await mkdir(bin);
  const token = "gho_" + "s".repeat(36);
  await writeFile(path.join(bin, "gh"), `#!/bin/sh\n[ "$*" = "auth token --hostname github.com" ] && [ -z "$GH_TOKEN" ] && echo ${token} && exit 0\nexit 1\n`);
  await chmod(path.join(bin, "gh"), 0o755);
  const run = await login(home, root, { "Found a GitHub CLI sign-in on this computer": "1" }, "provider: 'github-copilot',",
    `if (url === 'https://api.github.com/copilot_internal/v2/token' && init.headers.Authorization === 'Bearer ${token}') return Response.json({ token: 'tid=synthetic', expires_at: 2000000000 });
    if (url === 'https://api.individual.githubcopilot.com/models') return Response.json({ data: [{ id: 'claude-haiku-4.5', model_picker_enabled: true, policy: { state: 'unconfigured' } }] });
    if (url === 'https://api.individual.githubcopilot.com/models/claude-haiku-4.5/policy' && init.method === 'POST') return Response.json({});
    throw new Error('NETWORK_FORBIDDEN');`,
    { PATH: `${bin}:${process.env.PATH ?? ""}`, GH_TOKEN: "ghp_ignored" });
  expect(run.result).toEqual({ status: "saved" });
  expect(run.screen).not.toContain(token);
  // The same note Pi's own Copilot sign-in shows before it turns models on.
  expect(run.screen).toContain("Using it may turn on model policies on your GitHub account.");
  expect(run.calls).toEqual(["https://api.github.com/copilot_internal/v2/token", "https://api.individual.githubcopilot.com/models",
    "https://api.individual.githubcopilot.com/models/claude-haiku-4.5/policy"]);
  expect(JSON.parse(await readFile(run.auth, "utf8"))["github-copilot"]).toEqual({ type: "oauth", refresh: token, access: "tid=synthetic", expires: 2_000_000_000_000 - 300_000,
    availableModelIds: ["claude-haiku-4.5"] });
});
