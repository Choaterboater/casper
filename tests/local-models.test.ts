import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { clearLocalServers, discoverLocalServers, localModelDefaults, localServers, registerLocalServers, sameAddress, serverRoot, type LocalDiscovery } from "../src/runtime/local-models";
import { PiModels } from "../src/runtime/pi-models";
import { isolatedEnvironment } from "../src/platform/environment";
import { removeTempDir } from "./support/temp-dir";

/** Fake model servers on port 0 (Bun.serve), reached only through the variables that move each server. */

const stops: (() => unknown)[] = [];
const savedDiscover = localModelDefaults.discover;
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  localModelDefaults.discover = savedDiscover;
  clearLocalServers();
});

type Seen = { path: string; authorization: string | null; body?: string };
function serve(routes: Record<string, unknown | ((request: Request) => Response | Promise<Response>)>): { url: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.clone().text() : undefined;
    seen.push({ path: url.pathname, authorization: request.headers.get("authorization"), ...(body ? { body } : {}) });
    const route = routes[`${request.method} ${url.pathname}`];
    if (route === undefined) return new Response("not here", { status: 404 });
    return typeof route === "function" ? (route as (request: Request) => Response)(request) : Response.json(route);
  } });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

/** A port nothing listens on: a server is started and stopped. */
function closedPort(): string {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const url = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  return url;
}

const ollamaRoutes = {
  "GET /api/tags": { models: [
    { name: "qwen3:8b", details: { family: "qwen3", context_length: 40960 }, capabilities: ["completion", "tools"] },
    { name: "nomic-embed-text:latest", details: { family: "nomic-bert", context_length: 2048 }, capabilities: ["embedding"] },
    { name: "gemma3:4b", details: { family: "gemma3" } },
    { name: "old-embedder", details: { family: "bert" } },
    { name: "custom:latest", details: { family: "llama", context_length: 131072 }, capabilities: ["completion"] },
  ] },
  "POST /api/show": async (request: Request) => {
    const { model } = await request.json() as { model: string };
    if (model === "gemma3:4b") return Response.json({ capabilities: ["completion", "vision"], model_info: { "gemma3.context_length": 131072 } });
    if (model === "custom:latest") return Response.json({ parameters: "temperature 0.6\nnum_ctx                        8192" });
    return Response.json({});
  },
  "GET /api/ps": { models: [{ name: "qwen3:8b", context_length: 32768 }] },
};

test("finds Ollama, LM Studio, llama.cpp and vLLM where their variables point, with windows, images and no embedding models", async () => {
  const ollama = serve(ollamaRoutes);
  const lmStudio = serve({ "GET /api/v0/models": { data: [
    { id: "qwen2.5-coder-7b", type: "llm", loaded_context_length: 16384, max_context_length: 32768 },
    { id: "llava-7b", type: "vlm" },
    { id: "text-embedding-nomic", type: "embeddings" },
  ] } });
  const llama = serve({ "GET /v1/models": { data: [{ id: "llama-3.2-1b" }] }, "GET /props": { default_generation_settings: { n_ctx: 8192 }, modalities: { vision: false } } });
  const vllm = serve({ "GET /v1/models": { data: [{ id: "Qwen/Qwen3-8B", max_model_len: 32768 }, { id: "BAAI/bge-m3" }] } });
  const found = await discoverLocalServers({ env: {
    OLLAMA_HOST: ollama.url.replace("http://", ""), LM_STUDIO_BASE_URL: `${lmStudio.url}/v1`, LLAMA_CPP_BASE_URL: llama.url, VLLM_BASE_URL: `${vllm.url}/v1/`,
  } });
  expect(found.problems).toEqual([]);
  expect(found.servers).toEqual([
    { provider: "ollama", name: "Ollama", baseUrl: `${ollama.url}/v1`, models: [
      { id: "qwen3:8b", contextWindow: 32768 },
      { id: "gemma3:4b", contextWindow: 128000, images: true },
      { id: "custom:latest", contextWindow: 8192 },
    ] },
    { provider: "lm-studio", name: "LM Studio", baseUrl: `${lmStudio.url}/v1`, models: [{ id: "qwen2.5-coder-7b", contextWindow: 16384 }, { id: "llava-7b", images: true }] },
    { provider: "llama.cpp", name: "llama.cpp", baseUrl: `${llama.url}/v1`, models: [{ id: "llama-3.2-1b", contextWindow: 8192 }] },
    { provider: "vllm", name: "vLLM", baseUrl: `${vllm.url}/v1`, models: [{ id: "Qwen/Qwen3-8B", contextWindow: 32768 }] },
  ]);
  // The probes carry no key of any kind.
  for (const server of [ollama, lmStudio, llama, vllm]) expect(server.seen.every((request) => request.authorization === null)).toBe(true);
});

