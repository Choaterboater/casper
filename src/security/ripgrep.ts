import path from "node:path";
import { stat } from "node:fs/promises";
import { installBinary, onPath, pinnedCopy, readCapped, type InstallOptions } from "./install";
import { RIPGREP } from "./ripgrep-pin";
import type { PinnedSpec } from "./tools";

/**
 * Casper fetches its own ripgrep instead of asking you to install it. The shell sandbox (Linux) and the AI's
 * grep tool both need `rg`. Order: a ripgrep on PATH (or Pi's own copy in the agent folder) is used as it is;
 * else the pinned copy in ~/.casper/tools; else, unless downloads are off or Casper is offline, the pinned
 * release is downloaded once, checked against its sha256 before anything is written, and unpacked. A failure is
 * one plain line and nothing else changes. Nothing here uses sudo or a package manager.
 */

export const RIPGREP_GETTING = "Getting ripgrep (one time, about 5 MB)";

export interface RipgrepOptions extends Omit<InstallOptions, "write" | "fetchBytes"> {
  /** Tests: the pinned download to use in place of Casper's own. */
  spec?: PinnedSpec;
  /** `tools.downloads: off` in your own config turns the download off. */
  downloads?: boolean;
  /** Pi's agent folder: a ripgrep Pi downloaded into its bin/ counts as one you have. */
  agentDir?: string;
  /** Plain progress and failure lines. */
  write?: (text: string) => void;
  /** Downloads one URL (tests pass a stub). */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
}

export type RipgrepResult =
  | { source: "path" | "agent" | "pinned" | "installed"; path: string }
  | { source: "none"; why: "off" | "offline" | "unsupported" | "failed"; message?: string };

const FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`download failed (HTTP ${response.status})`);
  return readCapped(response);
}

const isFile = (file: string) => stat(file).then((details) => details.isFile(), () => false);

/** The offline switches: Casper's own, and the engine's. */
function offline(env: NodeJS.ProcessEnv): boolean {
  return env.CASPER_OFFLINE === "1" || env.PI_OFFLINE === "1";
}

let inFlight: Promise<RipgrepResult> | undefined;

/** Finds ripgrep, fetching the pinned copy when there is none. Never throws. At most one fetch per process. */
export function ensureRipgrep(options: RipgrepOptions): Promise<RipgrepResult> {
  inFlight ??= find(options);
  return inFlight;
}

/** Tests only: forget the process's answer. */
export function resetRipgrep(): void { inFlight = undefined; }

async function find(options: RipgrepOptions): Promise<RipgrepResult> {
  const env = options.env ?? process.env;
  const spec = options.spec ?? RIPGREP;
  const platform = options.platform ?? process.platform;
  try {
    const onPathFile = await onPath("rg", env, platform);
    if (onPathFile) return { source: "path", path: onPathFile };
    if (options.agentDir) {
      const piCopy = path.join(options.agentDir, "bin", platform === "win32" ? "rg.exe" : "rg");
      if (await isFile(piCopy)) return { source: "agent", path: piCopy };
    }
    const pinned = await pinnedCopy(spec, options);
    if (pinned) return { source: "pinned", path: pinned };
    if (options.downloads === false) return { source: "none", why: "off" };
    if (offline(env)) return { source: "none", why: "offline" };
    const supported = spec.source.kind === "binary" && Object.keys(spec.source.assets).includes(`${platform}-${options.arch ?? process.arch}`);
    if (!supported) return { source: "none", why: "unsupported" };
    options.write?.(`${RIPGREP_GETTING}\n`);
    const { write: _quiet, spec: _spec, ...rest } = options;
    const result = await installBinary(spec, { ...rest, fetchBytes: options.fetchBytes ?? fetchWithTimeout });
    const installed = result.ok ? await pinnedCopy(spec, options) : undefined;
    if (installed) return { source: "installed", path: installed };
    return failed(options, result.message);
  } catch (error) {
    return failed(options, error instanceof Error ? error.message : String(error));
  }
}

function failed(options: RipgrepOptions, reason: string): RipgrepResult {
  const line = reason.split("\n")[0]!.slice(0, 200);
  const message = `Could not get ripgrep (${line}). Continuing without it; searching files and the shell sandbox may be limited.`;
  options.write?.(`${message}\n`);
  return { source: "none", why: "failed", message };
}

/** `dir` added to the END of PATH in `env` (a ripgrep on PATH always wins), so the AI's grep tool finds `rg`. */
export function addToPath(env: NodeJS.ProcessEnv, dir: string, platform: NodeJS.Platform = process.platform): void {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  const current = env[key] ?? "";
  if (current.split(delimiter).includes(dir)) return;
  env[key] = current ? `${current}${delimiter}${dir}` : dir;
}
