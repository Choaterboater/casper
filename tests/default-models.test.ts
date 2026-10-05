import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { DEFAULT_MODELS } from "../src/runtime/pi-models";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });
const repo = path.resolve(import.meta.dir, "..");
setDefaultTimeout(15_000);

test("every default model Casper may pick after a sign-in is in Pi's catalog", async () => {
  for (const { provider, id } of DEFAULT_MODELS) {
    const catalog = await readFile(path.join(repo, "node_modules/@earendil-works/pi-ai/dist/providers/data", `${provider}.json`), "utf8");
    expect({ provider, id, listed: catalog.includes(JSON.stringify(id)) }).toEqual({ provider, id, listed: true });
  }
});

async function run(auth: Record<string, unknown>, body: string): Promise<unknown> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-default-model-"))); roots.push(root);
  const home = path.join(root, "home"); const project = path.join(root, "project");
  const agent = path.join(home, ".pi/agent");
  await mkdir(agent, { recursive: true }); await mkdir(project);
  await writeFile(path.join(agent, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  const env = { ...isolatedEnvironment(home), TMPDIR: root, PI_CODING_AGENT_DIR: agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd() });
    try { ${body} } finally { await runtime.dispose(); }`], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return JSON.parse(stdout);
}

test("with no model set, Casper picks the signed-in provider's default and saves it; a chosen model is never replaced", async () => {
  const picked = await run({ openrouter: { type: "api_key", key: "synthetic" } }, `
    const before = session.getStatus(); const selection = await session.selectDefaultModel({ provider: "openrouter" });
    console.log(JSON.stringify({ before, selection, after: session.getStatus() }));`) as Record<string, any>;
  // /status shows this text in any terminal, so it names steps that work everywhere, not "type a request".
  expect(picked.before.blocked).toBe("No Casper model selected. Use /model to choose one, or /login to sign in.");
  expect(picked.selection).toMatchObject({ selected: true, savedDefault: true });
  expect(picked.after).toMatchObject({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", auth: "configured" });
  expect(picked.after.blocked).toBeUndefined();

  const kept = await run({ openrouter: { type: "api_key", key: "synthetic" }, anthropic: { type: "api_key", key: "synthetic" } }, `
    const listed = await session.selectModel({}); const chosen = listed.models.find(m => m.provider === "anthropic" && m.id !== "claude-opus-4-8");
    await session.selectModel({ query: chosen.provider + "/" + chosen.id, persist: false });
    const selection = await session.selectDefaultModel({ provider: "openrouter" });
    console.log(JSON.stringify({ chosen, selection: selection ?? null, after: session.getStatus() }));`) as Record<string, any>;
  expect(kept.selection).toBeNull();
  expect(kept.after).toMatchObject({ provider: "anthropic", model: kept.chosen.id });

  const none = await run({}, `console.log(JSON.stringify({ selection: (await session.selectDefaultModel()) ?? null }));`) as Record<string, any>;
  expect(none.selection).toBeNull();
});

async function appWith(status: () => Record<string, unknown>, selectDefaultModel?: () => Promise<unknown>) {
  const { CasperApp } = await import("../src/app");
  const { loadProjectContext } = await import("../src/project/context");
  const { SkillRegistry } = await import("../src/skills/registry");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-no-model-"))); roots.push(root);
  const home = path.join(root, "home"); await mkdir(home);
  let prompts = 0; let output = "";
  const runtime = {
    start: async () => ({
      getStatus: status, ...(selectDefaultModel ? { selectDefaultModel } : {}),
      getState: () => ({ cwd: root, isStreaming: false }), setTools: () => {}, subscribe: () => () => {}, abort: async () => {},
      prompt: async () => { prompts++; },
    }),
    dispose: async () => {},
  };
  const app = new CasperApp({ runtimeFactory: () => runtime as never, sessionHomeDir: path.join(home, ".casper"),
    loadProjectContext: (project) => loadProjectContext(project, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    output: { write(text: string) { output += text; } } });
  return { app, root, prompts: () => prompts, output: () => output };
}

test("a request with no model picks one for a signed-in provider and runs; scripts with no way to pick get an error, not a fake receipt", async () => {
  let current: Record<string, unknown> = { auth: "unknown", blocked: "No Casper model selected. Use /model to choose one." };
  const picking = await appWith(() => current, async () => {
    current = { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", auth: "configured" };
    return { selected: true, savedDefault: true, status: current };
  });
  await picking.app.runOnce("explain this project", picking.root);
  expect(picking.prompts()).toBe(1);
  expect(picking.output()).toContain("[model] Casper picked openrouter/deepseek/deepseek-v4.1-flash for your signed-in provider and saved it as your default.");
  await picking.app.close();

  // Nothing signed in: a one-shot run says how to sign in, not "Use /model".
  const keys = Object.entries(process.env).filter(([name]) => /_API_KEY$|_TOKEN$/.test(name));
  for (const [name] of keys) delete process.env[name];
  try {
    const stuck = await appWith(() => ({ auth: "unknown", blocked: "No Casper model selected. Use /model to choose one." }), async () => undefined);
    await expect(stuck.app.runOnce("explain this project", stuck.root)).rejects.toThrow("Not signed in yet. Run casper in a terminal and type /login.");
    expect(stuck.prompts()).toBe(0);
    expect(stuck.output()).not.toContain("model run failed");
    await stuck.app.close();
  } finally { for (const [name, value] of keys) process.env[name] = value; }

  // A key is set but Casper has no default for that provider: a script is told --model or /model, not "type a request".
  const saved = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "synthetic";
  try {
    const keyed = await appWith(() => ({ auth: "unknown", blocked: "No Casper model selected. Use /model to choose one, or /login to sign in." }), async () => undefined);
    const error = await keyed.app.runOnce("explain this project", keyed.root).then(() => undefined, (caught: Error) => caught);
    expect(error?.message).toBe("No Casper model selected. Pass --model <provider/model>, or run casper and type /model.");
    expect(keyed.prompts()).toBe(0);
    await keyed.app.close();
  } finally { if (saved === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = saved; }
});

test("a missing sign-in names the real provider, its /login and its key variable", async () => {
  const { missingSignIn } = await import("../src/runtime/pi-models");
  expect(missingSignIn("openrouter")).toBe("Not signed in to OpenRouter. Type /login openrouter, or set OPENROUTER_API_KEY.");
  expect(missingSignIn("anthropic")).toBe("Not signed in to Anthropic. Type /login anthropic, or set ANTHROPIC_API_KEY.");
  expect(missingSignIn("openai-codex")).toBe("Not signed in to OpenAI Codex. Type /login openai-codex.");
  expect(missingSignIn("deepseek")).toBe("No key for deepseek. Set DEEPSEEK_API_KEY, or /model to choose another.");
  for (const provider of ["openrouter", "anthropic", "deepseek"]) expect(missingSignIn(provider)).not.toContain("OpenAI Codex or");
});