test("Ollama's window: a loaded model's, then its num_ctx, then OLLAMA_CONTEXT_LENGTH, never more than the model was trained for", async () => {
  const ollama = serve(ollamaRoutes);
  const found = await discoverLocalServers({ env: { OLLAMA_BASE_URL: ollama.url, OLLAMA_CONTEXT_LENGTH: "65536",
    LM_STUDIO_BASE_URL: undefined }, fetch: ((url: string, init?: RequestInit) => url.startsWith(ollama.url) ? fetch(url, init) : Promise.reject(new Error("refused"))) as typeof fetch });
  expect(found.servers.map((server) => server.provider)).toEqual(["ollama"]);
  expect(found.servers[0]!.models.map((model) => [model.id, model.contextWindow])).toEqual([["qwen3:8b", 32768], ["gemma3:4b", 65536], ["custom:latest", 8192]]);
  expect(found.problems).toEqual([]);
});

test("a server that is not running is skipped without a word; one whose variable is set says so", async () => {
  const refused = (() => Promise.reject(new Error("refused"))) as unknown as typeof fetch;
  expect(await discoverLocalServers({ env: {}, fetch: refused })).toEqual({ servers: [], problems: [] });
  const closed = closedPort();
  const found = await discoverLocalServers({ env: { VLLM_BASE_URL: closed }, fetch: ((url: string, init?: RequestInit) => url.startsWith(closed) ? fetch(url, init) : refused(url)) as typeof fetch });
  expect(found).toEqual({ servers: [], problems: [`VLLM_BASE_URL is set (${closed}) but no vLLM answered there; its models are not in /model.`] });
});

test("a web page or a different program on a server's port is not taken for a model server", async () => {
  const web = serve({ "GET /v1/models": () => new Response("<html>hello</html>", { headers: { "content-type": "text/html" } }), "GET /api/tags": { hello: "world" } });
  const only = ((url: string, init?: RequestInit) => url.startsWith(web.url) ? fetch(url, init) : Promise.reject(new Error("refused"))) as typeof fetch;
  const found = await discoverLocalServers({ env: { VLLM_BASE_URL: web.url, OLLAMA_HOST: web.url }, fetch: only });
  expect(found.servers).toEqual([]);
  expect(found.problems.length).toBe(2);
});

test("a hung server costs at most the timeout", async () => {
  // The answer comes only after the test, so stopping the server never waits on a request still open.
  const { promise: late, resolve: answer } = Promise.withResolvers<Response>();
  stops.unshift(() => answer(new Response("late")));
  const hung = serve({ "GET /v1/models": () => late });
  const started = performance.now();
  const found = await discoverLocalServers({ env: { VLLM_BASE_URL: hung.url }, timeoutMs: 150,
    fetch: ((url: string, init?: RequestInit) => url.startsWith(hung.url) ? fetch(url, init) : Promise.reject(new Error("refused"))) as typeof fetch });
  expect(performance.now() - started).toBeLessThan(1500);
  expect(found.servers).toEqual([]);
});

