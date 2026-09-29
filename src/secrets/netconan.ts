import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../platform/environment";
import { osSupportsProcessGroups, ownSpawnedTree, terminateTree } from "../platform/processes";
import type { SecretKind } from "./patterns";
import {
  LINE_MARKER, SECRET_MARKER, configStrings, hiddenNote, looksLikeDeviceConfig, scrubText, scrubValue,
  type ScrubTextResult, type ScrubValueResult,
} from "./scrub";

/**
 * netconan (https://github.com/intentionet/netconan) is an optional extra
 * check. It misses Aruba secrets and rewrites keywords, so Casper's own rules
 * always run first on the original text and netconan can only add markers.
 * Its fake replacement values never reach the AI.
 */

export type NetconanLocation = { state: "off" } | { state: "not-found" } | { state: "found"; path: string };
export type NetconanStatus = "ok" | "skipped" | "failed";

export const NETCONAN_MAX_BYTES = 2 * 1024 * 1024;
export const NETCONAN_TIMEOUT_MS = 10_000;
export const NETCONAN_FAILED = "netconan did not finish; built-in scrub used.";

async function executable(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

/** CASPER_NETCONAN=off turns it off, CASPER_NETCONAN=<path> picks one, otherwise "netconan" on PATH. */
export async function findNetconan(env: NodeJS.ProcessEnv = process.env): Promise<NetconanLocation> {
  const setting = env.CASPER_NETCONAN?.trim();
  if (setting && setting.toLowerCase() === "off") return { state: "off" };
  if (setting) {
    const file = path.resolve(setting);
    return await executable(file) ? { state: "found", path: file } : { state: "not-found" };
  }
  const names = process.platform === "win32" ? ["netconan.exe", "netconan.cmd", "netconan.bat", "netconan"] : ["netconan"];
  for (const folder of (env.PATH ?? "").split(path.delimiter)) {
    if (!folder || !path.isAbsolute(folder)) continue;
    for (const name of names) {
      const file = path.join(folder, name);
      if (await executable(file)) return { state: "found", path: file };
    }
  }
  return { state: "not-found" };
}

interface RunResult { code: number | null; timedOut: boolean; stdout: string }

function netconanEnvironment(folder: string): Record<string, string> {
  // A pip --user install lives under the real home; point Python at it while HOME is the temp folder.
  const userBase = process.env.PYTHONUSERBASE ?? (process.platform === "win32" ? undefined : path.join(os.homedir(), ".local"));
  return isolatedEnvironment(folder, { PYTHONDONTWRITEBYTECODE: "1", ...(userBase ? { PYTHONUSERBASE: userBase } : {}) });
}

/** argv only, no shell; the whole process tree is killed on timeout or abort. */
function run(file: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
    const child = spawn(file, args, { cwd, env: netconanEnvironment(cwd), shell: false, detached: osSupportsProcessGroups,
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const alive = () => child.exitCode === null && child.signalCode === null;
    const owner = ownSpawnedTree(child.pid, alive);
    let stdout = "";
    let timedOut = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { if (stdout.length < 4096) stdout += chunk; });
    const kill = () => { void terminateTree(owner, child.pid, "SIGKILL", alive); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, timedOut, stdout });
    });
  });
}

export interface NetconanPassOptions {
  path: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Parent for the private temp folder (default: the OS temp folder). */
  tmpRoot?: string;
}
export type NetconanPassResult = { status: "ok"; text: string } | { status: "skipped" } | { status: "failed" };

/**
 * Run netconan -p on one text. The text goes into a 0600 file inside a 0700
 * temp folder (never through argv) and the folder is removed afterwards.
 */
