import { afterEach, expect, test } from "bun:test";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { RESERVED_NAMES, serverAddress, serverNameProblem } from "../src/config/model-servers";
import { autoName, detectServer, readableOnTheWire, readAddress } from "../src/runtime/model-servers";

/** Adding a model server: what you type, what answers there, and the name suggested. Fake servers on 127.0.0.1 only. */

const stops: (() => unknown)[] = [];
afterEach(async () => { await Promise.all(stops.splice(0).map((stop) => stop())); });

function serve(routes: Record<string, unknown | ((request: Request) => Response)>): string {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const route = routes[`${request.method} ${new URL(request.url).pathname}`];
    if (route === undefined) return new Response("not here", { status: 404 });
    return typeof route === "function" ? (route as (request: Request) => Response)(request) : Response.json(route);
  } });
  stops.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

test("an address: a bare computer or http:// with no port tries the usual ports; a port, a path or https is that one", () => {
  const usual = (host: string) => ({ roots: [11434, 1234, 8080, 8000].map((port) => `http://${host}:${port}`), host });
  expect(readAddress("192.0.2.10")).toEqual(usual("192.0.2.10"));
  expect(readAddress("  myserver ")).toEqual(usual("myserver"));
  expect(readAddress("http://myserver")).toEqual(usual("myserver"));
  expect(readAddress("http://myserver/")).toEqual(usual("myserver"));
  expect(readAddress("0.0.0.0")).toEqual(usual("127.0.0.1"));
  expect(readAddress("myserver:11434")).toEqual({ roots: ["http://myserver:11434"], host: "myserver:11434" });
  expect(readAddress("http://192.0.2.10:1234/v1")).toEqual({ roots: ["http://192.0.2.10:1234"], host: "192.0.2.10:1234" });
  expect(readAddress("https://models.example.com")).toEqual({ roots: ["https://models.example.com"], host: "models.example.com" });
  expect(readAddress("http://[fd7a:115c:a1e0::1]:11434")).toEqual({ roots: ["http://[fd7a:115c:a1e0::1]:11434"], host: "[fd7a:115c:a1e0::1]:11434" });
  // A copied API address is the server's address with the API path after it.
  expect(readAddress("http://myserver:8000/v1/models")).toEqual({ roots: ["http://myserver:8000"], host: "myserver:8000" });
  expect(readAddress("myserver:11434/api/tags")).toEqual({ roots: ["http://myserver:11434"], host: "myserver:11434" });
  expect(readAddress("http://myserver/v1")).toEqual(usual("myserver"));
  for (const [typed, problem] of [
    ["", "Type an address"], ["http://user:pw@myserver", "Leave the name and password out"], ["http://myserver:8000/?key=abc", "Leave the ? or # part out"],
    ["ftp://myserver", "http:// or https://"], ["http://", "can't read that address"],
  ] as const) expect((readAddress(typed) as { problem: string }).problem).toContain(problem);
});

test("the kind is told by what only that kind answers, whatever the port", async () => {
  const llama = serve({ "GET /props": { default_generation_settings: { n_ctx: 8192 } }, "GET /v1/models": { data: [{ id: "llama-3.2-1b", owned_by: "llamacpp" }] }, "GET /api/tags": { models: [] } });
  expect(await detectServer(llama)).toMatchObject({ state: "found", kind: "llama.cpp", models: [{ id: "llama-3.2-1b", contextWindow: 8192 }] });
  const studio = serve({ "GET /api/v0/models": { data: [{ id: "qwen2.5-coder-7b", type: "llm" }] }, "GET /v1/models": { data: [{ id: "qwen2.5-coder-7b" }] } });
  expect(await detectServer(studio)).toMatchObject({ state: "found", kind: "lm-studio", models: [{ id: "qwen2.5-coder-7b" }] });
  const ollama = serve({ "GET /api/version": { version: "0.12.0" }, "GET /api/tags": { models: [{ name: "qwen3:8b", capabilities: ["completion"] }] }, "GET /v1/models": { data: [{ id: "qwen3:8b" }] } });
  expect(await detectServer(ollama)).toMatchObject({ state: "found", kind: "ollama", models: [{ id: "qwen3:8b" }] });
  const vllm = serve({ "GET /v1/models": { data: [{ id: "Qwen/Qwen3-8B", owned_by: "vllm", max_model_len: 32768 }] } });
  expect(await detectServer(vllm)).toMatchObject({ state: "found", kind: "vllm", models: [{ id: "Qwen/Qwen3-8B", contextWindow: 32768 }] });
  const other = serve({ "GET /v1/models": { data: [{ id: "local-model" }] } });
  expect(await detectServer(other)).toMatchObject({ state: "found", kind: "openai", models: [{ id: "local-model" }] });
});

