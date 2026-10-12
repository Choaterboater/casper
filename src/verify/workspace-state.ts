import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { openNoFollow } from "../platform/files";
import { safeGitArgs } from "../platform/git";
import { isVerificationScope, type VerificationScope } from "./scope";

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

export type InputState = { fingerprint: string; reason?: never } | { fingerprint?: never; reason: string };

/** The untracked paths git ignores under `cwd`, relative to it (an ignored folder as one entry), from one git call;
 * undefined outside a git repository or when git can't answer. Tracked files are never listed. */
async function gitIgnored(cwd: string, signal?: AbortSignal): Promise<Set<string> | undefined> {
  return new Promise(resolve => {
    execFile("git", safeGitArgs(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
      { cwd, timeout: 2_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", windowsHide: true, ...(signal ? { signal } : {}) },
      (error, stdout) => {
        if (error) return resolve(undefined);
        const paths = stdout.split("\0").map(entry => entry.replace(/\/+$/, "")).filter(entry => entry && entry !== ".");
        resolve(new Set(paths));
      });
  });
}

/** Bounded evidence for an explicit local scope, never a claim of complete inputs.
 * Excluded outputs do not affect identity; unsupported included inputs disable reuse.
 * Before/after observations are not an atomic snapshot or a filesystem watcher.
 * `skipGitIgnored`: files git ignores found while walking a folder are left out (one git call per observation;
 * no repository, nothing left out). A path named in `inputs` itself always counts. */
export async function workspaceState(cwd: string, scope?: VerificationScope, signal?: AbortSignal, options: { skipGitIgnored?: boolean } = {}): Promise<InputState> {
  if (!scope) return { reason: "No input scope declared." };
  if (!isVerificationScope(scope)) return { reason: "Invalid input scope." };
  const ignored = options.skipGitIgnored ? await gitIgnored(cwd, signal) : undefined;
  const isIgnored = (relative: string) => {
    if (!ignored?.size) return false;
    for (let at = relative.length; at > 0; at = relative.lastIndexOf("/", at - 1)) if (ignored.has(relative.slice(0, at))) return true;
    return false;
  };
  const deadline = performance.now() + 500;
  let workItems = 0;
  let bytes = 0;
  const seen = new Map<string, string | undefined>();
  const hash = createHash("sha256").update(JSON.stringify(scope));
  const guard = () => {
    if (signal?.aborted) throw new Error("Input observation cancelled.");
    if (performance.now() > deadline) throw new Error("Input observation exceeded 500 ms.");
    if (++workItems > 4096) throw new Error("Input observation exceeded 4096 work items.");
  };
  let currentPath = ".";
  try {
    const root = await realpath(cwd);
    hash.update(root);
    const statAt = async (file: string) => lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const remember = (file: string, stat: BigIntStats | undefined) => {
      const id = stat ? identity(stat) : undefined;
      if (seen.has(file) && seen.get(file) !== id) throw new Error("Input changed while observing overlapping paths.");
      seen.set(file, id);
    };
    const excluded = (relative: string) => scope.exclude?.some((entry) => relative === entry || relative.startsWith(entry + "/"));
    const visit = async (relative: string): Promise<void> => {
      if (excluded(relative)) return;
      guard();
      currentPath = relative;
      const file = path.join(root, relative);
      const stat = await statAt(file);
      remember(file, stat);
      if (!stat) {
        hash.update(JSON.stringify([relative, "missing"]));
        return;
      }
      const id = identity(stat);
      // Directory timestamps/size also change when excluded children are written.
      // Hash included membership via traversal, but retain full identities for the
      // final race check within this observation.
      hash.update(JSON.stringify([relative, stat.isDirectory() ? [stat.dev.toString(), stat.ino.toString(), stat.mode.toString()] : id]));
      if (stat.isDirectory()) {
        const names: string[] = [];
        for await (const entry of await opendir(file)) {
          guard();
          const child = relative === "." ? entry.name : relative + "/" + entry.name;
          if (!excluded(child) && !isIgnored(child)) names.push(entry.name);
        }
        for (const name of names.sort()) await visit(relative === "." ? name : relative + "/" + name);
      } else if (stat.isFile()) {
        const size = Number(stat.size);
        bytes += size;
        if (size > 1024 * 1024) throw new Error(`Input exceeds 1 MiB: ${relative}`);
        if (bytes > 16 * 1024 * 1024) throw new Error("Input observation exceeded 16 MiB total.");
        const handle = await openNoFollow(file);
        try {
          if (identity(await handle.stat({ bigint: true })) !== id) throw new Error(`Input changed while observing: ${relative}`);
          const buffer = Buffer.alloc(size + 1);
          let length = 0;
          while (length < buffer.length) {
            guard();
            const read = await handle.read(buffer, length, buffer.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          if (length !== size || identity(await handle.stat({ bigint: true })) !== id) throw new Error(`Input changed while observing: ${relative}`);
          hash.update(buffer.subarray(0, length));
        } finally { await handle.close(); }
      } else throw new Error(`Unsupported input (symlink or special file): ${relative}`);
    };
    // Explicit nested paths must not silently traverse a symlinked parent.
    for (const input of [...new Set(scope.inputs)].sort()) {
      const parts = input.split("/");
      for (let index = 0; index < parts.length - 1; index++) {
        guard();
        currentPath = parts.slice(0, index + 1).join("/");
        const parent = path.join(root, currentPath);
        const stat = await statAt(parent);
        remember(parent, stat);
        if (!stat) break;
        if (!stat.isDirectory()) throw new Error(`Unsupported input parent: ${currentPath}`);
        hash.update(JSON.stringify([currentPath, stat.dev.toString(), stat.ino.toString(), stat.mode.toString()]));
      }
      await visit(input);
    }
    // Catch included membership changes, partial/external edits, and path races.
    for (const [file, id] of seen) {
      guard();
      const stat = await statAt(file);
      if ((stat ? identity(stat) : undefined) !== id) return { reason: `Input changed while observing: ${path.relative(root, file) || "."}` };
    }
    if (await realpath(cwd) !== root) return { reason: "Workspace path changed while observing inputs." };
    guard();
    return { fingerprint: hash.digest("hex") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { reason: code ? `Cannot observe input ${currentPath}: ${code}` : error instanceof Error ? error.message : "Input observation failed." };
  }
}
