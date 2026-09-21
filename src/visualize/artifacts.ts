import { cc, ptr } from "bun:ffi";
import artifactSource from "./artifacts.c" with { type: "file" };
import { closeSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Node exposes file handles but not directory-relative creation. Casper is a Bun
// application; these POSIX calls pin directory setup and artifact writes/cleanup to the validated
// directory inode rather than re-following a pathname that can become a symlink.
/** Secure directory-relative artifact I/O needs POSIX openat; other platforms stay in-conversation. */
export const artifactFilesystemSupported = process.platform === "darwin" || process.platform === "linux";

function loadOperations() {
  if (!artifactFilesystemSupported) throw new Error("Secure artifact creation requires macOS or Linux; set visualize.outputDir: false for inline output");
  // Bun can read embedded assets, but TinyCC opens source through libc and cannot
  // resolve /$bunfs paths. Materialize only this fixed bridge in a private temporary
  // directory for compilation; the loaded library no longer needs the source file.
  const temporary = mkdtempSync(path.join(os.tmpdir(), "casper-artifact-cc-"));
  try {
    const source = path.join(temporary, "artifacts.c");
    writeFileSync(source, readFileSync(artifactSource), { mode: 0o600, flag: "wx" });
    return cc({
      source,
      define: { CASPER_DARWIN: process.platform === "darwin" ? "1" : "0" },
      symbols: {
        casper_openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
        casper_unlinkat: { args: ["i32", "ptr"], returns: "i32" },
        casper_mkdirat: { args: ["i32", "ptr"], returns: "i32" },
      },
    });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
let operations: ReturnType<typeof loadOperations> | undefined;
function nativeOperations() { return operations ??= loadOperations(); }
function failure(number: number) {
  const code = Object.entries(os.constants.errno).find(([, value]) => value === number)?.[0] ?? "EIO";
  return Object.assign(new Error(`Artifact filesystem operation failed: ${code}`), { code });
}

export class ArtifactDirectory {
  private constructor(private readonly handle: FileHandle, private readonly native: ReturnType<typeof nativeOperations>, private readonly destination: string) {}

  static async open(destination: string, workspace: string, check: () => void): Promise<ArtifactDirectory> {
    const relative = path.relative(workspace, destination);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Visualization artifacts must stay outside the workspace");
    const native = nativeOperations();
    const root = await fs.open("/", constants.O_RDONLY | constants.O_DIRECTORY);
    let fd = root.fd;
    let owned = false;
    try {
      // Resolve/create every component relative to its held parent. No recursive
      // pathname mkdir: even creating missing ancestors must not follow a swap.
      for (const part of path.resolve(destination).split(path.sep).filter(Boolean)) {
        check();
        const encoded = Buffer.from(part + "\0");
        let next = native.symbols.casper_openat(fd, ptr(encoded), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        if (next === -os.constants.errno.ENOENT) {
          const made = native.symbols.casper_mkdirat(fd, ptr(encoded));
          if (made < 0 && made !== -os.constants.errno.EEXIST) throw failure(-made);
          next = native.symbols.casper_openat(fd, ptr(encoded), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        }
        if (next < 0) throw failure(-next);
        if (owned) closeSync(fd);
        fd = next; owned = true;
      }
      check();
      const handle = await fs.open(`${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${fd}`, constants.O_RDONLY);
      try {
        check();
        const canonical = await fs.realpath(destination);
        const relative = path.relative(workspace, canonical);
        if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Visualization artifacts must stay outside the workspace");
        const directory = new ArtifactDirectory(handle, native, destination);
        await directory.assertCurrent(); check(); return directory;
      } catch (error) { await handle.close(); throw error; }
    } finally {
      if (owned) closeSync(fd);
      await root.close();
    }
  }

  async assertCurrent(): Promise<void> {
    const [held, current] = await Promise.all([this.handle.stat(), fs.lstat(this.destination)]);
    if (!current.isDirectory() || current.dev !== held.dev || current.ino !== held.ino) throw new Error("Visualization artifact directory changed during rendering");
  }

  async create(name: string): Promise<FileHandle> {
    if (path.basename(name) !== name || name.includes("\0")) throw new Error("Invalid artifact filename");
    const encoded = Buffer.from(name + "\0");
    const fd = this.native.symbols.casper_openat(this.handle.fd, ptr(encoded), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
    if (fd < 0) throw failure(-fd);
    try {
      // Reopen the held descriptor, not the mutable original pathname. This gives
      // callers the normal asynchronous FileHandle interface on both platforms.
      return await fs.open(`${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${fd}`, constants.O_WRONLY);
    } catch (error) { this.remove(name); throw error; }
    finally { closeSync(fd); }
  }

  remove(name: string): void {
    const encoded = Buffer.from(name + "\0");
    const result = this.native.symbols.casper_unlinkat(this.handle.fd, ptr(encoded));
    if (result < 0) {
      const error = failure(-result);
      if (error.code !== "ENOENT") throw error;
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