test("llama-server --api-key (model lists open, /props locked) wants a key, and is llama.cpp, not Ollama", async () => {
  const props = () => Response.json({ error: { message: "Invalid API Key" } }, { status: 401 });
  const llama = serve({ "GET /props": props, "GET /v1/models": { data: [{ id: "llama-3.2-1b", owned_by: "llamacpp" }] }, "GET /api/tags": { models: [{ name: "llama-3.2-1b" }] } });
  expect(await detectServer(llama)).toMatchObject({ state: "key", kind: "llama.cpp" });
  // A llama-server that says who it is (owned_by) and has no /props at all is still llama.cpp.
  const named = serve({ "GET /v1/models": { data: [{ id: "llama-3.2-1b", owned_by: "llamacpp" }] }, "GET /api/tags": { models: [{ name: "llama-3.2-1b" }] } });
  expect(await detectServer(named)).toMatchObject({ state: "found", kind: "llama.cpp" });
});

test("a 401 counts as a model server wanting a key only from a model API; a sign-in page is not one", async () => {
  const locked = serve({ "GET /v1/models": () => Response.json({ error: "unauthorized" }, { status: 401 }) });
  expect(await detectServer(locked)).toMatchObject({ state: "key" });
  const page = serve({ "GET /v1/models": () => new Response("<html>Sign in</html>", { status: 401, headers: { "content-type": "text/html" } }) });
  expect(await detectServer(page)).toMatchObject({ state: "none", cause: "login" });
  const bearer = serve({ "GET /v1/models": () => new Response("no", { status: 401, headers: { "www-authenticate": "Bearer" } }) });
  expect(await detectServer(bearer)).toMatchObject({ state: "key" });
});

test("nothing there says why: a closed port is refused, a web page isn't a model server", async () => {
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const root = `http://127.0.0.1:${closed.port}`;
  closed.stop(true);
  expect(await detectServer(root)).toMatchObject({ state: "none", cause: "refused" });
  const web = serve({ "GET /": () => new Response("<html>hello</html>") });
  expect(await detectServer(web)).toMatchObject({ state: "none", cause: "other", words: "answered, but isn't a model server" });
});

test("a suggested name: kind and computer, the port when it isn't the usual one, a number when taken", () => {
  expect(autoName("ollama", "http://myserver.example:11434")).toBe("ollama-myserver");
  expect(autoName("ollama", "http://192.0.2.10:11434")).toBe("ollama-192-0-2-10");
  expect(autoName("llama.cpp", "http://192.0.2.10:8081")).toBe("llama-cpp-192-0-2-10-8081");
  expect(autoName("lm-studio", "http://My_Server.local:1234")).toBe("lm-studio-my-server");
  expect(autoName("openai", "http://[fd7a:115c:a1e0::5]:8000")).toBe("server-5-8000"); // No usual port for any other server.
  expect(autoName("ollama", "http://myserver:11434", ["ollama-myserver"])).toBe("ollama-myserver-2");
  expect(autoName("vllm", "http://a-very-long-computer-name-that-goes-on-and-on:8000").length).toBeLessThanOrEqual(32);
  expect(autoName("vllm", "http://a-very-long-computer-name-that-goes-on-and-on:8000")).not.toMatch(/-$/);
});

test("every provider Pi has built in is a name no server can take", () => {
  const missing = getBuiltinProviders().filter((id) => !RESERVED_NAMES.has(id));
  expect(missing).toEqual([]);
  expect(serverNameProblem("typesafe")).toContain("already a provider's name");
});

test("a name can't be a provider's that holds a key, a fixed server's, or anything that breaks model names", () => {
  for (const name of ["openai", "openrouter", "anthropic", "brave", "claude-subscription", "ollama", "lm-studio", "llama.cpp", "vllm"]) {
    expect(serverNameProblem(name)).toContain("already a provider's name");
  }
  for (const name of ["Ollama-Box", "ollama/box", "ollama:box", "@fast", "1box", "box-", "a".repeat(33), "my box"]) {
    expect(serverNameProblem(name)).toContain("lowercase letters");
  }
  expect(serverNameProblem("ollama-box", ["Ollama-Box"])).toContain("already taken");
  expect(serverNameProblem("ollama-box")).toBeUndefined();
});

test("a saved address is a root with no login, query or fragment", () => {
  expect(serverAddress("192.0.2.10", "ollama")).toEqual({ address: "http://192.0.2.10:11434" });
  expect(serverAddress("http://192.0.2.10:11434/api", "ollama")).toEqual({ address: "http://192.0.2.10:11434" });
  expect(serverAddress("http://192.0.2.10:8000/v1", "vllm")).toEqual({ address: "http://192.0.2.10:8000" });
  expect(serverAddress("http://u:p@192.0.2.10:8000", "vllm")).toHaveProperty("problem");
  expect(serverAddress("http://192.0.2.10:8000/?api_key=x", "vllm")).toHaveProperty("problem");
});

test("what others on the network could read: plain http to another computer, not https, this computer or a Tailscale name", () => {
  expect(readableOnTheWire("http://192.0.2.10:11434")).toBe("yes");
  expect(readableOnTheWire("https://models.example.com")).toBe("no");
  expect(readableOnTheWire("http://127.0.0.1:11434")).toBe("no");
  expect(readableOnTheWire("http://myserver.tail1234.ts.net:11434")).toBe("no");
  expect(readableOnTheWire("http://100.101.102.103:11434")).toBe("maybe");
});
