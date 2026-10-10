import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { serverRoot } from "../runtime/local-models";
import { USER_CONFIG } from "./user-write";

/** Model servers you added yourself (`/model` → `+ Add server`, or `/login`), kept in ~/.casper/config.yaml only:
 *
 * ```yaml
 * modelServers:
 *   - name: ollama-myserver
 *     address: http://192.0.2.10:11434
 *     kind: ollama
 * ```
 *
 * The address and name only, never a key: the AI can read this file, and Casper adds only servers that need no key
 * (one that does goes in models.json). A project or a profile can't add one. */

/** `openai`: any other server that answers an OpenAI-style model list (LocalAI, SGLang, TabbyAPI…). */
export const SERVER_KINDS = ["ollama", "lm-studio", "llama.cpp", "vllm", "openai"] as const;
export type ServerKind = typeof SERVER_KINDS[number];

export interface ModelServer {
  /** The provider name: the first half of its models' names (ollama-myserver/qwen3:8b). */
  name: string;
  /** Its root address (no /v1), as `serverRoot` writes it. */
  address: string;
  kind: ServerKind;
}

export const KIND_NAMES: Record<ServerKind, string> = { ollama: "Ollama", "lm-studio": "LM Studio", "llama.cpp": "llama.cpp", vllm: "vLLM", openai: "OpenAI-style server" };
export const KIND_PREFIX: Record<ServerKind, string> = { ollama: "ollama", "lm-studio": "lm-studio", "llama.cpp": "llama-cpp", vllm: "vllm", openai: "server" };
const DEFAULT_PORT: Record<ServerKind, number> = { ollama: 11434, "lm-studio": 1234, "llama.cpp": 8080, vllm: 8000, openai: 8000 };

/** Names a server can never take: Pi's built-in providers (checked against Pi in tests/model-servers.test.ts), the web
 * search key's, Claude's plan's and the four servers Casper looks for on this computer. A server under one of them would
 * never be used. When you add one, the names in use right now (models.json, your sign-ins) are refused too. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "amazon-bedrock", "ant-ling", "anthropic", "azure", "baseten", "cerebras", "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek",
  "fireworks", "github-copilot", "google", "google-vertex", "groq", "huggingface", "kimi-coding", "meta", "minimax", "minimax-cn", "mistral",
  "moonshotai", "moonshotai-cn", "nvidia", "openai", "openai-codex", "opencode", "opencode-go", "openrouter", "qwen-token-plan",
  "qwen-token-plan-cn", "qwen-token-plan-individual", "radius", "together", "typesafe", "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai", "zai-coding-cn",
  "brave", "claude-subscription", "ollama", "lm-studio", "llama.cpp", "vllm",
]);

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_MODEL_SERVERS = 32;

/** Why a name can't be a server's, in plain words, or undefined when it can. `taken`: names already in use. */
export function serverNameProblem(name: string, taken: Iterable<string> = []): string | undefined {
  if (RESERVED_NAMES.has(name)) return `${name} is already a provider's name. Pick another.`;
  if (!NAME.test(name) || name.endsWith("-")) return "Use lowercase letters, numbers and dashes, starting with a letter (32 at most).";
  for (const other of taken) if (other.toLowerCase() === name) return `${name} is already taken. Pick another.`;
  return undefined;
}

/** An address as a server's root (http or https, no /v1), or why it can't be one. A login, query or fragment is refused:
 * it may carry a key, and the AI can read this file. */
