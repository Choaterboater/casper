import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkConfig, checkDisk, checkLanguageServers, checkMcp, checkNetworkServer, checkPathLink, checkSandbox, checkSignIn, checkVersion,
  type DoctorContext,
} from "../src/doctor/checks";
import { jsonErrorPosition } from "../src/doctor/json-position";
import { formatDoctorLines, runDoctor, type DoctorIO } from "../src/doctor/run";
import { lockedEntryPath } from "../src/security/install";
import { NETWORK_SERVER } from "../src/mcp/network/server";
import { removeTempDir } from "./support/temp-dir";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await removeTempDir(dir); });

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-doctor-"));
  temps.push(dir);
  await mkdir(path.join(dir, ".casper", "agent"), { recursive: true });
  return dir;
}

function context(homeDir: string, extra: Partial<DoctorContext> = {}): DoctorContext {
  return {
    homeDir, env: { PATH: path.join(homeDir, "bin") }, platform: process.platform, currentVersion: "0.2.22",
    install: { kind: "binary", executable: path.join(homeDir, "casper-install", "casper") }, agentDir: path.join(homeDir, ".casper", "agent"),
    fetch: async () => Response.json([]), freeBytes: async () => 50 * 1024 ** 3, sandboxProblem: () => undefined, ...extra,
  };
}

const releases = (...tags: string[]) => async () => Response.json(tags.map((tag) => ({ tag_name: tag, draft: false, assets: [] })));

test("jsonErrorPosition names the line and column where a JSON file goes wrong", () => {
  expect(jsonErrorPosition("{\n  \"a\": 1\n}\n")).toBeUndefined();
  expect(jsonErrorPosition("{\n  \"a\": 1,\n  b: 2\n}")).toEqual({ line: 3, column: 3 });
  expect(jsonErrorPosition("{\n  \"a\": [1, 2,]\n}")).toEqual({ line: 2, column: 14 });
  expect(jsonErrorPosition("{\"a\": 1} x")).toEqual({ line: 1, column: 10 });
  expect(jsonErrorPosition("")).toEqual({ line: 1, column: 1 });
});

test("version: a newer release is worth knowing and offers casper update; the same one is fine; offline is not checked", async () => {
  const dir = await home();
  expect(await checkVersion(context(dir, { fetch: releases("v0.2.22", "v0.2.21") }))).toEqual([{ status: "ok", text: "Casper 0.2.22, the newest release" }]);
  const newer = await checkVersion(context(dir, { fetch: releases("v0.2.23-rc.1", "v0.2.22") }));
  expect(newer[0]).toMatchObject({ status: "note", fix: "update", next: "casper update" });
  expect(newer[0]!.text).toContain("0.2.23-rc.1 is out (you have 0.2.22)");
  const offline = await checkVersion(context(dir, { env: { CASPER_OFFLINE: "1" }, fetch: () => { throw new Error("no network in this test"); } }));
  expect(offline[0]!.text).toContain("not checked (CASPER_OFFLINE=1)");
});

test.skipIf(process.platform === "win32")("casper on PATH: a broken link is something to fix, this program is fine", async () => {
  const dir = await home();
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(dir, "casper-install"), { recursive: true });
  const program = path.join(dir, "casper-install", "casper");
  await writeFile(program, "#!/bin/sh\n", { mode: 0o755 });
  await symlink(path.join(dir, "gone", "casper"), path.join(bin, "casper"));
  const broken = await checkPathLink(context(dir));
  expect(broken[0]).toMatchObject({ status: "fail" });
  expect(broken[0]!.text).toContain("is a link to a Casper that is gone");

  const good = path.join(dir, "bin2");
  await mkdir(good);
  await symlink(program, path.join(good, "casper"));
  const fine = await checkPathLink(context(dir, { env: { PATH: good } }));
  expect(fine).toEqual([{ status: "ok", text: "casper on PATH is this one (~/bin2/casper)" }]);
});

test.skipIf(process.platform === "win32")("casper on PATH: an older copy is something to fix", async () => {
  const dir = await home();
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "casper"), "#!/bin/sh\necho 'casper 0.2.10 (/opt/old/casper)'\n", { mode: 0o755 });
  const lines = await checkPathLink(context(dir));
  expect(lines[0]).toMatchObject({ status: "fail" });
  expect(lines[0]!.text).toContain("an older copy: 0.2.10");
}, 30_000);

