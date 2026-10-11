import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addModelServers, forgetModelServer, keyLine, type AddServerDeps } from "../src/runtime/add-model-server";
import { SERVER_SIDE_TIP } from "../src/runtime/local-models";
import type { LoginDisplay } from "../src/tui/login";
import { removeTempDir } from "./support/temp-dir";

/** The add-a-model-server screens on a scripted display, against fake servers on 127.0.0.1: nothing is written before
 * the last step, no key is ever asked for or kept, and Esc writes nothing. */

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

const ollamaRoutes = { "GET /api/version": { version: "0.12.0" }, "GET /api/tags": { models: [{ name: "qwen3:8b", capabilities: ["completion"] }] } };
const llamaRoutes = { "GET /props": { default_generation_settings: { n_ctx: 8192 } }, "GET /v1/models": { data: [{ id: "llama-3.2-1b" }] } };

type Step = { text?: string } | { choose?: string } | { cancel: true } | { fail: string };

/** A display that answers each box from `steps`, in order, and keeps what each screen showed. */
function scripted(steps: Step[]): LoginDisplay & { shown: string[]; notes: string[] } {
  const controller = new AbortController();
  const next = (kind: string, label: string): Step => {
    const step = steps.shift();
    if (!step) throw new Error(`no answer scripted for ${kind}: ${label}`);
    if ("cancel" in step) { controller.abort(); throw new Error("Input cancelled"); }
    if ("fail" in step) throw new Error(step.fail);
    return step;
  };
  const display = {
    signal: controller.signal, shown: [] as string[], notes: [] as string[],
    setNote(text: string) { display.notes.push(text); },
    wait(title: string, text: string) { display.shown.push(`${title}: ${text}`); },
    async choose<T extends string>(title: string, items: readonly { id: T; label: string }[]) {
      display.shown.push(`${title} [${items.map((item) => item.label).join(" | ")}]`);
      const step = next("choose", title) as { choose?: string };
      return items.find((item) => item.label === step.choose)?.id;
    },
    async textInput(label: string, _signal?: AbortSignal, options?: { title?: string; initial?: string; check?: (text: string) => string | undefined; hint?: string }) {
      display.shown.push(`${options?.title ?? ""}: ${label} [${options?.initial ?? ""}]${options?.hint ? ` (${options.hint})` : ""}`);
      for (;;) {
        const step = next("text", label) as { text?: string };
        const value = step.text ?? options?.initial ?? "";
        const problem = options?.check?.(value);
        if (!problem) return value;
        display.shown.push(`problem: ${problem}`);
      }
    },
    // No key box, ever.
    async privateInput(label: string): Promise<string> { throw new Error(`a key box was shown: ${label}`); },
    device() {}, browser() {},
  };
  return display;
}

async function folders(): Promise<AddServerDeps & { root: string; config: string; keyFile: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-add-server-"));
  stops.push(() => removeTempDir(root));
  const home = path.join(root, "home");
  await mkdir(path.join(home, ".casper/agent"), { recursive: true });
  return { root, home, keyFile: path.join(home, ".casper/agent/auth.json"), config: path.join(home, ".casper/config.yaml"),
    taken: () => ["openrouter"], known: () => [], timeoutMs: 2000 };
}

const configText = (file: string) => readFile(file, "utf8").catch(() => "");
const authText = (file: string) => readFile(file, "utf8").catch(() => "");

test("a bare computer finds each server on the usual ports: a name box for each, both saved, no key anywhere", async () => {
  const ollama = serve(ollamaRoutes);
  const llama = serve(llamaRoutes);
  const deps = await folders();
  // myserver's usual ports go to the two fake servers; the others are closed.
  const route: Record<string, string> = { "11434": ollama, "8080": llama };
  deps.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url instanceof Request ? url.url : url));
    const to = route[target.port];
    if (target.hostname !== "myserver" || !to) return Promise.reject(Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" }));
    return fetch(`${to}${target.pathname}`, init);
  }) as typeof fetch;
  const display = scripted([{ text: "myserver" }, {}, { text: "den-pc" }]);
  const result = await addModelServers(display, deps);
  expect(result.added.map(({ server }) => server)).toEqual([
    { name: "ollama-myserver", address: "http://myserver:11434", kind: "ollama" },
    { name: "den-pc", address: "http://myserver:8080", kind: "llama.cpp" },
  ]);
  expect(result.lines).toEqual(["Added ollama-myserver: 1 model (Ollama at myserver:11434).", "Added den-pc: 1 model (llama.cpp at myserver:8080)."]);
  expect(display.shown.some((line) => line.startsWith("Found Ollama at myserver:11434 · 1 model: Name it.") && line.includes("This link isn't encrypted"))).toBe(true);
  expect(await configText(deps.config)).toContain("name: den-pc");
  expect(await authText(deps.keyFile)).toBe("");
});

