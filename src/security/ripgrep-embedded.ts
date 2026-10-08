import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RIPGREP_BINARY_SHA256 } from "./ripgrep-pin";
import { hostPlatform, type PlatformKey } from "./tools";

/**
 * The ripgrep inside the release program. `bun run build:release` puts the official ripgrep for each target's own
 * platform at build/embedded/rg (rg.exe on Windows) after checking it against the pins in ripgrep-pin.ts, and the
 * compiled Casper carries it. Like the sandbox's apply-seccomp helper (src/sandbox/seccomp.ts), the kernel can't run
 * a file inside the executable, so it is written once to ~/.casper/bin/rg-<sha256>/rg (owner only) after its sha256
 * is compared to the pin for this computer; a copy that is already there is reused only if its bytes still match.
 * From a source checkout, or a program built without the file, there is nothing embedded and the import fails: the
 * caller falls through to the pinned download. Nothing here downloads anything.
 */
// The imports sit inside try blocks on purpose: Bun treats an unresolved import there as optional, so a checkout or
// a build without the file still compiles and starts.
async function loadPlain(): Promise<string | undefined> {
  try { return (await import("../../build/embedded/rg", { with: { type: "file" } })).default; } catch { return undefined; }
}
async function loadExe(): Promise<string | undefined> {
  try { return (await import("../../build/embedded/rg.exe", { with: { type: "file" } })).default; } catch { return undefined; }
}

const embedded = (file: string) => /(^|[\\/])(\$bunfs|~BUN)[\\/]/.test(file);

/** The embedded file's path inside the running program, or undefined from a source checkout or a build without it. */
export async function embeddedSource(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const file = await (platform === "win32" ? loadExe() : loadPlain());
  // A path outside the program (a leftover build/ folder in a checkout) is never used.
  return typeof file === "string" && embedded(file) ? file : undefined;
}

export interface EmbeddedOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Tests: the file to treat as the embedded one, in place of the program's own. */
  source?: () => Promise<string | undefined>;
  /** Tests: the pinned program digests to compare to (the real ones by default). */
  pins?: Partial<Record<PlatformKey, string>>;
}

export type EmbeddedResult = { path: string } | { refused: string } | undefined;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Where the unpacked copy goes: its own folder, so putting the folder on PATH exposes `rg` and nothing else. */
export function embeddedRipgrepPath(homeDir: string, hash: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(homeDir, ".casper", "bin", `rg-${hash}`, platform === "win32" ? "rg.exe" : "rg");
}

/**
 * undefined: nothing embedded (or not a computer Casper pins). `{ refused }`: the embedded bytes do not match the pin,
 * so nothing was written and nothing will run. `{ path }`: the checked copy, written once and reused.
 */
export async function extractEmbeddedRipgrep(options: EmbeddedOptions = {}): Promise<EmbeddedResult> {
  const platform = options.platform ?? process.platform;
  const key = hostPlatform(platform, options.arch ?? process.arch);
  if (!key) return undefined;
  const source = await (options.source ?? (() => embeddedSource(platform)))();
  if (!source) return undefined;
  const bytes = await readFile(source);
  const hash = sha256(bytes);
  if (hash !== (options.pins ?? RIPGREP_BINARY_SHA256)[key]) return { refused: "the ripgrep inside Casper does not match its pinned checksum" };
  const target = embeddedRipgrepPath(options.homeDir ?? os.homedir(), hash, platform);
  const regular = async () => (await lstat(target).then((details) => details.isFile(), () => false));
  const good = async () => (await regular()) && sha256(await readFile(target)) === hash;
  if (await good()) return { path: target };
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.rg-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, { mode: 0o700, flag: "wx" });
    await chmod(temporary, 0o700);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    // Another Casper starting at the same moment put the same checked copy there first: that is a success too.
    if (await good()) return { path: target };
    throw error;
  }
  return { path: target };
}