test("config: a file that doesn't parse is named with its line; a bad setting is named too", async () => {
  const dir = await home();
  await writeFile(path.join(dir, ".casper", "config.yaml"), "display: quiet\nweb: [\n  a: b: c\n");
  await writeFile(path.join(dir, ".casper", "mcp.json"), "{\n  \"mcpServers\": {\n    \"x\": { \"command\": \"y\", }\n  }\n}\n");
  const { lines } = await checkConfig(context(dir));
  const text = formatDoctorLines(lines);
  expect(text).toContain("✗ ~/.casper/config.yaml doesn't load: line 3");
  expect(text).toContain("✗ ~/.casper/mcp.json doesn't load: line 3, column 28: not valid JSON");

  const other = await home();
  await writeFile(path.join(other, ".casper", "config.yaml"), "showPages: sometimes\n");
  const bad = await checkConfig(context(other));
  expect(bad.lines[0]).toMatchObject({ status: "fail" });
  expect(bad.lines[0]!.text).toContain("showPages must be");

  const fine = await checkConfig(context(await home()));
  expect(fine.lines).toEqual([{ status: "ok", text: "Config files load" }]);
});

test("sign-in: none is something to fix; a self-renewing sign-in is fine; an expired one without renewal is named", async () => {
  const dir = await home();
  expect(await checkSignIn(context(dir))).toEqual([{ status: "fail", text: "No model sign-in", next: "run casper and type /login, or start a model server such as Ollama" }]);
  await writeFile(path.join(dir, ".casper", "agent", "auth.json"), JSON.stringify({
    anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 },
    "openai-codex": { type: "oauth", access: "a", expires: 1 },
    openrouter: { type: "api_key", key: "k" },
    brave: { type: "api_key", key: "k" },
  }));
  const lines = await checkSignIn(context(dir, { env: { OPENAI_API_KEY: "x" }, now: () => 10 }));
  expect(lines[0]).toEqual({ status: "ok", text: "Sign-in: anthropic, openrouter, $OPENAI_API_KEY" });
  expect(lines[1]).toEqual({ status: "fail", text: "Sign-in: openai-codex expired", next: "type /login openai-codex in Casper" });
  // Keys never reach the report.
  expect(JSON.stringify(lines)).not.toContain("\"k\"");
});

test("sign-in: a provider set up in models.json with a key or address counts, and the doctor exits 0", async () => {
  const dir = await home();
  await writeFile(path.join(dir, ".casper", "agent", "models.json"), `{
    // comments are allowed, as Pi reads it
    "providers": {
      "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions", "models": [{ "id": "llama3" }] },
      "gateway": { "apiKey": "secret-key", "models": [] },
      "bare": { "models": [] }
    }
  }`);
  const lines = await checkSignIn(context(dir));
  expect(lines).toEqual([{ status: "ok", text: "Sign-in: gateway, ollama (models.json)" }]);
  expect(JSON.stringify(lines)).not.toContain("secret-key");

  let output = "";
  const result = await runDoctor(context(dir, { fetch: releases("v0.2.22") }), { write: (text) => { output += text; } });
  expect(output).not.toContain("No model sign-in");
  expect(result.exitCode).toBe(0);
});

test("MCP: a missing launcher is named with its install page, a missing variable by name; nothing is started", async () => {
  const dir = await home();
  await writeFile(path.join(dir, ".casper", "mcp.json"), JSON.stringify({ mcpServers: {
    mist: { command: "uvx", args: ["mist-mcp"] },
    central: { command: "node", args: ["server.js"], env: { TOKEN: "${CENTRAL_TOKEN_FOR_DOCTOR_TEST}" } },
  } }));
  const { lines } = await checkMcp(context(dir), "default");
  const text = formatDoctorLines(lines);
  expect(text).toContain("✗ MCP mist: can't start: uvx is not installed\n    → It comes with uv: https://docs.astral.sh/uv/getting-started/installation/");
  expect(text).toContain("✗ MCP central: can't start: needs CENTRAL_TOKEN_FOR_DOCTOR_TEST, which is not set");

  const failed = await checkMcp(context(dir, { env: { PATH: process.env.PATH ?? "", CENTRAL_TOKEN_FOR_DOCTOR_TEST: "x" },
    mcpStatus: () => [{ name: "mist", state: "failed", error: "exited with code 1" } as never] }), "default");
  expect(formatDoctorLines(failed.lines)).toContain("✗ MCP mist: didn't start: exited with code 1");
});

