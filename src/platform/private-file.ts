import { lstat, readlink } from "node:fs/promises";
import path from "node:path";

/** Non-atomic preflight only; Pi retains lock/write ownership. Never repair modes silently.
 * Returns a terminal-safe description of the first unsafe component (with the remedy), or undefined.
 * Casper owns the credential file and the directory holding it: neither may be a link. Ancestors above
 * are the user's or the OS's (macOS /tmp -> private/tmp, ostree /home -> var/home), so a link there is
 * followed hop by hop when it is owned by root or the user, and the walk continues on its target.
 * Windows has no POSIX mode bits or uid: a regular, non-linked file under the profile is accepted;
 * its ACL is the operating system's per-user default, not something Casper can inspect here. */
export async function privateFileProblem(file: string, signal?: AbortSignal): Promise<string | undefined> {
  if (Buffer.byteLength(file) > 4096) return "the credential path exceeds 4096 bytes";
  const posix = process.platform !== "win32";
  const uid = process.getuid?.();
  const quoted = (value: string) => JSON.stringify(value);
  const inspect = async (target: string) => {
    signal?.throwIfAborted();
    return lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw Object.assign(new Error(`${quoted(target)} cannot be inspected (${error.code ?? "error"})`), { destination: true });
    });
  };
  try {
    const leaf = await inspect(file);
    if (leaf) {
      if (leaf.isSymbolicLink()) return `${quoted(file)} is a symbolic link; replace it with a regular file`;
      if (!leaf.isFile()) return `${quoted(file)} is not a regular file`;
      if (leaf.nlink !== 1) return `${quoted(file)} has other hard links; replace it with a private copy`;
      if (posix && uid !== undefined && leaf.uid !== uid) return `${quoted(file)} is not owned by you`;
      if (posix && (leaf.mode & 0o077) !== 0) return `${quoted(file)} is accessible to other users; run chmod 600 ${quoted(file)}`;
    }
    const directory = path.dirname(file);
    const owned = await inspect(directory);
    if (owned?.isSymbolicLink()) return `${quoted(directory)} is a symbolic link; use a real directory for credentials`;
    if (owned && !owned.isDirectory()) return `${quoted(directory)} is not a directory`;
    let current = path.dirname(directory);
    for (let hops = 0; hops < 128; hops++) {
      const stat = await inspect(current);
      if (stat?.isSymbolicLink()) {
        if (posix && uid !== undefined && stat.uid !== 0 && stat.uid !== uid) return `${quoted(current)} is a symbolic link owned by another user`;
        current = path.resolve(path.dirname(current), await readlink(current));
        continue;
      }
      if (stat && !stat.isDirectory()) return `${quoted(current)} is not a directory`;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
    return "the credential path has too many components or symbolic links";
  } catch (error) {
    if ((error as { destination?: boolean }).destination) return (error as Error).message;
    throw error;
  }
}
