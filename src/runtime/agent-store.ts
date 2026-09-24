import { chmod, copyFile, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Internal bridge: the bundled engine still reads this name for its state directory. */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Bun resolves os.homedir() once at startup; tests and wrappers change HOME later. */
function resolveHome(): string {
  const env = process.env as Record<string, string | undefined>;
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

function agentDirOverride(): string | undefined {
  const value = process.env.CASPER_AGENT_DIR;
  return value && value !== "undefined" ? value : undefined;
}

/** Casper-owned engine state; explicit directories are managed by their owner, not imported into. */
export function casperAgentDir(): string {
  const override = agentDirOverride();
  if (!override) return path.join(resolveHome(), ".casper", "agent");
  return path.resolve(override === "~" ? resolveHome() : override.startsWith("~/") || override.startsWith("~\\")
    ? path.join(resolveHome(), override.slice(2)) : override);
}

/** Select Casper's state before the engine resolves paths. Inherited engine state is never used.
 * Returns true when legacy credentials may be imported into the default store. */
export function useCasperAgentStore(): boolean {
  const env = process.env as Record<string, string | undefined>;
  // Bun stores `env.X = undefined` as the string "undefined"; it names no real directory
  // and would otherwise put the store in `<cwd>/undefined/`.
  const preset = env[AGENT_DIR_ENV];
  if (preset && preset !== "undefined" && preset !== casperAgentDir()) {
    process.stderr.write("[config] Ignoring PI_CODING_AGENT_DIR; use CASPER_AGENT_DIR to choose Casper's state directory.\n");
  }
  env[AGENT_DIR_ENV] = casperAgentDir();
  if (env.CASPER_OFFLINE === "1") env.PI_OFFLINE = "1";
  else delete env.PI_OFFLINE;
  for (const [source, target] of [
    ["CASPER_OAUTH_CALLBACK_HOST", "PI_OAUTH_CALLBACK_HOST"],
    ["CASPER_TUI_WRITE_LOG", "PI_TUI_WRITE_LOG"],
  ] as const) {
    if (env[source]) env[target] = env[source];
    else delete env[target];
  }
  return !agentDirOverride();
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
  const result: LegacyImport = { imported: false, signIn: [] };
  if (agentDirOverride()) return result;
  const agentDir = casperAgentDir();
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