test("language servers: a language with no server is worth knowing; a server whose program is missing is something to fix", async () => {
  const dir = await home();
  const project = path.join(dir, "app");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, "tsconfig.json"), "{}");
  await writeFile(path.join(project, "pyproject.toml"), "");
  await writeFile(path.join(dir, ".casper", "lsp.json"), JSON.stringify({ lspServers: {
    pyright: { command: "/nowhere/pyright-langserver", args: ["--stdio"], languages: { ".py": "python" } },
  } }));
  const lines = await checkLanguageServers(context(dir, { projectRoot: project }), "default");
  expect(lines[0]).toMatchObject({ status: "note", text: "TypeScript: no language server set up (optional)" });
  expect(lines[1]).toMatchObject({ status: "fail" });
  expect(lines[1]!.text).toContain("Python: language server pyright can't start: /nowhere/pyright-langserver is not installed");
  expect(await checkLanguageServers(context(dir), "default")).toEqual([]);
});

test("sandbox: turned on, a missing helper is something to fix, with the install line", async () => {
  const dir = await home();
  const on = { sandbox: { user: { off: false } } } as never;
  const lines = await checkSandbox(context(dir, { platform: "linux", sandboxProblem: () => "bubblewrap and socat are missing: sudo apt install bubblewrap socat" }), on);
  expect(lines).toEqual([{ status: "fail", text: "Sandbox: can't hold commands here: bubblewrap and socat are missing", next: "sudo apt install bubblewrap socat" }]);
  expect((await checkSandbox(context(dir, { platform: "win32" }), on))[0]!.status).toBe("note");
  expect((await checkSandbox(context(dir, { platform: "linux" }), on))[0]!.status).toBe("ok");
});

test("sandbox: off unless you turn it on is a note, not a problem, whether or not it could run", async () => {
  const dir = await home();
  expect(await checkSandbox(context(dir, { platform: "linux" }), undefined)).toEqual([{ status: "note",
    text: "Sandbox: off unless you turn it on (sandbox: on in ~/.casper/config.yaml, or /sandbox on); it can run here" }]);
  const missing = await checkSandbox(context(dir, { platform: "linux", sandboxProblem: () => "bubblewrap is missing" }), undefined);
  expect(missing[0]).toMatchObject({ status: "note", text: "Sandbox: off unless you turn it on; it can't run here yet (bubblewrap is missing)" });
});

test("disk: low space for ~/.casper is named", async () => {
  const dir = await home();
  expect((await checkDisk(context(dir, { freeBytes: async () => 100 * 1024 ** 2 })))[0]).toMatchObject({ status: "fail", text: "Disk: only 100 MB free for ~/.casper" });
  expect((await checkDisk(context(dir, { freeBytes: async () => 1024 ** 3 })))[0]!.status).toBe("note");
  expect((await checkDisk(context(dir)))[0]!.status).toBe("ok");
});

test("network server: not installed is something to fix; installed shows the version and the saved logins by product", async () => {
  const dir = await home();
  const entry = lockedEntryPath(dir, NETWORK_SERVER);
  const ours = { name: "network", source: path.join(dir, ".casper", "mcp.json"), cwd: dir, disabled: false, scope: "user" as const,
    transport: { type: "stdio" as const, command: entry, args: [], env: {} } };
  const missing = await checkNetworkServer(context(dir), [ours], {});
  expect(missing[0]).toMatchObject({ status: "fail", fix: "network", next: "/mcp setup network" });

  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "");
  await writeFile(path.join(dir, ".casper", "tools", NETWORK_SERVER.id, ".casper-installed.json"), JSON.stringify({ id: NETWORK_SERVER.id, version: NETWORK_SERVER.version }));
  await writeFile(path.join(dir, ".casper", "network-logins.json"), JSON.stringify({ mist: { MIST_API_TOKEN: "secret-token-value", MIST_HOST: "api.mist.com" } }), { mode: 0o600 });
  const fine = await checkNetworkServer(context(dir), [ours], {});
  expect(fine[0]!.status).toBe("ok");
  expect(fine[0]!.text).toContain(`Network server: ${NETWORK_SERVER.version}; logins saved: Mist`);
  expect(JSON.stringify(fine)).not.toContain("secret-token-value");

  const none = await checkNetworkServer(context(dir), [], {});
  expect(none[0]).toMatchObject({ status: "note", fix: "network" });
});

