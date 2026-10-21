import { DEFAULT_PORT, KIND_NAMES, KIND_PREFIX, serverNameProblem, type ServerKind } from "../config/model-servers";
import { failureWords, localModelDefaults, NotThisServer, onThisComputer, readServerModels, sameAddress, serverRoot, type LocalCause, type LocalModel } from "./local-models";

/** Adding a model server on another computer (`/model` → `+ Add server`, or `/login`): reading what you typed,
 * finding out what answers there, and suggesting a name. The screens are in src/runtime/add-model-server.ts. */

/** The ports to try when you give a computer but no port, and what usually listens there. */
export const USUAL_PORTS: ReadonlyArray<{ port: number; kind: ServerKind }> = [
  { port: 11434, kind: "ollama" }, { port: 1234, kind: "lm-studio" }, { port: 8080, kind: "llama.cpp" }, { port: 8000, kind: "vllm" },
  { port: 30000, kind: "sglang" },
];

/** What you typed, as the roots (no /v1) to look at, and the computer's name for the screens. */
export type ReadAddress = { roots: string[]; host: string } | { problem: string };

/** Read an address: a bare computer (`192.0.2.10`, `myserver`) or `http://` one with no port gives the usual ports;
 * `https://` with no port is 443; `host:port` or a full URL is that one. A login, query or fragment is refused: it may
 * carry a key, and the address is kept in a file the AI can read. With a chosen kind, a bare HTTP host uses its port. */
export function readAddress(raw: string, kind?: ServerKind): ReadAddress {
  const value = raw.trim();
  if (!value) return { problem: "Type an address, like 192.0.2.10 or myserver:11434." };
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  let url: URL;
  try { url = new URL(scheme ? value : `http://${value}`); }
  catch { return { problem: "Casper can't read that address. Try 192.0.2.10 or myserver:11434." }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { problem: "Use an http:// or https:// address." };
  if (url.username || url.password) return { problem: "Leave the name and password out of the address." };
  if (url.search || url.hash) return { problem: "Leave the ? or # part out of the address." };
  if (!url.hostname) return { problem: "Casper can't read that address. Try 192.0.2.10 or myserver:11434." };
  const host = url.host;
  // A copied API address (…/v1/models, …/api/tags) is the server's address with the API path after it.
  url.pathname = url.pathname.replace(/\/(?:v1(?:\/models|\/chat\/completions)?|api(?:\/v0\/models|\/tags|\/version)?|models|chat\/completions|props|health)\/?$/i, "") || "/";
  const bare = url.pathname === "/" || url.pathname === "";
  // URL.port drops an explicit :80. Keep it distinct from a host with no port (IPv6 brackets stay intact).
  const authority = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/, 1)[0]!;
  const explicitPort = /:\d+$/.test(authority);
  if (!url.port && !explicitPort && bare && url.protocol === "http:") {
    // 0.0.0.0 is how a server listens everywhere; here it means this computer.
    const hostname = url.hostname === "0.0.0.0" ? "127.0.0.1" : url.hostname;
    const ports = kind ? [DEFAULT_PORT[kind]] : USUAL_PORTS.map(({ port }) => port);
    return { roots: ports.map((port) => `http://${hostname}:${port}`), host: hostname };
  }
  const root = serverRoot(url.href, url.protocol === "https:" ? 443 : 80, true);
  return root ? { roots: [root], host } : { problem: "Casper can't read that address. Try 192.0.2.10 or myserver:11434." };
}

/** What answered at one root. */
export type Detected =
  | { state: "found"; root: string; kind: ServerKind; models: LocalModel[] }
  /** A model server that wants a key (a JSON 401/403, or `WWW-Authenticate: Bearer`); its kind is a guess from the port. */
  | { state: "key"; root: string; kind: ServerKind }
  | { state: "none"; root: string; cause: LocalCause | "login"; words: string };

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;

/** A 401/403: a model API's (`modelApi`: a JSON body or a Bearer challenge) or a sign-in page's; `kind` when only one
 * kind locks that path. */
