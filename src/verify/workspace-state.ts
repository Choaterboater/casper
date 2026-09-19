import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** Local filesystem evidence only, not a snapshot of services, environment or tools
 * outside cwd. Include ignored files and Git metadata; never silently omit inputs.
 * Unsupported or changing trees disable reuse instead of blocking command execution. */
export async function workspaceState(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const deadline = performance.now() + 500;
  let workItems = 0;
  let bytes = 0;
  const seen = new Map<string, string>();
  const hash = createHash("sha256");
  const guard = () => {
    if (signal?.aborted || performance.now() > deadline || ++workItems > 4096) throw new Error("Snapshot unavailable");
  };
  try {
    const root = await realpath(cwd);
    const visit = async (file: string): Promise<void> => {
      guard();
      const stat = await lstat(file, { bigint: true });
      const id = identity(stat);
      seen.set(file, id);
      hash.update(JSON.stringify([path.relative(root, file), id]));
      if (stat.isDirectory()) {
        const names: string[] = [];
        for await (const entry of await opendir(file)) {
          guard();
          names.push(entry.name);
        }
        for (const name of names.sort()) await visit(path.join(file, name));
      } else if (stat.isFile()) {
        const size = Number(stat.size);
        bytes += size;
        if (size > 1024 * 1024 || bytes > 16 * 1024 * 1024) throw new Error("Snapshot too large");
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (identity(await handle.stat({ bigint: true })) !== id) throw new Error("File changed");
          const buffer = Buffer.alloc(size + 1);
          let length = 0;
          while (length < buffer.length) {
            guard();
            const read = await handle.read(buffer, length, buffer.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          if (length !== size || identity(await handle.stat({ bigint: true })) !== id) throw new Error("File changed");
          hash.update(buffer.subarray(0, length));
        } finally { await handle.close(); }
      } else throw new Error("Unsupported file, symlink or special entry");
    };
    await visit(root);
    // Catch membership changes and edits made while another file was being read.
    for (const [file, id] of seen) {
      guard();
      if (identity(await lstat(file, { bigint: true })) !== id) return undefined;
    }
    if (await realpath(cwd) !== root) return undefined;
    return hash.digest("hex");
  } catch { return undefined; }
}
