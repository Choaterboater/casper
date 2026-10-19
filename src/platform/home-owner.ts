import { lchown, lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * `sudo casper` keeps your home, so what Casper and the Claude Code it starts write there (~/.casper, ~/.claude.json)
 * would belong to root, and the next Casper or Claude Code run as you can't read or update it: Claude Code then takes
 * seconds to give up on its own settings and your plan login looks missing. As npm does, a Casper running as root
 * gives a file back to the owner of the home it is in. Only files owned by root are changed, never another user's.
 */
export interface HomeOwnerDependencies {
  uid?: () => number | undefined;
  chown?: (file: string, uid: number, gid: number) => Promise<void>;
  /** Whose files are given back: root, except in tests, which can't make root-owned files. */
  rootUid?: number;
}

export interface Owner { uid: number; gid: number }

/** Folders walked to the end at start and exit; after Claude Code runs only its settings files. */
const DEEP = [".casper", ".claude"];
const MAX_ENTRIES = 500_000;

/** The account a home belongs to, when Casper runs as root there and it is someone else's; else undefined. */
export async function rootInOthersHome(home: string, dependencies: HomeOwnerDependencies = {}): Promise<Owner | undefined> {
  if (process.platform === "win32" || (dependencies.uid ?? process.getuid)?.() !== 0) return undefined;
  const stat = await lstat(home).catch(() => undefined);
  return stat?.isDirectory() && stat.uid !== 0 ? { uid: stat.uid, gid: stat.gid } : undefined;
}

/** ~/.claude.json and the copies Claude Code keeps next to it. */
async function claudeSettings(home: string): Promise<string[]> {
  const names = await readdir(home).catch(() => [] as string[]);
  return names.filter((name) => name === ".claude.json" || name.startsWith(".claude.json.")).sort().map((name) => path.join(home, name));
}

/** Gives every root-owned entry under `roots` (links themselves, not what they point to) to `owner`. `depth` 0 is the
 * entry alone. Returns how many changed. Stops after MAX_ENTRIES entries. */
export async function giveBack(roots: readonly { path: string; depth: number }[], owner: Owner,
  dependencies: HomeOwnerDependencies = {}): Promise<number> {
  const chown = dependencies.chown ?? lchown;
  const root = dependencies.rootUid ?? 0;
  // How deep each entry was walked: one listed on its own and inside another is changed once, walked to the deeper.
  const seen = new Map<string, number>();
  let changed = 0;
  const visit = async (file: string, depth: number): Promise<void> => {
    const before = seen.get(file);
    if ((before ?? -1) >= depth || seen.size >= MAX_ENTRIES) return;
    seen.set(file, depth);
    const stat = await lstat(file).catch(() => undefined);
    if (!stat) return;
    if (before === undefined && stat.uid === root && await chown(file, owner.uid, owner.gid).then(() => true, () => false)) changed++;
    if (depth <= 0 || !stat.isDirectory()) return;
    for (const name of await readdir(file).catch(() => [] as string[])) await visit(path.join(file, name), depth - 1);
  };
  for (const entry of roots) await visit(entry.path, entry.depth);
  return changed;
}

/** Everything Casper and Claude Code keep in the home. */
export async function homeFiles(home: string): Promise<{ path: string; depth: number }[]> {
  return [...DEEP.map((name) => ({ path: path.join(home, name), depth: Infinity })),
    ...(await claudeSettings(home)).map((file) => ({ path: file, depth: 0 }))];
}

/** After a Claude Code run: its settings files and backups, which it rewrites on every start. */
export async function returnClaudeFiles(home = os.homedir(), dependencies: HomeOwnerDependencies = {}): Promise<void> {
  const owner = await rootInOthersHome(home, dependencies);
  if (!owner) return;
  await giveBack([...(await claudeSettings(home)).map((file) => ({ path: file, depth: 0 })),
    { path: path.join(home, ".claude"), depth: 1 }, { path: path.join(home, ".claude", "backups"), depth: 1 }], owner, dependencies);
}

/** Places that stop Casper or Claude Code when root owns them, checked without walking the big folders. */
async function shallowFiles(home: string): Promise<{ path: string; depth: number }[]> {
  const casper = path.join(home, ".casper");
  return [...(await claudeSettings(home)).map((file) => ({ path: file, depth: 0 })),
    { path: path.join(home, ".claude"), depth: 1 }, { path: path.join(home, ".claude", "backups"), depth: 1 },
    { path: casper, depth: 1 }, { path: path.join(casper, "agent"), depth: 1 },
    { path: path.join(casper, "agent", "sessions"), depth: 1 }, { path: path.join(casper, "projects"), depth: 0 }];
}

const quote = (word: string) => /^[\w./@%+=:,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
/** ~ stays outside the quotes so the shell still expands it. */
const quotePath = (file: string) => file.startsWith("~/") ? `~/${quote(file.slice(2))}` : quote(file);

/** For a Casper running as you: which of these files root owns (left by an earlier `sudo casper` or `sudo claude`),
 * and the one command that gives them back. Undefined when none does, or when Casper is root itself. */
export async function rootOwnedNote(home: string, dependencies: HomeOwnerDependencies & { user?: { name: string; gid: number } } = {}): Promise<string | undefined> {
  const uid = (dependencies.uid ?? process.getuid)?.();
  if (process.platform === "win32" || uid === undefined || uid === 0) return undefined;
  const found: string[] = [];
  // Records what it finds instead of changing it: only root can.
  await giveBack(await shallowFiles(home), { uid: 0, gid: 0 }, { ...dependencies, chown: async (file) => { found.push(file); } });
  if (!found.length) return undefined;
  // A folder already listed covers what is in it.
  const top = found.filter((file) => !found.some((other) => other !== file && file.startsWith(other + path.sep)));
  const shown = (file: string) => file.startsWith(home + path.sep) ? `~/${path.relative(home, file)}` : file;
  const user = dependencies.user ?? ((info) => ({ name: info.username, gid: info.gid }))(os.userInfo());
  const listed = top.slice(0, 3).map(shown).join(", ") + (top.length > 3 ? ` and ${top.length - 3} more` : "");
  return `Some of your Casper and Claude Code files belong to root, so they can't be read or updated (an earlier sudo casper or sudo claude left them): ${listed}. `
    + `Give them back: sudo chown -R ${quote(`${user.name}:${user.gid}`)} ${top.map((file) => quotePath(shown(file))).join(" ")}`;
}