export async function netconanPass(original: string, options: NetconanPassOptions): Promise<NetconanPassResult> {
  if (Buffer.byteLength(original) > NETCONAN_MAX_BYTES || !looksLikeDeviceConfig(original)) return { status: "skipped" };
  let folder: string | undefined;
  try {
    folder = await mkdtemp(path.join(options.tmpRoot ?? os.tmpdir(), "casper-netconan-"));
    await chmod(folder, 0o700);
    const input = path.join(folder, "in.cfg");
    const output = path.join(folder, "out.cfg");
    await writeFile(input, original, { mode: 0o600, flag: "wx" });
    await chmod(input, 0o600);
    const result = await run(options.path, ["-p", "-i", input, "-o", output, "-l", "ERROR"], folder,
      options.timeoutMs ?? NETCONAN_TIMEOUT_MS, options.signal);
    if (result.timedOut || result.code !== 0) return { status: "failed" };
    const info = await stat(output);
    if (!info.isFile() || info.size > NETCONAN_MAX_BYTES * 2 + 65_536) return { status: "failed" };
    return { status: "ok", text: await readFile(output, "utf8") };
  } catch {
    options.signal?.throwIfAborted();
    return { status: "failed" };
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

/** Marker-aware tokens: "<secret hidden>" (with any quotes or ; around it) counts as one token. */
function tokens(line: string): string[] {
  return line.match(/\S*<secret hidden>\S*|\S*<line hidden: secret>\S*|\S+/g) ?? [];
}
/** netconan rewrites these words itself; they are syntax, never the secret. */
const SYNTAX_TOKEN = /^(?:plaintext|ciphertext|encrypted|sha1|sha|md5|aes|des|[0-9])$/i;

/**
 * Combine Casper's result (built from the original) with what netconan
 * changed. A line netconan changed but Casper did not: each changed word
 * becomes the marker, or the whole line becomes "<line hidden: secret>" when
 * netconan added or removed words. A line Casper already changed only gains
 * markers for words netconan changed that Casper left. Nothing from
 * netconan's output is copied, so its fake values never reach the AI.
 */
export function mergeNetconan(original: string, builtIn: ScrubTextResult, netconanText: string): ScrubTextResult & { aligned: boolean } {
  const split = (text: string) => { const lines = text.split("\n"); if (lines.length > 1 && lines.at(-1) === "") lines.pop(); return lines; };
  const originalLines = split(original);
  const builtInLines = split(builtIn.text);
  const netconanLines = split(netconanText);
  if (originalLines.length !== netconanLines.length || originalLines.length !== builtInLines.length) {
    return { ...builtIn, aligned: false };
  }
  let hidden = builtIn.hidden;
  const kinds = new Set<SecretKind>(builtIn.kinds);
  const clean = (line: string) => line.replace(/\r$/, "");
  for (let index = 0; index < originalLines.length; index++) {
    const before = clean(originalLines[index]!);
    const theirs = clean(netconanLines[index]!);
    if (before === theirs) continue;
    const ours = clean(builtInLines[index]!);
    const carriage = originalLines[index]!.endsWith("\r") ? "\r" : "";
    const beforeTokens = tokens(before);
    const theirTokens = tokens(theirs);
    const oursTokens = tokens(ours);
    const casperChanged = ours !== before;
    const differing = beforeTokens.filter((word, position) => word !== theirTokens[position]).length;
    // netconan replaced the whole line (a "! Sensitive line SCRUBBED" comment), not single words.
    const replaced = /^\s*[!#]/.test(theirs) !== /^\s*[!#]/.test(before) || differing > Math.max(2, beforeTokens.length / 2);
    if (beforeTokens.length !== theirTokens.length || replaced) {
      if (casperChanged) continue; // Casper already hid this line's secret; keep its more useful line.
      builtInLines[index] = LINE_MARKER + carriage;
      hidden++;
      kinds.add("password");
      continue;
    }
    if (oursTokens.length !== beforeTokens.length) {
      // Casper changed the line and the words no longer line up: hide the whole line to be safe.
      builtInLines[index] = LINE_MARKER + carriage;
      hidden++;
      kinds.add("password");
      continue;
    }
    let changed = false;
    for (let position = 0; position < beforeTokens.length; position++) {
      const word = beforeTokens[position]!;
      if (word === theirTokens[position] || oursTokens[position] !== word || SYNTAX_TOKEN.test(word)) continue;
      const quote = /^(["'])(.*)\1([;,]?)$/.exec(word);
      oursTokens[position] = quote ? `${quote[1]}${SECRET_MARKER}${quote[1]}${quote[3]}` : SECRET_MARKER + (/[;,]$/.test(word) ? word.at(-1) : "");
      hidden++;
      kinds.add("password");
      changed = true;
    }
    if (!changed) continue;
    const indent = /^\s*/.exec(ours)![0];
    builtInLines[index] = indent + oursTokens.join(" ") + carriage;
  }
  const ordered = (["password", "hash", "key", "psk", "community", "private-key"] as SecretKind[]).filter((kind) => kinds.has(kind));
  const trailing = builtIn.text.endsWith("\n") ? "\n" : "";
  return { text: hidden === builtIn.hidden ? builtIn.text : builtInLines.join("\n") + trailing, hidden, kinds: ordered, aligned: true };
}

export interface ScrubOutcome<T> extends ScrubValueResult<T> { netconan: NetconanStatus | "off" | "not-found" }

export interface ScrubberOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  tmpRoot?: string;
  /** Most config texts per result sent through netconan (default 4). */
  maxNetconanRuns?: number;
}

/**
 * One shared scrubber: Casper's rules every time, plus netconan when it is
 * installed. netconan is looked up once. Any netconan failure falls back to
 * Casper's result and is reported in /secrets.
 */
export class Scrubber {
  private location?: Promise<NetconanLocation>;
  private version?: Promise<string | undefined>;
  private lastFailed = false;

  constructor(private readonly options: ScrubberOptions = {}) {}

  netconan(): Promise<NetconanLocation> {
    this.location ??= findNetconan(this.options.env ?? process.env);
    return this.location;
  }

  /** True when the last netconan run did not finish. */
  get netconanFailed(): boolean { return this.lastFailed; }

  async scrubText(text: string, signal?: AbortSignal): Promise<ScrubTextResult & { netconan: ScrubOutcome<string>["netconan"] }> {
    const result = await this.scrubValue(text, signal);
    return { text: result.value, hidden: result.hidden, kinds: result.kinds, netconan: result.netconan };
  }

  async scrubValue<T>(value: T, signal?: AbortSignal): Promise<ScrubOutcome<T>> {
    const location = await this.netconan();
    if (location.state !== "found") return { ...scrubValue(value), netconan: location.state };
    const texts = configStrings(value, this.options.maxNetconanRuns ?? 4);
    if (!texts.length) return { ...scrubValue(value), netconan: "skipped" };
    const extra = new Map<string, string>();
    let status: NetconanStatus = "ok";
    for (const text of texts) {
      signal?.throwIfAborted();
      const pass = await netconanPass(text, { path: location.path, signal, timeoutMs: this.options.timeoutMs, tmpRoot: this.options.tmpRoot });
      if (pass.status === "ok") extra.set(text, pass.text);
      else if (pass.status === "failed") status = "failed";
    }
    signal?.throwIfAborted();
    this.lastFailed = status === "failed";
    const result = scrubValue(value, (text) => {
      const builtIn = scrubText(text);
      const theirs = extra.get(text);
      if (theirs === undefined) return builtIn;
      const merged = mergeNetconan(text, builtIn, theirs);
      if (!merged.aligned) status = "failed";
      return merged;
    });
    this.lastFailed = status === "failed";
    return { ...result, netconan: status };
  }

  private netconanVersion(file: string): Promise<string | undefined> {
    this.version ??= (async () => {
      let folder: string | undefined;
      try {
        folder = await mkdtemp(path.join(this.options.tmpRoot ?? os.tmpdir(), "casper-netconan-"));
        const result = await run(file, ["--version"], folder, 5000);
        return /\d+\.\d+(?:\.\d+)?/.exec(result.stdout)?.[0];
      } catch { return undefined; }
      finally { if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {}); }
    })();
    return this.version;
  }

  /** The /secrets text. */
  async statusText(filesOn: boolean): Promise<string> {
    const location = await this.netconan();
    let extra: string;
    if (location.state === "found") {
      const version = await this.netconanVersion(location.path);
      extra = `netconan ${version ? `${version} ` : ""}(found)`;
    } else extra = location.state === "off" ? "netconan off (built-in only)" : "netconan not found (built-in only)";
    const lines = [`Secrets: hidden in MCP results (always). Files and command output: ${filesOn ? "on" : "off"}. Extra check: ${extra}.`];
    if (this.lastFailed) lines.push(NETCONAN_FAILED);
    return lines.join("\n");
  }
}

/** The note added to a tool result: how many secrets were hidden, and whether netconan failed. */
export function scrubNote(result: { hidden: number; kinds: readonly SecretKind[]; netconan?: string }): string {
  return [hiddenNote(result.hidden, result.kinds), result.netconan === "failed" ? NETCONAN_FAILED : ""].filter(Boolean).join(" ");
}