test("addresses: OLLAMA_HOST forms, /v1 dropped, localhost and 127.0.0.1 the same", () => {
  expect(serverRoot("0.0.0.0", 11434)).toBe("http://127.0.0.1:11434");
  expect(serverRoot("127.0.0.1:11500", 11434)).toBe("http://127.0.0.1:11500");
  expect(serverRoot("192.0.2.7", 11434)).toBe("http://192.0.2.7:11434");
  expect(serverRoot("http://192.0.2.7:1234/v1/", 1234)).toBe("http://192.0.2.7:1234");
  expect(serverRoot("https://models.example.com", 8000)).toBe("https://models.example.com");
  expect(serverRoot("ftp://192.0.2.7", 8000)).toBeUndefined();
  expect(serverRoot("   ", 8000)).toBeUndefined();
  expect(sameAddress("http://localhost:11434/v1", "http://127.0.0.1:11434")).toBe(true);
  expect(sameAddress("http://127.0.0.1:1234/v1", "http://127.0.0.1:11434/v1")).toBe(false);
});

async function runtimeIn(models?: unknown) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-local-models-"));
  stops.push(() => removeTempDir(dir));
  await writeFile(path.join(dir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "sk-openai-secret-0000" } }), { mode: 0o600 });
  if (models) await writeFile(path.join(dir, "models.json"), JSON.stringify(models));
  return ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json"), refreshOnCreate: false });
}

const found = (baseUrl: string): LocalDiscovery["servers"] => [{ provider: "ollama", name: "Ollama", baseUrl, models: [{ id: "qwen3:8b", contextWindow: 8192 }, { id: "gemma3:4b", images: true }] }];

test("a found server is in /model with no sign-in, free, with its window; an unknown window is Pi's usual one", async () => {
  const runtime = await runtimeIn();
  expect(registerLocalServers(runtime, found("http://127.0.0.1:11434/v1"))).toEqual(["ollama"]);
  expect(runtime.hasConfiguredAuth("ollama")).toBe(true);
  expect(runtime.getAvailableSnapshot().filter((model) => model.provider === "ollama").map((model) => model.id)).toEqual(["qwen3:8b", "gemma3:4b"]);
  const small = runtime.getModel("ollama", "qwen3:8b")!;
  expect([small.contextWindow, small.maxTokens, small.cost.input, small.baseUrl]).toEqual([8192, 2048, 0, "http://127.0.0.1:11434/v1"]);
  expect(small.compat).toMatchObject({ supportsDeveloperRole: false, supportsReasoningEffort: false });
  const big = runtime.getModel("ollama", "gemma3:4b")!;
  expect([big.contextWindow, big.input]).toEqual([128000, ["text", "image"]]);
  // Found again later: the list is replaced, not refused.
  expect(registerLocalServers(runtime, [{ ...found("http://127.0.0.1:11434/v1")[0]!, models: [{ id: "llama3.2:3b" }] }])).toEqual(["ollama"]);
  expect(runtime.getModels("ollama").map((model) => model.id)).toEqual(["llama3.2:3b"]);
});

test("your own models.json wins: a provider of the same name, or one of yours at the same address, is not added", async () => {
  const own = await runtimeIn({ providers: { ollama: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "mine", models: [{ id: "mine:7b" }] } } });
  expect(registerLocalServers(own, found("http://127.0.0.1:11434/v1"))).toEqual([]);
  expect(own.getModels("ollama").map((model) => model.id)).toEqual(["mine:7b"]);
  const sameServer = await runtimeIn({ providers: { home: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "x", models: [{ id: "qwen3:8b" }] } } });
  expect(registerLocalServers(sameServer, found("http://127.0.0.1:11434/v1"))).toEqual([]);
  expect(sameServer.getProvider("ollama")).toBeUndefined();
});

test("a request to a found server carries only the word local, never another provider's key", async () => {
  const chunk = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
  const server = serve({ "POST /v1/chat/completions": () => new Response(
    chunk({ id: "1", object: "chat.completion.chunk", created: 0, model: "qwen3:8b", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] })
    + chunk({ id: "1", object: "chat.completion.chunk", created: 0, model: "qwen3:8b", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }) });
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-env-secret-1111";
  try {
    const runtime = await runtimeIn();
    registerLocalServers(runtime, found(`${server.url}/v1`));
    const reply = await runtime.completeSimple(runtime.getModel("ollama", "qwen3:8b")!, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] });
    expect(reply.content.filter((part) => part.type === "text").map((part) => part.text).join("")).toBe("hi");
    const request = server.seen.find((entry) => entry.path === "/v1/chat/completions")!;
    expect(request.authorization).toBe("Bearer local");
    expect(JSON.stringify(server.seen)).not.toContain("secret");
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
  }
});

