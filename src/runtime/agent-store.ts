import { chmod, copyFile, lstat, mkdir, stat } from "node:fs/promises";
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
  if (env[AGENT_DIR_ENV]) return false;
  env[AGENT_DIR_ENV] = casperAgentDir();
  return true;
}

/** One-time import of an existing Pi CLI state: auth.json (credentials) and models.json
 * (provider catalog) are copied, never moved — an existing Pi installation keeps working.
 * Symlinked or non-regular legacy files are refused; failures are best-effort and silent
 * (login can always recreate credentials). Returns true when anything was imported. */
export async function importLegacyEngineState(): Promise<boolean> {
  const env = process.env as Record<string, string | undefined>;
  const agentDir = env[AGENT_DIR_ENV];
  if (!agentDir) return false;
  const legacyDir = path.join(resolveHome(), ".pi", "agent");
  let imported = false;
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "models.json"]) {
    const target = path.join(agentDir, name);
    const source = path.join(legacyDir, name);
    try {
      if (await stat(target).then(() => true, () => false)) continue;
      const info = await lstat(source);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      await copyFile(source, target);
      await chmod(target, 0o600);
      imported = true;
    } catch { /* best-effort: login can always recreate credentials */ }
  }
  return imported;
}