export function serverAddress(raw: string, kind: ServerKind): { address: string } | { problem: string } {
  const value = raw.trim();
  if (!value) return { problem: "Type an address, like 192.0.2.10 or myserver:11434." };
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`); }
  catch { return { problem: "Casper can't read that address. Try 192.0.2.10 or myserver:11434." }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { problem: "Use an http:// or https:// address." };
  if (url.username || url.password) return { problem: "Leave the name and password out of the address." };
  if (url.search || url.hash) return { problem: "Leave the ? or # part out of the address." };
  const root = serverRoot(value, DEFAULT_PORT[kind], kind === "ollama");
  return root ? { address: root } : { problem: "Casper can't read that address. Try 192.0.2.10 or myserver:11434." };
}

const isMapping = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Your list of servers from config.yaml. Only a value that isn't a list stops the load; a bad entry is skipped with a
 * warning, so one bad line never keeps Casper from starting (adding or forgetting a server leaves it as it is). */
export function parseModelServers(value: unknown, label: string): { servers: ModelServer[]; warnings: string[] } {
  if (value === undefined || value === null) return { servers: [], warnings: [] };
  if (!Array.isArray(value)) throw new Error(`${label}: modelServers must be a list`);
  const servers: ModelServer[] = [];
  const warnings: string[] = [];
  value.forEach((entry, index) => {
    const at = `${label}: modelServers[${index}]`;
    if (!isMapping(entry)) { warnings.push(`${at} skipped: each server is a name, an address and a kind`); return; }
    if (entry.key !== undefined || entry.apiKey !== undefined) {
      warnings.push(`${at} skipped: keys don't go in config.yaml (the AI can read it); a server that needs a key goes in ~/.casper/agent/models.json`);
      return;
    }
    const kind = SERVER_KINDS.find((known) => known === entry.kind);
    if (!kind) { warnings.push(`${at} (kind ${String(entry.kind)}) skipped: kind must be ${SERVER_KINDS.join(", ")}`); return; }
    const name = typeof entry.name === "string" ? entry.name : "";
    const problem = serverNameProblem(name, servers.map((server) => server.name));
    if (problem) { warnings.push(`${at} (${name || "no name"}) skipped: ${problem}`); return; }
    const address = typeof entry.address === "string" ? serverAddress(entry.address, kind) : { problem: "it has no address" };
    if ("problem" in address) { warnings.push(`${at} (${name}) skipped: ${address.problem}`); return; }
    if (servers.length >= MAX_MODEL_SERVERS) { warnings.push(`${at} (${name}) skipped: at most ${MAX_MODEL_SERVERS} servers`); return; }
    for (const key of Object.keys(entry)) if (!["name", "address", "kind"].includes(key)) warnings.push(`${at}: unknown key ${key} (ignored)`);
    servers.push({ name, address: address.address, kind });
  });
  return { servers, warnings };
}

/** Add or take out one server in <home>/.casper/config.yaml's modelServers, keeping every other setting, every other
 * entry (one skipped at load too) and their comments; the file is replaced in one step, refused when it is a link or
 * doesn't parse, and what is written must read back. Returns your servers as they now read. */
async function editServers(home: string, edit: { add: ModelServer } | { remove: string }): Promise<ModelServer[]> {
  const folder = path.join(home, ".casper");
  const file = path.join(folder, "config.yaml");
  let before: string | undefined;
  let mode = 0o600;
  try {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`${USER_CONFIG} is not a plain file (a link?); refusing to change it`);
    mode = info.mode & 0o777;
    before = await readFile(file, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const document = parseDocument(before ?? "");
  if (document.errors.length) throw new Error(`${USER_CONFIG} does not parse (${document.errors[0]!.message.split("\n")[0]}); fix it first`);
  if (document.contents !== null && !isMap(document.contents)) throw new Error(`${USER_CONFIG} is not a mapping; refusing to change it`);
  const current = document.get("modelServers");
  if (current !== undefined && current !== null && !isSeq(current)) throw new Error(`modelServers in ${USER_CONFIG} is not a list; refusing to change it`);
  const name = "add" in edit ? edit.add.name : edit.remove;
  if ("add" in edit) {
    const others = parseModelServers((document.toJSON() as Record<string, unknown> | null)?.modelServers, USER_CONFIG).servers.filter((entry) => entry.name !== name);
    if (others.length >= MAX_MODEL_SERVERS) throw new Error(`You already have ${MAX_MODEL_SERVERS} servers; forget one in /model first.`);
  } else if (!isSeq(current)) return [];
  // Only entries of that name change; the others stay as they are written.
  const list = isSeq(current) ? current : undefined;
  if (list) list.items = list.items.filter((item) => !(isMap(item) && item.get("name") === name));
  if ("add" in edit) {
    const { address, kind } = edit.add;
    if (list) list.items.push(document.createNode({ name, address, kind }));
    else document.set("modelServers", document.createNode([{ name, address, kind }]));
  } else if (list && list.items.length === 0) document.delete("modelServers");
  const written = parseModelServers((document.toJSON() as Record<string, unknown> | null)?.modelServers, USER_CONFIG).servers;
  const there = written.find((entry) => entry.name === name);
  if ("add" in edit ? there?.address !== edit.add.address || there.kind !== edit.add.kind : there) {
    throw new Error(`Casper couldn't write a valid modelServers list to ${USER_CONFIG}`);
  }
  // Nothing left but comments: keep them, not an empty "{}".
  const emptied = isMap(document.contents) && document.contents.items.length === 0;
  const comments = (before ?? "").split("\n").filter((line) => /^\s*#/.test(line)).join("\n");
  const text = emptied ? (comments ? `${comments}\n` : "") : document.toString();
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = path.join(folder, `.config.yaml.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { mode, flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return written;
}

/** Add one server you checked (or replace the one of that name). */
export function addModelServer(home: string, server: ModelServer): Promise<ModelServer[]> {
  const problem = serverNameProblem(server.name);
  if (problem) return Promise.reject(new Error(problem));
  return editServers(home, { add: server });
}

/** Forget one server by name. */
export function removeModelServer(home: string, name: string): Promise<ModelServer[]> {
  return editServers(home, { remove: name });
}
