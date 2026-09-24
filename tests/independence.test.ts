import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import ts from "typescript";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-independence-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home); await mkdir(project);
  const env = { ...isolatedEnvironment(home), CASPER_OFFLINE: "1" };
  async function run(args: string[], additions: Record<string, string> = {}, entry = cli) {
    const child = Bun.spawn([process.execPath, entry, ...args], {
      cwd: project, env: { ...env, ...additions }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { stdout, stderr, exit };
    } finally { clearTimeout(timer); }
  }
  return { root, home, project, run };
}

test("startup ignores an inherited engine directory with a notice and uses Casper's own state", async () => {
  const f = await fixture();
  const inherited = path.join(f.root, "inherited-engine-state");
  const result = await f.run(["/help"], { PI_CODING_AGENT_DIR: inherited });
  expect(result.exit).toBe(0);
  expect(result.stderr).toContain("Ignoring PI_CODING_AGENT_DIR; use CASPER_AGENT_DIR");
  expect(result.stdout).not.toContain("Ignoring");
  expect(await readdir(f.root)).not.toContain("inherited-engine-state");
  expect(await readdir(path.join(f.home, ".casper"))).toContain("agent");
});

test("CASPER_AGENT_DIR selects a separate catalog without importing legacy credentials", async () => {
  const f = await fixture();
  const agent = path.join(f.root, "custom-agent");
  await mkdir(agent);
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "synthetic",
    models: [{ id: "custom-catalog" }],
  } } }));
  await mkdir(path.join(f.home, ".pi/agent"), { recursive: true });
  await writeFile(path.join(f.home, ".pi/agent/auth.json"), '{"legacy":{"type":"api_key","key":"synthetic"}}');
  const result = await f.run(["/model"], { CASPER_AGENT_DIR: agent });
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain("fixture/custom-catalog");
  expect(await Bun.file(path.join(agent, "auth.json")).json()).toEqual({});
  expect(await readdir(path.join(f.home, ".casper"))).not.toContain("agent");
});

test("CASPER_OFFLINE disables real catalog refreshes and supersedes the engine's inherited flag", async () => {
  const f = await fixture();
  const probe = path.join(f.root, "catalog.ts");
  await mkdir(path.join(f.home, ".casper/agent"), { recursive: true });
  await writeFile(path.join(f.home, ".casper/agent/auth.json"), '{"anthropic":{"type":"api_key","key":"synthetic"}}');
  await writeFile(probe, `
import { useCasperAgentStore, casperAgentDir } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/runtime/agent-store.ts"))};
useCasperAgentStore();
const fetched = [];
globalThis.fetch = async (url) => { fetched.push(String(url)); return new Response('{}', { status: 503 }); };
const { ModelRuntime } = await import(${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))});
const runtime = await ModelRuntime.create({ authPath: casperAgentDir() + '/auth.json', modelsPath: null });
await runtime.refresh();
console.log(JSON.stringify(fetched));
`);
  const offline = await f.run([], { CASPER_OFFLINE: "1" }, probe);
  expect(offline.exit).toBe(0);
  expect(JSON.parse(offline.stdout)).toEqual([]);
  const online = await f.run([], { CASPER_OFFLINE: "", PI_OFFLINE: "1" }, probe);
  expect(online.exit).toBe(0);
  expect(JSON.parse(online.stdout).length).toBeGreaterThan(0);
});

