import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { clearLocalServers, discoverLocalServers, localModelDefaults, localServerFound, localServers, localServerSettled, onLocalServer, onThisComputer, probeBudget, registerLocalServers, sameAddress, serverRoot, SERVER_SIDE_TIP, type LocalDiscovery, type LocalFound } from "../src/runtime/local-models";
import { PiModels } from "../src/runtime/pi-models";
import { isolatedEnvironment } from "../src/platform/environment";
import { removeTempDir } from "./support/temp-dir";

/** Fake model servers on port 0 (Bun.serve), reached only through the variables that move each server. */

const stops: (() => unknown)[] = [];
const savedDiscover = localModelDefaults.discover;
const savedStale = localModelDefaults.staleMs;
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  localModelDefaults.discover = savedDiscover;
  localModelDefaults.staleMs = savedStale;
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

test("CASPER_LOCAL_MODELS=off looks for nothing, even where a server's variable is set", async () => {
  let asked = 0;
  const spy = (() => { asked++; return Promise.reject(new Error("refused")); }) as unknown as typeof fetch;
  for (const off of ["off", "0", "false", "OFF"]) {
    expect(await discoverLocalServers({ env: { CASPER_LOCAL_MODELS: off, OLLAMA_HOST: "127.0.0.1:11434" }, fetch: spy })).toEqual({ servers: [], problems: [] });
  }
  expect(asked).toBe(0);
});

test("a server that is not running is skipped without a word; one whose variable is set says so", async () => {
  const refused = (() => Promise.reject(new Error("refused"))) as unknown as typeof fetch;
  expect(await discoverLocalServers({ env: {}, fetch: refused })).toEqual({ servers: [], problems: [] });
  const closed = closedPort();
  // A real closed port: Bun's own "refused" error is read as such.
  const found = await discoverLocalServers({ env: { VLLM_BASE_URL: closed }, fetch: ((url: string, init?: RequestInit) => url.startsWith(closed) ? fetch(url, init) : refused(url)) as typeof fetch });
  expect(found).toEqual({ servers: [], problems: [{ provider: "vllm", root: closed, cause: "refused",
    text: `vLLM at ${closed} (VLLM_BASE_URL) refused the connection (nothing is listening on that port).` }] });
});

test("each reason a server Casper was told about isn't there, in plain words", async () => {
  const failWith = (error: unknown) => (() => Promise.reject(error)) as unknown as typeof fetch;
  const answer = (status: number) => (() => Promise.resolve(new Response("{}", { status }))) as unknown as typeof fetch;
  const reason = async (fetcher: typeof fetch) => (await discoverLocalServers({ env: { OLLAMA_HOST: "192.0.2.7" }, fetch: fetcher })).problems[0]!;
  expect(await reason(failWith(Object.assign(new TypeError("getaddrinfo ENOTFOUND myserver"), { code: "ENOTFOUND" })))).toMatchObject({ cause: "name" });
  expect((await reason(failWith(Object.assign(new TypeError("UnexpectedRedirect fetching"), { code: "UnexpectedRedirect" })))).text)
    .toBe("Ollama at http://192.0.2.7:11434 (OLLAMA_HOST) tried to send Casper to another address (not followed).");
  expect(await reason(failWith(Object.assign(new TypeError("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" })))).toMatchObject({ cause: "certificate" });
  expect((await reason(answer(401))).text).toBe("Ollama at http://192.0.2.7:11434 (OLLAMA_HOST) asked for a key.");
  expect((await reason(answer(500))).text).toBe("Ollama at http://192.0.2.7:11434 (OLLAMA_HOST) answered with an error (HTTP 500).");
  expect(await reason(answer(404))).toMatchObject({ cause: "other" });
  // Bun's real redirect refusal, from a real server.
  const bouncer = serve({ "GET /api/tags": () => Response.redirect("http://192.0.2.9/api/tags", 307) });
  const bounced = await discoverLocalServers({ env: { OLLAMA_HOST: bouncer.url }, fetch: ((url: string, init?: RequestInit) => url.startsWith(bouncer.url) ? fetch(url, init) : Promise.reject(new Error("refused"))) as typeof fetch });
  expect(bounced.problems[0]).toMatchObject({ cause: "redirect" });
  // 0.0.0.0 is the server's "listen everywhere"; here it means this computer.
  const closed = closedPort();
  const everywhere = await discoverLocalServers({ env: { OLLAMA_HOST: `0.0.0.0:${new URL(closed).port}` },
    fetch: ((url: string, init?: RequestInit) => url.startsWith(closed) ? fetch(url, init) : Promise.reject(new Error("refused"))) as typeof fetch });
  expect(everywhere.problems[0]!.text).toContain("OLLAMA_HOST is 0.0.0.0, which here means this computer; to use another computer, set it to that computer's address.");
});