test("network server: settings that don't load count as off, so a project file never undoes your network_updates: off", async () => {
  const dir = await home();
  const project = path.join(dir, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  const entry = lockedEntryPath(dir, NETWORK_SERVER);
  const ours = { name: "network", source: path.join(dir, ".casper", "mcp.json"), cwd: dir, disabled: false, scope: "user" as const,
    transport: { type: "stdio" as const, command: entry, args: [], env: {} } };
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "");
  await writeFile(path.join(dir, ".casper", "tools", NETWORK_SERVER.id, ".casper-installed.json"), JSON.stringify({ id: NETWORK_SERVER.id, version: NETWORK_SERVER.version }));
  const parts = NETWORK_SERVER.version.split(".").map(Number); parts[2]! += 1;
  const next = parts.join(".");
  await writeFile(path.join(dir, ".casper", "network-releases.json"), JSON.stringify({ checkedAt: Date.now(), releases: [{ version: next, prerelease: false }] }));
  await writeFile(path.join(dir, ".casper", "config.yaml"), "network_updates: off\n");
  await writeFile(path.join(project, ".casper", "project.yaml"), "network_updates: on\n");
  const ctx = context(dir, { projectRoot: project });
  const config = await checkConfig(ctx);
  expect(config.loaded).toBeUndefined();
  const lines = await checkNetworkServer(ctx, [ours], config.loaded);
  expect(lines[0]).toMatchObject({ status: "ok" });
  expect(JSON.stringify(lines)).not.toContain("update ready");
  // Settings that load and leave it on: the release is offered.
  expect((await checkNetworkServer(ctx, [ours], {}))[0]!.text).toContain(`update ready (${next})`);
});

