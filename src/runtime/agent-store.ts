import { chmod, copyFile, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Env var the bundled engine reads for its state dir; an explicit value always wins. */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Bun resolves os.homedir() once at startup; tests and wrappers change HOME later. */
function resolveHome(): string {
  const env = process.env as Record<string, string | undefined>;
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

/** Casper-owned engine state: credentials and the provider catalog live under ~/.casper/agent. */
export function casperAgentDir(): string {
  return path.join(resolveHome(), ".casper", "agent");
}

/** Default the engine's state dir to Casper's own store. Returns true when this call set the
 * default; a pre-set PI_CODING_AGENT_DIR (any Pi-compatible directory) is respected untouched.
 * Call once at CLI entry, before the engine resolves paths. */
export function useCasperAgentStore(): boolean {
  const env = process.env as Record<string, string | undefined>;
  // Bun stores `env.X = undefined` as the string "undefined"; it names no real directory
  // and would otherwise put the store in `<cwd>/undefined/`.
  const preset = env[AGENT_DIR_ENV];
  if (preset && preset !== "undefined") return false;
  env[AGENT_DIR_ENV] = casperAgentDir();
  return true;
}

/** Result of the one-time legacy import. `signIn` names the OAuth providers left behind. */
export interface LegacyImport { imported: boolean; signIn: string[] }

/** Only API keys survive the copy. An OAuth refresh token rotates on use, so two copies of
 * one token family let Pi and Casper log each other out; those providers need /login. */
function apiKeysOnly(text: string): { auth: Record<string, unknown>; signIn: string[] } {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid legacy auth");
  const auth: Record<string, unknown> = {};
  const signIn: string[] = [];
  for (const [provider, entry] of Object.entries(parsed)) {
    const type = entry && typeof entry === "object" ? (entry as { type?: unknown }).type : undefined;
    if (type === "api_key") auth[provider] = entry;
    // Printed on the terminal: a hostile or corrupt name is dropped, never echoed.
    else if (type === "oauth" && /^[A-Za-z0-9_.-]{1,64}$/.test(provider)) signIn.push(provider);
  }
  return { auth, signIn };
}

/** One-time import of an existing Pi CLI state: auth.json API keys (never OAuth tokens) and
 * models.json (provider catalog) are copied, never moved — an existing Pi installation keeps
 * working. Symlinked or non-regular legacy files are refused; failures are best-effort and
 * silent (login can always recreate credentials). */
export async function importLegacyEngineState(): Promise<LegacyImport> {
  const env = process.env as Record<string, string | undefined>;
  const agentDir = env[AGENT_DIR_ENV];
  const result: LegacyImport = { imported: false, signIn: [] };
  if (!agentDir) return result;
  const legacyDir = path.join(resolveHome(), ".pi", "agent");
  try { await mkdir(agentDir, { recursive: true, mode: 0o700 }); }
  catch { return result; } // best-effort: an unwritable HOME surfaces where state is actually needed
  for (const name of ["auth.json", "models.json"]) {
    const target = path.join(agentDir, name);
    const source = path.join(legacyDir, name);
    try {
      if (await stat(target).then(() => true, () => false)) continue;
      const info = await lstat(source);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) continue;
      if (name === "auth.json") {
        const { auth, signIn } = apiKeysOnly(await readFile(source, "utf8"));
        // Written even when empty, so the import (and its /login hint) happens once.
        await writeFile(target, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        result.signIn = signIn;
        if (Object.keys(auth).length) result.imported = true;
      } else {
        await copyFile(source, target);
        result.imported = true;
      }
      await chmod(target, 0o600);
    } catch { /* best-effort: login can always recreate credentials */ }
  }
  return result;
}