test("another computer gets 10 s to answer, this one 0.8 s; a server timing out says how long it was given", async () => {
  for (const here of ["http://127.0.0.1:11434", "http://localhost:1234", "http://[::1]:8080", "http://127.1.2.3:8000"]) {
    expect(onThisComputer(here)).toBe(true);
    expect(probeBudget(here)).toBe(800);
  }
  for (const there of ["http://192.0.2.7:11434", "https://myserver.example", "http://myserver:8000", "http://100.64.0.7:11434"]) {
    expect(onThisComputer(there)).toBe(false);
    expect(probeBudget(there)).toBe(10_000);
  }
  const { promise: late, resolve: answer } = Promise.withResolvers<Response>();
  stops.unshift(() => answer(new Response("late")));
  const hung = serve({ "GET /api/tags": () => late });
  const found = await discoverLocalServers({ env: { OLLAMA_HOST: hung.url }, timeoutMs: 150,
    fetch: ((url: string, init?: RequestInit) => url.startsWith(hung.url) ? fetch(url, init) : Promise.reject(new Error("refused"))) as typeof fetch });
  expect(found.problems[0]).toMatchObject({ cause: "timeout", text: `Ollama at ${hung.url} (OLLAMA_HOST) didn't answer in 0.1 s.` });
});