test("nothing answers: the reason once, what to set on that computer, and Cancel writes nothing", async () => {
  const deps = await folders();
  deps.fetch = (() => Promise.reject(Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" }))) as unknown as typeof fetch;
  const display = scripted([{ text: "192.0.2.10" }, { choose: "Cancel" }]);
  const result = await addModelServers(display, deps);
  expect(result).toEqual({ added: [], lines: ["No model server was added."] });
  expect(display.shown).toContain("No model server at 192.0.2.10 [Cancel | Try another address]");
  expect(display.notes.some((note) => note.startsWith("Casper found no model server there: it refused the connection") && note.includes(SERVER_SIDE_TIP))).toBe(true);
  expect(await configText(deps.config)).toBe("");
});

test("a web page answered: it isn't a model server, with no firewall tip; the address stays in the box to fix", async () => {
  const web = serve({ "GET /": () => new Response("<html>router</html>") });
  const deps = await folders();
  const display = scripted([{ text: web.replace("http://", "") }, { choose: "Try another address" }, { cancel: true }]);
  await addModelServers(display, deps);
  const why = display.notes.find((note) => note.startsWith("Casper found no model server there"))!;
  expect(why).toContain("answered, but isn't a model server");
  expect(why).not.toContain(SERVER_SIDE_TIP);
  expect(display.shown.filter((line) => line.startsWith("Add a model server: Where is the server?")).at(-1)).toContain(`[${web.replace("http://", "")}]`);
});

test("a server that asks for a key is not added: no key box, no key sent, and where to set it up instead", async () => {
  const sent: (string | null)[] = [];
  const locked = serve({ "GET /v1/models": (request: Request) => { sent.push(request.headers.get("authorization")); return Response.json({ error: "unauthorized" }, { status: 401 }); } });
  const deps = await folders();
  const result = await addModelServers(scripted([{ text: locked.replace("http://", "") }]), deps);
  expect(result).toEqual({ added: [], lines: [keyLine(locked)] });
  expect(keyLine(locked)).toBe(`The server at ${locked.replace("http://", "")} asks for a key. Casper adds servers that need none; set this one up in ~/.casper/agent/models.json (Local models in docs/CONFIGURATION.md).`);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((header) => header === null)).toBe(true);
  expect(await configText(deps.config)).toBe("");
  expect(await authText(deps.keyFile)).toBe("");
});

test("Esc at the name box writes nothing", async () => {
  const ollama = serve(ollamaRoutes);
  const deps = await folders();
  const result = await addModelServers(scripted([{ text: ollama.replace("http://", "") }, { cancel: true }]), deps);
  expect(result).toEqual({ added: [], lines: ["No model server was added."] });
  expect(await configText(deps.config)).toBe("");
});

test("two servers on one computer, one asking for a key: the other is added, and the one asking is said and skipped", async () => {
  const ollama = serve(ollamaRoutes);
  const locked = serve({ "GET /v1/models": () => Response.json({ error: "unauthorized" }, { status: 401 }) });
  const route: Record<string, string> = { "11434": ollama, "8000": locked };
  const deps = await folders();
  deps.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url instanceof Request ? url.url : url));
    const to = route[target.port];
    if (!to) return Promise.reject(Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" }));
    return fetch(`${to}${target.pathname}`, init);
  }) as typeof fetch;
  const display = scripted([{ text: "myserver" }, {}]);
  const result = await addModelServers(display, deps);
  expect(result.added.map(({ server }) => server.name)).toEqual(["ollama-myserver"]);
  expect(result.lines).toEqual(["Added ollama-myserver: 1 model (Ollama at myserver:11434).", keyLine("http://myserver:8000")]);
});

test("whatever stops the steps after one server was saved, that one is kept and said", async () => {
  const ollama = serve(ollamaRoutes);
  const llama = serve(llamaRoutes);
  const route: Record<string, string> = { "11434": ollama, "8080": llama };
  const deps = await folders();
  deps.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url instanceof Request ? url.url : url));
    const to = route[target.port];
    if (!to) return Promise.reject(Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" }));
    return fetch(`${to}${target.pathname}`, init);
  }) as typeof fetch;
  const result = await addModelServers(scripted([{ text: "myserver" }, {}, { fail: "the screen went away" }]), deps);
  expect(result.added.map(({ server }) => server.name)).toEqual(["ollama-myserver"]);
  expect(result.lines.at(-1)).toBe("Stopped: the screen went away");
  expect(await configText(deps.config)).toContain("name: ollama-myserver");
});

test("a name already used by a provider is refused in the name box", async () => {
  const ollama = serve(ollamaRoutes);
  const deps = await folders();
  const display = scripted([{ text: ollama.replace("http://", "") }, { text: "openrouter" }, { text: "brave" }, { text: "my-box" }]);
  const result = await addModelServers(display, deps);
  expect(result.added[0]!.server.name).toBe("my-box");
  expect(display.shown).toContain("problem: openrouter is already a provider's name. Pick another.");
  expect(display.shown).toContain("problem: brave is already a provider's name. Pick another.");
});

test("the same server twice is caught; a server with no models is saved with what to do on that computer", async () => {
  const empty = serve({ "GET /api/version": { version: "0.12.0" }, "GET /api/tags": { models: [] } });
  const deps = await folders();
  deps.known = () => [{ name: "my-ollama", root: empty }];
  const twice = await addModelServers(scripted([{ text: empty.replace("http://", "") }]), deps);
  expect(twice).toEqual({ added: [], lines: [`You already have Ollama at ${empty.replace("http://", "")} as my-ollama.`] });
  deps.known = () => [];
  const fresh = await addModelServers(scripted([{ text: empty.replace("http://", "") }, {}]), deps);
  expect(fresh.lines[0]).toContain("but it has no models yet. On that computer run ollama pull qwen3.");
});

test("forgetting a server takes out its config entry only: the login file is never touched", async () => {
  const deps = await folders();
  const signIns = JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-real-0000000000" } });
  await writeFile(deps.keyFile, signIns);
  const ollama = serve(ollamaRoutes);
  const result = await addModelServers(scripted([{ text: ollama.replace("http://", "") }, { text: "ollama-box" }]), deps);
  expect(result.added).toHaveLength(1);
  expect(await configText(deps.config)).toContain("name: ollama-box");
  await forgetModelServer("ollama-box", deps);
  expect(await configText(deps.config)).not.toContain("ollama-box");
  // A name that isn't one of your servers: nothing happens to the sign-in under it.
  await forgetModelServer("openrouter", deps).catch(() => undefined);
  expect(await authText(deps.keyFile)).toBe(signIns);
});