class Locked extends Error { constructor(readonly modelApi: boolean, readonly kind?: ServerKind) { super("locked"); } }

/** One GET that answers JSON, or undefined for an answer that isn't (404, a web page). A 401/403 is `Locked`: a model
 * API's (JSON body or a Bearer challenge) or a sign-in page's. */
async function json(fetcher: typeof fetch, url: string, signal: AbortSignal): Promise<Json | undefined> {
  const response = await fetcher(url, { signal, redirect: "error" });
  if (response.status === 401 || response.status === 403) {
    const bearer = /bearer/i.test(response.headers.get("www-authenticate") ?? "");
    const body = await response.text().catch(() => "");
    let parsed = false;
    try { JSON.parse(body); parsed = true; } catch { /* not JSON */ }
    throw new Locked(bearer || parsed);
  }
  if (!response.ok) { await response.body?.cancel(); return undefined; }
  return record(await response.json().catch(() => undefined));
}

/** The kind that answers at `root`: checks only one kind passes come first, whatever the port, so llama.cpp started on
 * 8000 is llama.cpp. A plain OpenAI-style model list is vLLM only when it says so. */
async function kindAt(fetcher: typeof fetch, root: string, signal: AbortSignal): Promise<ServerKind> {
  const ask = (path: string) => json(fetcher, `${root}${path}`, signal);
  const [sglang, props, lmStudio, version, tags, models] = await Promise.allSettled([
    ask("/get_model_info"), ask("/props"), ask("/api/v0/models"), ask("/api/version"), ask("/api/tags"), ask("/v1/models"),
  ]);
  const all = [sglang, props, lmStudio, version, tags, models];
  const ok = (result: PromiseSettledResult<Json | undefined>) => result.status === "fulfilled" ? result.value : undefined;
  const locked = all.find((result) => result.status === "rejected" && result.reason instanceof Locked);
  const list = ok(models)?.data;
  const ownedBy = (owner: string) => Array.isArray(list) && list.some((entry) => record(entry)?.owned_by === owner);
  // SGLang: model_path on /get_model_info (now an alias of /model_info), and ModelCard.owned_by.
  // https://github.com/sgl-project/sglang/tree/main/python/sglang/srt/entrypoints (http_server.py, openai/protocol.py)
  if (typeof ok(sglang)?.model_path === "string" || ownedBy("sglang")) return "sglang";
  // https://github.com/waybarrios/vllm-mlx/blob/main/vllm_mlx/api/models.py: ModelInfo.owned_by.
  if (ownedBy("vllm-mlx")) return "mlx";
  // mlx-lm/server.py (https://github.com/ml-explore/mlx-lm): ids/object/created only, generic Python header.
  // An mlx-community/... id names a model, not its server; without a marker keep the OpenAI-style fallback.
  if (record(ok(props)?.default_generation_settings)) return "llama.cpp";
  // llama-server --api-key leaves its model lists open but locks /props: it wants the key (it isn't Ollama).
  if (props.status === "rejected" && props.reason instanceof Locked && props.reason.modelApi) throw new Locked(true, "llama.cpp");
  const studio = ok(lmStudio)?.data;
  if (Array.isArray(studio) && studio.some((entry) => typeof record(entry)?.type === "string")) return "lm-studio";
  if (ownedBy("llamacpp")) return "llama.cpp";
  // Ollama tells its version; an older one, at least its own model list (llama.cpp, which may answer it too, is above).
  if (typeof ok(version)?.version === "string" || Array.isArray(ok(tags)?.models)) return "ollama";
  if (Array.isArray(list)) return list.some((entry) => record(entry)?.owned_by === "vllm" || record(entry)?.max_model_len !== undefined) ? "vllm" : "openai";
  if (locked) throw (locked as PromiseRejectedResult).reason;
  // Nothing answered as a model server: the first error (refused, timed out…) says why; else something answered there
  // (a web page, a 404), but not a model server.
  const failed = all.find((result) => result.status === "rejected");
  throw failed ? (failed as PromiseRejectedResult).reason : new NotThisServer();
}

