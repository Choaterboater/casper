import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { projectStateDirectory } from "../../src/project/model";
import { saveFolderTrust, TRUST_FILE } from "../../src/project/trust";

/** Saves `dir` as a folder you trusted in `home`, as named and by its real path (a Casper started there sees the
 * folder as the system names it: macOS's /var is /private/var), so a real CLI opened there asks no "Trust this folder?". */
export async function trustFolder(dir: string, home: string): Promise<void> {
  for (const named of new Set([dir, await realpath(dir).catch(() => dir)])) await saveFolderTrust(named, home, true);
}

/** The names a Casper started in `dir` may give it: as named, resolved, its real path (Windows' long names for a
 * short RUNNER~1, macOS's /private/var) and git's top level when it is in a repository, in the form Casper keeps. */
function namesFor(dir: string): string[] {
  const names = [dir, path.resolve(dir)];
  try { names.push(realpathSync.native(dir)); } catch { /* not there yet */ }
  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: dir, stdout: "pipe", stderr: "ignore" });
  if (top.exitCode === 0 && top.stdout.toString().trim()) names.push(path.resolve(top.stdout.toString().trim()));
  return [...new Set(names)];
}

/** trustFolder for a child started at once (a screen fixture's constructor): written directly, as trust.json is. */
export function trustFolderSync(dir: string, home: string): void {
  for (const named of namesFor(dir)) {
    const state = projectStateDirectory(named, home);
    mkdirSync(state, { recursive: true });
    writeFileSync(path.join(state, TRUST_FILE), `${JSON.stringify({ version: 1, trusted: true })}\n`);
  }
}
