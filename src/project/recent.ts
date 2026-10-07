/** The order of the projects the home-folder hint and /project list: the folders the person last had conversations in, then
 * the scan's projects by when they last changed. Reads only what Casper already keeps (the saved conversations
 * behind /resume), never a new record. */

import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isOutside } from "../platform/inside";
import { noiseFilter, type NoiseOptions } from "./noise";

/** Conversation folders looked at, newest first: enough for the six choices without reading old history. */
const RECENT_FOLDERS = 30;
/** The header line names the working folder; it is short, so the start of the file is enough. */
const HEADER_BYTES = 8192;

async function mtime(file: string): Promise<number | undefined> {
  return stat(file).then(info => info.mtimeMs, () => undefined);
}

/** The working folder named on a saved conversation's first line. */
async function conversationFolder(file: string): Promise<string | undefined> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
    const header = JSON.parse(line) as { type?: unknown; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string" && header.cwd ? header.cwd : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Last use of each working folder: the newest saved conversation in each of the engine's per-folder
 * conversation folders (`<agentDir>/sessions/--<folder>--/*.jsonl`). */
async function conversationTimes(agentDir: string): Promise<Map<string, number>> {
  const sessions = path.join(agentDir, "sessions");
  const folders = await readdir(sessions, { withFileTypes: true }).catch(() => []);
  // A folder's own time moves when a conversation starts there; it picks the folders worth opening.
  const dated = await Promise.all(folders.filter(entry => entry.isDirectory())
    .map(async entry => ({ dir: path.join(sessions, entry.name), at: await mtime(path.join(sessions, entry.name)) ?? 0 })));
  dated.sort((a, b) => b.at - a.at);
  const times = new Map<string, number>();
  await Promise.all(dated.slice(0, RECENT_FOLDERS).map(async ({ dir }) => {
    const files = (await readdir(dir).catch(() => [])).filter(name => name.endsWith(".jsonl"));
    if (!files.length) return;
    // A resumed conversation is written to again: its file's time, not its name, says when it was last used.
    const stamped = await Promise.all(files.map(async name => ({ file: path.join(dir, name), at: await mtime(path.join(dir, name)) ?? 0 })));
    stamped.sort((a, b) => b.at - a.at);
    const folder = await conversationFolder(stamped[0]!.file);
    if (!folder) return;
    const key = path.resolve(folder);
    times.set(key, Math.max(times.get(key) ?? 0, stamped[0]!.at));
  }));
  return times;
}

/** `dir` written under `base` as given, or undefined when it is not strictly inside it. A conversation names its
 * folder by the real path, so a base behind a link (macOS's /var is /private/var) is matched by its real path too. */
function under(bases: readonly string[], dir: string): string | undefined {
  for (const base of bases) {
    const relative = path.relative(base, path.resolve(dir));
    if (relative !== "" && !isOutside(relative)) return path.join(bases[0]!, relative);
  }
  return undefined;
}

/** Folders inside `base` (not `base` itself) with a saved conversation, most recently used first. A folder that
 * is gone, is not a folder, sits outside `base`, or is a temp, cache or scratch folder is skipped. */
export async function recentlyUsedProjects(options: { base: string; agentDir: string; noise?: NoiseOptions }): Promise<string[]> {
  const base = path.resolve(options.base);
  // Temp, cache, package and scratch folders are not projects (unless the opened folder is one itself).
  const skip = noiseFilter(base, options.noise);
  const bases = [...new Set([base, await realpath(base).catch(() => base)])];
  const times = await conversationTimes(options.agentDir);
  const inside = [...times].flatMap(([dir, at]) => { const mapped = under(bases, dir); return mapped && !skip(dir) && !skip(mapped) ? [[mapped, at] as const] : []; });
  const present = await Promise.all(inside.map(async ([dir, at]) =>
    (await stat(dir).then(info => info.isDirectory(), () => false)) ? { dir, at } : undefined));
  const ordered = present.filter(item => item !== undefined).sort((a, b) => b.at - a.at).map(item => item.dir);
  return [...new Set(ordered)];
}

/** When a project folder last changed, cheaply: the folder's own time or its .git's, whichever is newer. */
async function changedAt(dir: string): Promise<number> {
  const [own, git] = await Promise.all([mtime(dir), mtime(path.join(dir, ".git"))]);
  return Math.max(own ?? 0, git ?? 0);
}

/** The question's order: recently used projects first, then the remaining `candidates` by last change, newest
 * first (the name breaks a tie). */
export async function orderProjectChoices(candidates: readonly string[], options: { base: string; agentDir: string; noise?: NoiseOptions }): Promise<string[]> {
  const used = await recentlyUsedProjects(options);
  const seen = new Set(used.map(dir => path.resolve(dir)));
  const rest = await Promise.all(candidates.filter(dir => !seen.has(path.resolve(dir)))
    .map(async dir => ({ dir, at: await changedAt(dir) })));
  rest.sort((a, b) => b.at - a.at || a.dir.localeCompare(b.dir));
  return [...used, ...rest.map(item => item.dir)];
}