test("each server is heard of as soon as its own look ends: a slow one doesn't hold up a quick one", async () => {
  const { promise: late, resolve: answer } = Promise.withResolvers<Response>();
  stops.unshift(() => answer(new Response("late")));
  const hung = serve({ "GET /v1/models": () => late });
  const quick = serve({ "GET /api/v0/models": { data: [{ id: "qwen2.5-coder-7b", type: "llm" }] } });
  const heard: Array<{ provider: string; at: number }> = [];
  const started = performance.now();
  await discoverLocalServers({ env: { VLLM_BASE_URL: hung.url, LM_STUDIO_BASE_URL: quick.url }, timeoutMs: 600,
    fetch: ((url: string, init?: RequestInit) => url.startsWith(hung.url) || url.startsWith(quick.url) ? fetch(url, init) : Promise.reject(new Error("refused"))) as typeof fetch,
    each: (found: LocalFound) => heard.push({ provider: found.provider, at: performance.now() - started }) });
  const at = (provider: string) => heard.find((entry) => entry.provider === provider)!.at;
  expect(at("lm-studio")).toBeLessThan(at("vllm"));
  expect(at("lm-studio")).toBeLessThan(400);
  // The cache's per-server wait settles with that server, not with the slowest.
  const slow = Promise.withResolvers<LocalDiscovery>();
  localModelDefaults.discover = async (options) => {
    options?.each?.({ provider: "lm-studio", server: { provider: "lm-studio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "m" }] } });
    return slow.promise;
  };
  void localServers();
  let settled: unknown;
  void localServerSettled("lm-studio").then((server) => { settled = server; });
  await Bun.sleep(20);
  expect(settled).toMatchObject({ provider: "lm-studio", models: [{ id: "m" }] });
  // A listener that arrives after the server answered (the runtime, started after the banner's look) still hears of it.
  const heardLate: string[] = [];
  const stop = onLocalServer((server) => heardLate.push(server.provider));
  expect(heardLate).toEqual(["lm-studio"]);
  stop();
  slow.resolve({ servers: [], problems: [] });
});

test("a server on another computer doesn't count as signed in: it is never picked for you", async () => {
  localModelDefaults.discover = async (options) => {
    options?.each?.({ provider: "ollama", server: found("http://192.0.2.10:11434/v1")[0]! });
    return { servers: found("http://192.0.2.10:11434/v1"), problems: [] };
  };
  expect(await localServerFound()).toBe(false);
  clearLocalServers();
  localModelDefaults.discover = async (options) => {
    options?.each?.({ provider: "ollama", server: found("http://127.0.0.1:11434/v1")[0]! });
    return new Promise<LocalDiscovery>(() => {}); // Another server is still being looked at: this one settles it.
  };
  expect(await localServerFound()).toBe(true);
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

test("addresses: OLLAMA_HOST forms, /v1 and /api dropped, localhost and 127.0.0.1 the same", () => {
  expect(serverRoot("0.0.0.0", 11434)).toBe("http://127.0.0.1:11434");
  expect(serverRoot("http://192.0.2.7:11434/api", 11434, true)).toBe("http://192.0.2.7:11434");
  expect(serverRoot("http://192.0.2.7:11434/api/", 11434, true)).toBe("http://192.0.2.7:11434");
  // Only Ollama's own API path: another server behind a proxy at …/api keeps it.
  expect(serverRoot("https://models.example.com/api", 8000)).toBe("https://models.example.com/api");
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

test("found once a day per process; /model probes again and keeps each server busy for a moment; a helper never probes", async () => {
  let calls = 0;
  const lmStudio = { provider: "lm-studio" as const, name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "qwen2.5-coder-7b" }] };
  const busy = { provider: "ollama", root: "http://127.0.0.1:11434", cause: "timeout" as const, text: "busy" };
  const answers: LocalDiscovery[] = [{ servers: [...found("http://127.0.0.1:11434/v1"), lmStudio], problems: [] },
    { servers: [{ ...lmStudio, models: [{ id: "llava-7b" }] }], problems: [busy] }];
  localModelDefaults.discover = async () => { calls++; return answers.shift() ?? { servers: [], problems: [] }; };
  expect(await localServers({ cachedOnly: true })).toEqual({ servers: [], problems: [] });
  expect(calls).toBe(0);
  const first = await localServers();
  expect(first.servers.length).toBe(2);
  await localServers();
  expect(await localServers({ cachedOnly: true })).toBe(first);
  expect(calls).toBe(1);
  // A refresh that finds LM Studio but not Ollama: LM Studio's new list, and Ollama's last one kept (helpers need it).
  const again = await localServers({ refresh: true });
  expect(calls).toBe(2);
  expect(again).toEqual({ servers: [{ ...lmStudio, models: [{ id: "llava-7b" }] }, found("http://127.0.0.1:11434/v1")[0]!], problems: [busy] });
  expect(await localServers({ cachedOnly: true })).toBe(again);
});

test("a variable set to a server that did not answer shows once, at the first request, with what to set on that computer", async () => {
  const models = new PiModels({} as ModelRuntime, os.tmpdir(), os.tmpdir());
  expect(models.localNotice()).toBeUndefined();
  const text = "Ollama at http://192.0.2.7:11434 (OLLAMA_HOST) didn't answer in 10 s.";
  const ready = Promise.resolve({ servers: [], problems: [{ provider: "ollama", root: "http://192.0.2.7:11434", cause: "timeout" as const, text }] });
  models.useLocalServers({ ready });
  await ready; await Promise.resolve();
  expect(models.serverProblems()).toEqual([text, SERVER_SIDE_TIP]);
  expect(models.localNotice()).toBe(`${text} Its models aren't in /model. ${SERVER_SIDE_TIP}`);
  expect(models.localNotice()).toBeUndefined();
  // This computer refusing: no tip about another computer.
  const here = new PiModels({} as ModelRuntime, os.tmpdir(), os.tmpdir());
  const refused = Promise.resolve({ servers: [], problems: [{ provider: "ollama", root: "http://127.0.0.1:11500", cause: "refused" as const, text: "x" }] });
  here.useLocalServers({ ready: refused });
  await refused; await Promise.resolve();
  expect(here.localNotice()).toBe("x Its models aren't in /model.");
});

test("a request to a found server that answers with a redirect is not followed: the conversation goes nowhere else", async () => {
  const elsewhere = serve({ "POST /v1/chat/completions": () => new Response("should never be reached") });
  const bouncer = serve({ "POST /v1/chat/completions": () => Response.redirect(`${elsewhere.url}/v1/chat/completions`, 307) });
  const runtime = await runtimeIn();
  registerLocalServers(runtime, found(`${bouncer.url}/v1`));
  const reply = await runtime.completeSimple(runtime.getModel("ollama", "qwen3:8b")!, { messages: [{ role: "user", content: "the whole conversation", timestamp: Date.now() }] });
  expect(reply.stopReason).toBe("error");
  expect(bouncer.seen.some((entry) => entry.path === "/v1/chat/completions")).toBe(true);
  expect(elsewhere.seen).toEqual([]);
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

/** A real PiRuntime in a fresh Bun child, nothing signed in, whose looks answer in turn with each list of servers in
 * `answers` (the last one again after that); a look that finds nothing reports Ollama on another computer timing out.
 * Every missing model sends it looking again (staleMs 0). */
async function startWithLooks(home: string, project: string, answers: LocalDiscovery["servers"][], body: string): Promise<Record<string, any>> {
  const repo = path.resolve(import.meta.dir, "..");
  const env = { ...isolatedEnvironment(home), TMPDIR: path.dirname(home), PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { localModelDefaults } from ${JSON.stringify(path.join(repo, "src/runtime/local-models.ts"))};
    const answers = ${JSON.stringify(answers)}; let looks = 0;
    localModelDefaults.staleMs = 0;
    localModelDefaults.discover = async () => {
      const servers = answers[Math.min(looks, answers.length - 1)]; looks++;
      return { servers, problems: servers.length ? [] : [{ provider: "ollama", root: "http://192.0.2.10:11434", cause: "timeout",
        text: "Ollama at http://192.0.2.10:11434 (OLLAMA_HOST) didn't answer in 10 s." }] };
    };
    const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd() });
    try { ${body} } finally { await runtime.dispose(); }`], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return JSON.parse(stdout);
}

async function looksHome(): Promise<{ home: string; project: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-local-looks-")));
  stops.push(() => removeTempDir(root));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(home, ".pi/agent"), { recursive: true }); await mkdir(project);
  return { home, project };
}

const here = found("http://127.0.0.1:11434/v1");

test("a server that answered before the runtime listened is in its catalog, and a helper started mid-look gets the server it waits for", async () => {
  const { home, project } = await looksHome();
  const repo = path.resolve(import.meta.dir, "..");
  const env = { ...isolatedEnvironment(home), TMPDIR: path.dirname(home), PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  // The look answers for Ollama at once, before any runtime exists, and stays open (the rest are slow) until the helper
  // has started: the helper can only have Ollama from its own wait, never from the whole look's end.
  const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { localModelDefaults, localServers } from ${JSON.stringify(path.join(repo, "src/runtime/local-models.ts"))};
    const server = ${JSON.stringify(here[0])};
    const held = Promise.withResolvers(); let looking = true;
    localModelDefaults.discover = async (options) => { options?.each?.({ provider: "ollama", server }); await held.promise; looking = false; return { servers: [server], problems: [] }; };
    void localServers();
    await Bun.sleep(50);
    const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd() });
    const picked = await session.selectModel({ query: "ollama/qwen3:8b", persist: true });
    await runtime.dispose();
    const helperRuntime = new PiRuntime();
    const helper = await helperRuntime.startReadOnly({ cwd: process.cwd(), signal: new AbortController().signal, maxTurns: 1, maxToolCalls: 1 });
    const stillLooking = looking;
    held.resolve();
    console.log(JSON.stringify({ picked: picked.selected, helper: helper.getStatus(), stillLooking }));
    await helperRuntime.dispose();`], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const result = JSON.parse(stdout);
  expect(result.picked).toBe(true);
  expect(result.stillLooking).toBe(true);
  expect(result.helper).toMatchObject({ provider: "ollama", model: "qwen3:8b" });
  expect(result.helper.blocked).toBeUndefined();
}, 60_000);

test("a missed server is looked for again: an empty /model list and a model typed by name each look once more", async () => {
  const { home, project } = await looksHome();
  const listed = await startWithLooks(home, project, [[], here], `
    const result = await session.selectModel({});
    console.log(JSON.stringify({ looks, models: result.models?.map((model) => model.provider + "/" + model.id) }));`);
  expect(listed).toEqual({ looks: 2, models: ["ollama/qwen3:8b", "ollama/gemma3:4b"] });
  const typed = await startWithLooks(home, project, [[], here], `
    const result = await session.selectModel({ query: "ollama/qwen3:8b", persist: false });
    console.log(JSON.stringify({ looks, selected: result.selected, model: result.status.model }));`);
  expect(typed).toEqual({ looks: 2, selected: true, model: "qwen3:8b" });
}, 60_000);

test("a saved model whose server didn't answer at start says why, and is used once the server answers; another computer's server is never picked for you", async () => {
  const { home, project } = await looksHome();
  const first = await startWithLooks(home, project, [here], `console.log(JSON.stringify(await session.selectDefaultModel()));`);
  expect(first).toMatchObject({ selected: true, savedDefault: true, status: { provider: "ollama", model: "qwen3:8b" } });
  const later = await startWithLooks(home, project, [[], here], `
    const blocked = session.getStatus().blocked; const problems = session.localProblems();
    const again = await session.findModelAgain();
    console.log(JSON.stringify({ blocked, problems, again, after: session.getStatus() }));`);
  expect(later.blocked).toBe("Model ollama/qwen3:8b is unavailable: Ollama at http://192.0.2.10:11434 (OLLAMA_HOST) didn't answer in 10 s. Casper looks again when you ask after 15 seconds; /model picks another.");
  expect(later.problems).toEqual(["Ollama at http://192.0.2.10:11434 (OLLAMA_HOST) didn't answer in 10 s.", SERVER_SIDE_TIP]);
  expect(later.again).toBe(true);
  expect(later.after).toMatchObject({ provider: "ollama", model: "qwen3:8b" });
  expect(later.after.blocked).toBeUndefined();
  // Found again: its reason is no longer true, so the first request doesn't report it.
  const notice = await startWithLooks(home, project, [[], here], `
    await session.findModelAgain();
    console.log(JSON.stringify({ problems: session.localProblems() }));`);
  expect(notice.problems).toEqual([]);
  // OLLAMA_HOST pointing at another computer: its models are listed, but only a pick sends anything there.
  const fresh = await looksHome();
  const remote = await startWithLooks(fresh.home, fresh.project, [found("http://192.0.2.10:11434/v1")], `
    const picked = await session.selectDefaultModel();
    const chosen = await session.selectModel({ query: "ollama/qwen3:8b", persist: false });
    console.log(JSON.stringify({ picked: picked ?? null, chosen: chosen.selected }));`);
  expect(remote).toEqual({ picked: null, chosen: true });
}, 60_000);

test("ordinary words that name no local server never send Casper looking again", async () => {
  const { home, project } = await looksHome();
  const result = await startWithLooks(home, project, [here], `
    const before = looks;
    await session.matchModel("use node 20");
    await session.matchModel("openrouter/no-such-model");
    console.log(JSON.stringify({ extra: looks - before }));`);
  expect(result.extra).toBe(0);
}, 60_000);

/** A real PiRuntime in a fresh Bun child, nothing signed in except what `setup` writes, whose look answers nothing
 * for `lookMs` (OLLAMA_HOST on another computer, asleep). Prints what `body` logs. */
async function startWithSlowRemote(home: string, project: string, lookMs: number, body: string): Promise<Record<string, any>> {
  const repo = path.resolve(import.meta.dir, "..");
  const env = { ...isolatedEnvironment(home), TMPDIR: path.dirname(home), PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0",
    OLLAMA_HOST: "192.0.2.10" };
  const child = Bun.spawn([process.execPath, "-e", `import { PiRuntime } from ${JSON.stringify(path.join(repo, "src/runtime/pi.ts"))};
    import { localModelDefaults } from ${JSON.stringify(path.join(repo, "src/runtime/local-models.ts"))};
    let looks = 0;
    localModelDefaults.discover = async (options) => {
      looks++;
      options?.each?.({ provider: "lm-studio" }); options?.each?.({ provider: "llama.cpp" }); options?.each?.({ provider: "vllm" });
      await Bun.sleep(${lookMs});
      return { servers: [], problems: [{ provider: "ollama", root: "http://192.0.2.10:11434", cause: "timeout", text: "Ollama at http://192.0.2.10:11434 (OLLAMA_HOST) didn't answer in 10 s." }] };
    };
    const began = performance.now(); const runtime = new PiRuntime(); const session = await runtime.start({ cwd: process.cwd() });
    const startMs = performance.now() - began;
    try { ${body} } finally { await runtime.dispose(); }`], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return JSON.parse(stdout);
}

test("a slow server on another computer holds up neither a start whose saved model is a cloud one, nor an ordinary line", async () => {
  const { home, project } = await looksHome();
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/settings.json"), JSON.stringify({ defaultProvider: "openrouter", defaultModel: "no-such-model" }));
  const result = await startWithSlowRemote(home, project, 4000, `
    const words = performance.now(); await session.matchModel("use node 20"); const wordsMs = performance.now() - words;
    console.log(JSON.stringify({ startMs, wordsMs, looks }));`);
  expect(result.startMs).toBeLessThan(3000);
  expect(result.wordsMs).toBeLessThan(1500);
  expect(result.looks).toBe(1);
}, 60_000);

test("a look that just ended isn't repeated at once: the wait is counted from when it ended, not when it began", async () => {
  const { home, project } = await looksHome();
  // A 3 s look (still running when the model is asked for), a 1.5 s wait: counted from its start the look would be
  // repeated as soon as it ends, counted from its end it isn't.
  const result = await startWithSlowRemote(home, project, 3000, `
    const staleMs = localModelDefaults.staleMs; localModelDefaults.staleMs = 1500;
    await session.selectModel({ query: "ollama/qwen3:8b", persist: false }).catch(() => undefined);
    console.log(JSON.stringify({ looks, staleMs }));`);
  expect(result).toEqual({ looks: 1, staleMs: 15_000 });
}, 60_000);
