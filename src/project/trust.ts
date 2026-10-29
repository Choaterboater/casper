/**
 * Whether you trust the folder Casper opened: its own commands (the checks it finds, `.casper/project.yaml`'s checks,
 * services and pages, and the project's scripts, builds, tests and installs the AI runs) run only in a folder you
 * trusted. Asked once per folder in a session; "Not now" saves nothing. The answer is kept with Casper's other state for
 * the project (~/.casper/projects/<name>-<id>/trust.json).
 *
 * A folder is covered by its own answer, or:
 * - a folder with no repository of its own, by a trusted folder above it (~/Projects trusted covers ~/Projects/notes);
 * - a repository's worktree (a /branch folder, a builder's copy), by its main checkout, when that checkout lists it
 *   (`git worktree list`): a folder whose .git only points at a trusted repository is not one of its worktrees.
 * A repository inside a trusted folder is its own project and asks for itself. Your home folder and the top of a drive
 * are never trusted: there Casper's checks don't run and the AI asks before the project's commands.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { safeGitArgs } from "../platform/git";
import { broadFolder, inspectProject, type ProjectInfo } from "./inspect";
import { projectStateDirectory } from "./model";

const execFileAsync = promisify(execFile);

export const TRUST_FILE = "trust.json";
/** In ~/.casper (not projects/, which holds only project folders): the folders Casper had state for before it asked
 * have been trusted (once). */
export const TRUST_MIGRATED = ".trust-migrated";

export type FolderTrust =
  | { trusted: true; from: string }
  | { trusted: false; why: "new" | "home" | "drive" };

/** Why the folder's own commands don't run when it isn't trusted, for the banner, /status, /verify, /services and the
 * receipt: "this folder isn't trusted; say "trust this folder" to run its checks". */
export function untrustedReason(why: Extract<FolderTrust, { trusted: false }>["why"], what = "run its checks"): string {
  return why === "new" ? `this folder isn't trusted; say "trust this folder" to ${what}`
    : `Casper never trusts ${why === "home" ? "your home folder" : "the top of a drive"}; open a project folder to ${what}`;
}

/** Runs git in a folder: its output, or undefined. Tests pass their own (paths in another form than Casper's). */
export type TrustGit = (args: string[], cwd: string) => Promise<string | undefined>;

const runGit: TrustGit = async (args, cwd) => {
  try { return (await execFileAsync("git", safeGitArgs(args), { cwd })).stdout.trim() || undefined; } catch { return undefined; }
};

const real = (dir: string) => realpath(dir).catch(() => path.resolve(dir));

async function saved(root: string, home: string): Promise<boolean> {
  try {
    const record = JSON.parse(await readFile(path.join(projectStateDirectory(root, home), TRUST_FILE), "utf8")) as { trusted?: unknown };
    return record.trusted === true;
  } catch { return false; }
}

/** The main checkout of the repository whose worktree `root` is, when that checkout lists it as its own, named as
 * Casper names a folder it opens (inspectProject's root): git prints C:/... on Windows and its real path elsewhere, and
 * the answer was saved under the opened folder's root, so that form is the only one that finds it. */
async function mainCheckout(root: string, git: TrustGit): Promise<string | undefined> {
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
  if (!common) return undefined;
  const commonDir = path.resolve(common);
  if (path.basename(commonDir) !== ".git") return undefined;
  const main = path.dirname(commonDir);
  const [mainReal, rootReal] = await Promise.all([real(main), real(root)]);
  if (mainReal === rootReal) return undefined;
  const listed = await git(["worktree", "list", "--porcelain"], main);
  const worktrees = await Promise.all((listed ?? "").split("\n").filter((line) => line.startsWith("worktree ")).map((line) => real(line.slice(9).trim())));
  if (!worktrees.includes(rootReal)) return undefined;
  return (await inspectProject(main)).root;
}

/** Whether the folder Casper opened is trusted, and by which folder's answer. */
export async function folderTrust(info: Pick<ProjectInfo, "root" | "isGit">, home: string, options: { git?: TrustGit } = {}): Promise<FolderTrust> {
  const broad = broadFolder(info.root, home);
  if (broad) return { trusted: false, why: broad };
  if (await saved(info.root, home)) return { trusted: true, from: info.root };
  if (info.isGit) {
    const main = await mainCheckout(info.root, options.git ?? runGit);
    return main && await saved(main, home) ? { trusted: true, from: main } : { trusted: false, why: "new" };
  }
  // No repository of its own: the same project as a trusted folder above it, up to (not including) home or a drive.
  for (let dir = path.dirname(info.root); dir !== path.dirname(dir) && !broadFolder(dir, home); dir = path.dirname(dir)) {
    if (await saved(dir, home)) return { trusted: true, from: dir };
  }
  return { trusted: false, why: "new" };
}

async function writeRecord(dir: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, TRUST_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/** How a session finds the open folder's trust: the saved answers (tests of other things set their own, as with
 * sandboxDefaults, so a temp folder doesn't stop at the box). */
export const folderTrustDefaults: { lookup: (info: Pick<ProjectInfo, "root" | "isGit">, home: string) => Promise<FolderTrust> } = {
  lookup: (info, home) => folderTrust(info, home),
};

/** Trust the folder (saved), or take its own answer back. Home and the top of a drive are refused. */
export async function saveFolderTrust(root: string, home: string, trusted: boolean): Promise<void> {
  if (trusted && broadFolder(root, home)) throw new Error("Casper never trusts your home folder or the top of a drive; open a project folder in it instead.");
  const dir = projectStateDirectory(root, home);
  if (trusted) await writeRecord(dir, { version: 1, trusted: true, at: new Date().toISOString() });
  else await rm(path.join(dir, TRUST_FILE), { force: true });
}

/** Once: every folder Casper kept state for before it asked counts as trusted, so nothing you used stops working.
 * Your home folder's and a drive's state are left out. The number trusted. Synchronous and done once (a marker in
 * ~/.casper): opening a folder waits on no extra file work before its context loads. */
export function migrateFolderTrust(home: string): number {
  const projects = path.join(home, ".casper", "projects");
  const marker = path.join(home, ".casper", TRUST_MIGRATED);
  if (existsSync(marker)) return 0;
  let entries: string[] = [];
  try { entries = readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { entries = []; }
  const broad = new Set([home, path.parse(home).root, ...(process.platform === "win32" ? [..."CDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter) => `${letter}:\\`) : [])]
    .map((dir) => path.basename(projectStateDirectory(dir, home))));
  let trusted = 0;
  for (const name of entries) {
    if (broad.has(name)) continue;
    const file = path.join(projects, name, TRUST_FILE);
    if (existsSync(file)) continue;
    try { writeFileSync(file, `${JSON.stringify({ version: 1, trusted: true, migrated: true })}\n`, { mode: 0o600 }); trusted++; } catch { /* left to ask */ }
  }
  try { mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 }); writeFileSync(marker, "", { mode: 0o600 }); } catch { /* asked again next start */ }
  return trusted;
}
