import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectCommand } from "../project/model";
import type { TreeChanges } from "../task/changes";
import { runCommandCheck } from "./command";

/** Whether the tests show the change works: they fail on the code without the change (the change's
 * own new tests included) and pass with it. Host evidence, never a model claim. */
export type ChangeProof =
  | { status: "proven"; check: ProjectCommand; command: string; testsChanged: boolean }
  | { status: "unproven"; check: ProjectCommand; command: string; testsChanged: boolean }
  | { status: "unavailable"; check: ProjectCommand; reason: string };

/** Tests and their support files (helpers, fixtures under a test directory). They are what proves a
 * change, so the comparison keeps their new version; everything else is the change itself. */
export function isTestPath(relative: string): boolean {
  return /(?:^|\/)(?:__tests__|tests?|specs?)\//i.test(relative)
    || /\.(?:test|spec)\.[^/.]+$/i.test(relative)
    || /(?:^|\/)test_[^/]+\.py$/i.test(relative)
    || /_(?:test|spec)\.[^/.]+$/i.test(relative);
}

/** Source code a behavior change lives in (tests excluded). Docs, data, assets and configuration are
 * not: editing them alone needs no proof. */
export function isCodePath(relative: string): boolean {
  return !isTestPath(relative) && /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|scala|rb|php|cs|fs|swift|c|cc|cpp|cxx|h|hpp|m|mm|ex|exs|erl|clj|dart|lua|pl|sh|bash|zsh|vue|svelte)$/i.test(relative);
}

/** Whether a set of changes touches code that must be proven. */
export function changesCode(changes: TreeChanges): boolean {
  return [...changes.added, ...changes.modified, ...changes.removed]
    .some((relative) => isCodePath(relative) && !relative.split("/").some((part) => Object.hasOwn(SKIPPED, part)));
}

/** Never copied: VCS internals, Casper's state and installed dependencies (linked instead). */
const SKIPPED: Record<string, true> = { ".git": true, node_modules: true, ".casper": true };
const LINKED = "node_modules";
const FILE_LIMIT = 20_000;
const BYTE_LIMIT = 256 * 1024 * 1024;

interface Limits { fileLimit: number; byteLimit: number }

/** Copy a tree (copy-on-write where the file system supports it), without skipped directories.
 * Symlinks are recreated, never followed. Returns where dependency directories were. */
async function cloneTree(source: string, destination: string, limits: Limits, signal?: AbortSignal): Promise<string[]> {
  const links: string[] = [];
  let files = 0;
  let bytes = 0;
  const pending = [""];
  while (pending.length) {
    signal?.throwIfAborted();
    const relative = pending.pop()!;
    await mkdir(path.join(destination, relative), { recursive: true });
    for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      const from = path.join(source, next);
      const to = path.join(destination, next);
      if (entry.isDirectory()) {
        if (entry.name === LINKED) links.push(next);
        if (!Object.hasOwn(SKIPPED, entry.name)) pending.push(next);
      } else if (entry.isSymbolicLink()) {
        await symlink(await readlink(from), to);
      } else if (entry.isFile()) {
        if (++files > limits.fileLimit) throw new RangeError(`the workspace has more than ${limits.fileLimit} files`);
        bytes += (await lstat(from)).size;
        if (bytes > limits.byteLimit) throw new RangeError(`the workspace is larger than ${Math.round(limits.byteLimit / 1024 / 1024)} MB`);
        await copyFile(from, to, constants.COPYFILE_FICLONE);
      }
    }
  }
  return links;
}

/** The workspace as it was before the model's request, kept to rebuild it "without the change". */
export class ChangeBaseline {
  private constructor(
    private readonly scratch: string,
    private readonly tree: string,
    private readonly limits: Limits,
    /** Where dependency directories were at capture: linked from the workspace, never copied. */
    private readonly links: readonly string[],
  ) {}

  /** Throws when the workspace cannot be copied (too large, unreadable). */
  static async capture(root: string, options: { scratch?: string; fileLimit?: number; byteLimit?: number; signal?: AbortSignal } = {}): Promise<ChangeBaseline> {
    const limits = { fileLimit: options.fileLimit ?? FILE_LIMIT, byteLimit: options.byteLimit ?? BYTE_LIMIT };
    const scratch = await mkdtemp(path.join(options.scratch ?? os.tmpdir(), "casper-baseline-"));
    try {
      const links = await cloneTree(root, path.join(scratch, "before"), limits, options.signal);
      return new ChangeBaseline(scratch, path.join(scratch, "before"), limits, links);
    } catch (error) {
      await rm(scratch, { recursive: true, force: true });
      throw error;
    }
  }