/** Look at one root: what kind of server is there and its models. A found server is the kind its own answers show; a
 * chosen kind names one that only answers a plain OpenAI-style list, and one that wants a key. No key is sent. */
export async function detectServer(root: string, options: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; kind?: ServerKind } = {}): Promise<Detected> {
  const fetcher = options.fetch ?? localModelDefaults.detectFetch ?? fetch;
  const budget = options.timeoutMs ?? 10_000;
  const timer = AbortSignal.timeout(budget);
  const signal = AbortSignal.any([timer, ...(options.signal ? [options.signal] : [])]);
  const usual = USUAL_PORTS.find(({ port }) => new URL(root).port === String(port))?.kind ?? "openai";
  let kind = options.kind ?? usual;
  try {
    const detected = await kindAt(fetcher, root, signal);
    kind = options.kind ?? detected;
    // A chosen kind fills in only what detection can't tell (a plain OpenAI-style list): one the server's own answers
    // contradict (llama.cpp picked, Ollama answering) would be saved as a kind it isn't.
    const found = detected === "openai" ? kind : detected;
    const models = await readServerModels(found, root, { fetch: fetcher, signal });
    return { state: "found", root, kind: found, models };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof Locked) {
      return error.modelApi ? { state: "key", root, kind: options.kind ?? error.kind ?? usual }
        : { state: "none", root, cause: "login", words: "asked for a sign-in Casper doesn't know (a web page's, not a model server's)" };
    }
    const { cause, words } = failureWords(error, timer.aborted, "a model server", root, budget);
    if (cause === "key") return { state: "key", root, kind };
    return { state: "none", root, cause, words };
  }
}

/** A name for a server found at `root`, from its kind and computer: `ollama-myserver`, `ollama-192-0-2-10`, with the port
 * when it isn't the kind's usual one, and `-2`, `-3` when taken. Lowercase letters, numbers and dashes, 32 at most. */
export function autoName(kind: ServerKind, root: string, taken: Iterable<string> = []): string {
  const url = new URL(root);
  const hostname = url.hostname.toLowerCase();
  const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
  const ipv6 = hostname.startsWith("[");
  const host = ipv4 ? hostname.replaceAll(".", "-")
    : ipv6 ? hostname.replace(/[[\]]/g, "").split(":").filter(Boolean).at(-1) ?? "ipv6"
    : hostname.split(".")[0]!;
  const usual = kind === "openai" ? undefined : DEFAULT_PORT[kind];
  const port = url.port && Number(url.port) !== usual ? `-${url.port}` : "";
  const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const base = clean(`${KIND_PREFIX[kind]}-${clean(host) || "server"}${port}`).slice(0, 32).replace(/-+$/, "");
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  if (!serverNameProblem(base, used)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const name = `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!serverNameProblem(name, used)) return name;
  }
}

/** Plain words for a found server: "Ollama at myserver:11434". */
export function serverLabel(kind: ServerKind, root: string): string {
  let host = root;
  try { host = new URL(root).host; } catch { /* the root as is */ }
  return `${KIND_NAMES[kind]} at ${host}`;
}

/** Whether what is sent to `root` can be read by others on the network: plain http to another computer that isn't a
 * Tailscale name. A 100.64/10 address may be Tailscale (encrypted) or a carrier's, so it gets its own words. */
export function readableOnTheWire(root: string): "no" | "yes" | "maybe" {
  const url = new URL(root);
  if (url.protocol === "https:" || onThisComputer(root) || url.hostname.endsWith(".ts.net")) return "no";
  const [a, b] = url.hostname.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127 ? "maybe" : "yes";
}

/** The name of a server Casper or you already have at this root, if any. */
export function alreadyAt(root: string, known: ReadonlyArray<{ name: string; root: string }>): string | undefined {
  return known.find((entry) => sameAddress(entry.root, root))?.name;
}