test("startup forwards Casper callback and terminal logging settings, never inherited engine values", async () => {
  const f = await fixture();
  const probe = path.join(f.root, "environment.ts");
  await writeFile(probe, `
import { useCasperAgentStore } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/runtime/agent-store.ts"))};
useCasperAgentStore();
console.log(JSON.stringify([process.env.PI_OAUTH_CALLBACK_HOST ?? null, process.env.PI_TUI_WRITE_LOG ?? null]));
`);
  const inherited = { PI_OAUTH_CALLBACK_HOST: "0.0.0.0", PI_TUI_WRITE_LOG: path.join(f.root, "unwanted-log") };
  const configured = await f.run([], {
    ...inherited, CASPER_OAUTH_CALLBACK_HOST: "127.0.0.1", CASPER_TUI_WRITE_LOG: path.join(f.root, "debug.log"),
  }, probe);
  expect(configured.exit).toBe(0);
  expect(JSON.parse(configured.stdout)).toEqual(["127.0.0.1", path.join(f.root, "debug.log")]);
  const defaults = await f.run([], inherited, probe);
  expect(defaults.exit).toBe(0);
  expect(JSON.parse(defaults.stdout)).toEqual([null, null]);
});

test("source literals use Casper's identity rather than the engine's name", async () => {
  const src = path.resolve(import.meta.dir, "../src");
  const leaks: string[] = [];
  for (const name of await readdir(src, { recursive: true })) {
    if (!name.endsWith(".ts")) continue;
    const file = ts.createSourceFile(name, await readFile(path.join(src, name), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
        && /\bPi\b/.test(node.text)) leaks.push(`${name}: ${node.text}`);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  // Attribution lives in README and THIRD_PARTY_NOTICES, not runtime copy.
  expect(leaks).toEqual([]);
});

test("--version is one stdout line and touches neither inherited nor Casper state", async () => {
  const f = await fixture();
  const result = await f.run(["--version"], {
    PI_CODING_AGENT_DIR: path.join(f.root, "inherited"), CASPER_AGENT_DIR: path.join(f.root, "custom"),
    CASPER_TUI_WRITE_LOG: path.join(f.root, "debug.log"),
  });
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toMatch(/^casper \S+ \([^\n]*\)\n$/);
  expect((await readdir(f.root)).sort()).toEqual(["home", "project"]);
  expect(await readdir(f.home)).not.toContain(".casper");
});

test("a real session ignores project .pi resources and names Casper once before user instructions", async () => {
  const f = await fixture();
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(await request.json());
    const chunk = { id: "independence", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta: { role: "assistant", content: "LOCAL_RESPONSE" }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  cleanup.push(async () => { server.stop(true); });
  const agent = path.join(f.home, ".casper/agent");
  await mkdir(agent, { recursive: true });
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "synthetic",
    models: [{ id: "fixture" }],
  } } }));
  await writeFile(path.join(f.home, ".casper/settings.json"), '{"defaultProvider":"fixture","defaultModel":"fixture"}');
  await writeFile(path.join(agent, "SYSTEM.md"), "USER_INSTRUCTIONS_LOAD");
  const pi = path.join(f.project, ".pi");
  for (const dir of ["extensions", "prompts", "themes"]) await mkdir(path.join(pi, dir), { recursive: true });
  const marker = path.join(f.project, "EXTENSION_RAN");
  await writeFile(path.join(pi, "extensions/untrusted.ts"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'); export default function() {}`);
  for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md", "prompts/hi.md"]) {
    await writeFile(path.join(pi, name), "PROJECT_RESOURCE_MUST_NOT_LOAD");
  }
  await writeFile(path.join(pi, "settings.json"), '{"defaultProvider":"wrong","defaultModel":"wrong","theme":"untrusted"}');
  await writeFile(path.join(pi, "themes/untrusted.json"), "INVALID_PROJECT_THEME");
  const result = await f.run(["Answer without tools"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain("LOCAL_RESPONSE");
  expect(await Bun.file(marker).exists()).toBe(false);
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests)).not.toContain("PROJECT_RESOURCE_MUST_NOT_LOAD");
  const system = requests[0]!.messages.find(message => message.role === "system")!.content;
  expect(system).toStartWith("You are Casper, ");
  expect(system.match(/You are Casper/g)).toHaveLength(1);
  expect(system).toContain("USER_INSTRUCTIONS_LOAD");
  expect(system).not.toMatch(/\bPi\b|operating inside pi/);
});