  /** Run `command` without the change's non-test edits, then (only if that fails) with them, each in a
   * fresh copy with dependencies linked from the workspace. Undefined when only tests changed. */
  async prove(options: {
    root: string; changes: TreeChanges; check: ProjectCommand; command: string; timeoutMs: number;
    signal?: AbortSignal; onCleanupFailure?: () => void;
  }): Promise<ChangeProof | undefined> {
    const changed = [...options.changes.added, ...options.changes.modified, ...options.changes.removed]
      .filter((relative) => !relative.split("/").some((part) => Object.hasOwn(SKIPPED, part)));
    const tests = changed.filter(isTestPath);
    if (!changesCode(options.changes)) return undefined;
    const { check, command } = options;
    const run = (cwd: string) => runCommandCheck({ name: check, command, cwd, timeoutMs: options.timeoutMs, signal: options.signal, onCleanupFailure: options.onCleanupFailure });
    const copies = await mkdtemp(path.join(this.scratch, "compare-"));
    try {
      const linkDependencies = async (tree: string, links: readonly string[]) => {
        for (const relative of links) {
          const target = path.join(options.root, relative);
          if (await lstat(target).then((stats) => stats.isDirectory(), () => false)) {
            await rm(path.join(tree, relative), { recursive: true, force: true });
            await mkdir(path.dirname(path.join(tree, relative)), { recursive: true });
            await symlink(target, path.join(tree, relative), "dir");
          }
        }
      };
      // Without the change: the tree from before, with the tests as they are now.
      const without = path.join(copies, "without");
      await cloneTree(this.tree, without, this.limits, options.signal);
      for (const relative of tests) {
        const from = path.join(options.root, relative);
        const to = path.join(without, relative);
        await rm(to, { recursive: true, force: true });
        const stats = await lstat(from).catch(() => undefined);
        if (!stats) continue;
        await mkdir(path.dirname(to), { recursive: true });
        if (stats.isSymbolicLink()) await symlink(await readlink(from), to);
        else if (stats.isFile()) await copyFile(from, to, constants.COPYFILE_FICLONE);
      }
      await linkDependencies(without, this.links);
      const result = await run(without);
      if (result.status === "pass") return { status: "unproven", check, command, testsChanged: tests.length > 0 };
      if (result.exitCode === null) {
        return { status: "unavailable", check, reason: `${check} could not run without the change (${(result.reason ?? "no exit status").replace(/\.$/, "").toLowerCase()})` };
      }
      // A copy that cannot run the tests at all would look like proof: the current code must pass there too.
      const current = path.join(copies, "with");
      await linkDependencies(current, await cloneTree(options.root, current, this.limits, options.signal));
      const control = await run(current);
      if (control.status !== "pass") return { status: "unavailable", check, reason: `${check} does not pass in a copy of the workspace, so Casper cannot compare with and without the change` };
      return { status: "proven", check, command, testsChanged: tests.length > 0 };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return { status: "unavailable", check, reason: `Casper could not build the comparison: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      await rm(copies, { recursive: true, force: true });
    }
  }

  async dispose(): Promise<void> {
    await rm(this.scratch, { recursive: true, force: true });
  }
}

/** The one repair round an unproven change gets: add the missing test, keep the change. */
export function proofRepairPrompt(request: string, proof: Extract<ChangeProof, { status: "unproven" }>): string {
  return [
    "Casper proof repair.",
    `Your change passes the checks, but ${proof.check} (${proof.command}) also passes without it, so nothing shows the requested behavior works.`,
    `Add or update a test that exercises the requested behavior: it must fail on the code without your change and pass with it. ${proof.testsChanged ? "The tests you changed do not do that yet." : "No test was added or changed."}`,
    "Keep the change itself. Do not weaken, skip or delete tests. Casper reruns the checks and the comparison afterwards.",
    "Original request:",
    request,
  ].join("\n");
}