test("found once a day per process; /model probes again and keeps the list when a server is busy for a moment; a helper never probes", async () => {
  let calls = 0;
  const answers: LocalDiscovery[] = [{ servers: found("http://127.0.0.1:11434/v1"), problems: [] }, { servers: [], problems: ["busy"] }];
  localModelDefaults.discover = async () => { calls++; return answers.shift() ?? { servers: [], problems: [] }; };
  expect(await localServers({ cachedOnly: true })).toEqual({ servers: [], problems: [] });
  expect(calls).toBe(0);
  const first = await localServers();
  expect(first.servers.length).toBe(1);
  await localServers();
  expect(await localServers({ cachedOnly: true })).toBe(first);
  expect(calls).toBe(1);
  const again = await localServers({ refresh: true });
  expect(calls).toBe(2);
  expect(again).toEqual({ servers: first.servers, problems: ["busy"] });
});

test("a variable set to a server that did not answer shows once, at the first request", async () => {
  const models = new PiModels({} as ModelRuntime, os.tmpdir(), os.tmpdir());
  expect(models.localNotice()).toBeUndefined();
  const ready = Promise.resolve({ servers: [], problems: ["OLLAMA_HOST is set (http://192.0.2.7:11434) but no Ollama answered there; its models are not in /model."] });
  models.useLocalServers(ready);
  await ready; await Promise.resolve();
  expect(models.localNotice()).toBe("OLLAMA_HOST is set (http://192.0.2.7:11434) but no Ollama answered there; its models are not in /model.");
  expect(models.localNotice()).toBeUndefined();
});

/** A real PiRuntime in a fresh Bun child whose probe answers after `delayMs` with one Ollama model; nothing signed in. */
async function startWithSlowProbe(home: string, project: string, delayMs: number, body: string): Promise<Record<string, any>> {
  const repo = path.resolve(import.meta.dir, "..");
  const agent = path.join(home, ".pi/agent");
  const env = { ...isolatedEnvironment(home), TMPDIR: path.dirname(home), PI_CODING_AGENT_DIR: agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { localModelDefaults } from ${JSON.stringify(path.join(repo, "src/runtime/local-models.ts"))};
    localModelDefaults.discover = () => Bun.sleep(${delayMs}).then(() => ({ problems: [], servers: [{ provider: "ollama", name: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "qwen3:8b", contextWindow: 32768 }] }] }));
    const began = performance.now(); const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd() });
    const startMs = performance.now() - began;
    try { ${body} } finally { await runtime.dispose(); }`], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return JSON.parse(stdout);
}

test("the start never waits for the probe; a first request with nothing signed in picks a found model; a saved local default waits for it", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-local-start-")));
  stops.push(() => removeTempDir(root));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(home, ".pi/agent"), { recursive: true }); await mkdir(project);
  const first = await startWithSlowProbe(home, project, 2000, `
    const before = session.getStatus(); const selection = await session.selectDefaultModel();
    console.log(JSON.stringify({ startMs, before, selection, after: session.getStatus() }));`);
  expect(first.startMs).toBeLessThan(2000);
  expect(first.before.provider).toBeUndefined();
  expect(first.selection).toMatchObject({ selected: true, savedDefault: true });
  expect(first.after).toMatchObject({ provider: "ollama", model: "qwen3:8b", auth: "configured" });
  expect(first.after.blocked).toBeUndefined();
  // The saved default is a found server's: this start waits for the probe, so the model is there.
  const again = await startWithSlowProbe(home, project, 300, `console.log(JSON.stringify({ status: session.getStatus() }));`);
  expect(again.status).toMatchObject({ provider: "ollama", model: "qwen3:8b" });
  expect(again.status.blocked).toBeUndefined();
}, 60_000);