test("runDoctor: exit 1 only for something to fix; each fix asks with 1 Not now first and only 2 acts", async () => {
  const dir = await home();
  await writeFile(path.join(dir, ".casper", "agent", "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "k" } }));
  let output = "";
  const asked: string[] = [];
  let updates = 0;
  const io = (answer: string | undefined): DoctorIO => ({
    write: (text) => { output += text; },
    choose: async (preview) => { asked.push(preview); return answer; },
    update: async () => { updates++; return { exitCode: 0 }; },
  });
  const ctx = context(dir, { fetch: releases("v0.3.0") });
  const notNow = await runDoctor(ctx, io("1"));
  expect(notNow.exitCode).toBe(0);
  expect(asked[0]).toContain("Casper 0.3.0 is out (you have 0.2.22).\n  1 Not now\n  2 Update now\n");
  expect(updates).toBe(0);
  expect(output).toContain("Casper doctor · no model, no tokens\n");
  expect(output).toContain("Nothing to fix.");

  await runDoctor(ctx, io("2"));
  expect(updates).toBe(1);

  // A script (nobody to ask): the report and the exit code, no question.
  output = "";
  const broken = context(await home(), { fetch: releases("v0.2.22") });
  const script = await runDoctor(broken, { write: (text) => { output += text; } });
  expect(script.exitCode).toBe(1);
  expect(output).toContain("✗ No model sign-in\n    → run casper and type /login, or start a model server such as Ollama\n");
  expect(output).toContain("1 thing to fix (✗)");
});

test("/doctor in a session runs the same checks with no model, and names a server this session could not start", async () => {
  const dir = await home();
  const project = path.join(dir, "project");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "package.json"), "{}");
  const { CasperApp } = await import("../src/app");
  const saved = { offline: process.env.CASPER_OFFLINE, agent: process.env.CASPER_AGENT_DIR };
  process.env.CASPER_OFFLINE = "1";
  process.env.CASPER_AGENT_DIR = path.join(dir, ".casper", "agent");
  let starts = 0;
  const output: string[] = [];
  const app = new CasperApp({
    runtimeFactory: () => { starts++; throw new Error("the doctor never starts a model"); },
    output: { write: (text) => { output.push(text); } }, sessionHomeDir: dir,
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  try {
    await app.start(project);
    await app.runOnce("/doctor");
  } finally {
    await app.close().catch(() => {});
    process.env.CASPER_OFFLINE = saved.offline; if (saved.offline === undefined) delete process.env.CASPER_OFFLINE;
    process.env.CASPER_AGENT_DIR = saved.agent; if (saved.agent === undefined) delete process.env.CASPER_AGENT_DIR;
  }
  const text = output.join("");
  expect(text).toContain("Casper doctor · no model, no tokens");
  expect(text).toContain("✗ No model sign-in");
  expect(text).toContain("TypeScript: no language server set up (optional)");
  expect(starts).toBe(0);
});

test("version: a Windows update that did not finish is a failure line with the log and the one-liner, before the newest-release line", async () => {
  const dir = await home();
  await mkdir(path.join(dir, ".casper"), { recursive: true });
  await writeFile(path.join(dir, ".casper", "update.log"), "target: 0.2.23\nresult: failed: Casper did not exit in time, so nothing was changed\n");
  const lines = await checkVersion(context(dir, { fetch: releases("v0.2.23", "v0.2.22") }));
  expect(lines[0]).toMatchObject({ status: "fail" });
  expect(lines[0]!.text).toContain("The last update to Casper 0.2.23 did not finish: Casper did not exit in time");
  expect(lines[0]!.next).toContain("install.ps1 | iex");
  expect(lines[1]).toMatchObject({ status: "note", fix: "update" });
});

test("sign-in: a model server found on this computer counts; a variable pointing at nothing is a note, with what to set there; localModels false looks for none", async () => {
  const { localModelDefaults, SERVER_SIDE_TIP } = await import("../src/runtime/local-models");
  const saved = localModelDefaults.discover;
  let looked = 0;
  const text = "vLLM at http://192.0.2.7:8000 (VLLM_BASE_URL) refused the connection (nothing is listening on that port).";
  localModelDefaults.discover = async () => { looked++; return { servers: [{ provider: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "qwen3:8b" }] }],
    problems: [{ provider: "vllm", root: "http://192.0.2.7:8000", cause: "refused", text }] }; };
  try {
    const dir = await home();
    expect(await checkSignIn(context(dir))).toEqual([{ status: "ok", text: "Sign-in: ollama (found on this computer)" },
      { status: "note", text }, { status: "note", text: SERVER_SIDE_TIP }]);
    expect(await checkSignIn(context(dir), false)).toEqual([{ status: "fail", text: "No model sign-in", next: "run casper and type /login, or start a model server such as Ollama" }]);
    expect(looked).toBe(1);
    // One on another computer is named by where it is: requests go over the network there.
    localModelDefaults.discover = async () => ({ servers: [{ provider: "ollama", name: "Ollama", baseUrl: "http://192.0.2.10:11434/v1", models: [{ id: "qwen3:8b" }] }], problems: [] });
    expect(await checkSignIn(context(dir))).toEqual([{ status: "ok", text: "Sign-in: ollama (at http://192.0.2.10:11434)" }]);
  } finally { localModelDefaults.discover = saved; }
});

test("sign-in: servers you added are listed even with localModels false", async () => {
  const { localModelDefaults } = await import("../src/runtime/local-models");
  const saved = localModelDefaults.discover;
  const seen: unknown[] = [];
  localModelDefaults.discover = async (options) => {
    seen.push({ auto: options?.auto, saved: options?.saved?.map((server) => server.name) });
    return { servers: [{ provider: "vllm-box", name: "vLLM at 192.0.2.10:8000", baseUrl: "http://192.0.2.10:8000/v1", models: [{ id: "Qwen/Qwen3-8B" }], saved: true }],
      problems: [{ provider: "ollama-den", saved: true, root: "http://192.0.2.11:11434", cause: "timeout", text: "ollama-den (Ollama at http://192.0.2.11:11434) didn't answer in 10 s." }] };
  };
  try {
    const dir = await home();
    const servers = [{ name: "vllm-box", address: "http://192.0.2.10:8000", kind: "vllm" as const }, { name: "ollama-den", address: "http://192.0.2.11:11434", kind: "ollama" as const }];
    const lines = await checkSignIn(context(dir), false, servers);
    expect(seen).toEqual([{ auto: false, saved: ["vllm-box", "ollama-den"] }]);
    expect(lines[0]).toEqual({ status: "ok", text: "Sign-in: vllm-box (your server at http://192.0.2.10:8000, 1 model)" });
    expect(lines.map((line) => line.text)).toContain("ollama-den (Ollama at http://192.0.2.11:11434) didn't answer in 10 s.");
  } finally { localModelDefaults.discover = saved; }
});
