import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The sandbox runtime's apply-seccomp helper (Linux x64 and arm64), which blocks Unix sockets inside the sandbox.
 * From source it is the installed package's file. A compiled Casper carries it inside the executable, where the
 * kernel can't run it, so it is written once to ~/.casper/bin/apply-seccomp-<sha256> (0700) after its hash is
 * checked, and that copy is used.
 *
 * The helper is loaded only on Linux, so macOS never needs the package's Linux files to start. A dynamic
 * import with `type: "file"` is still embedded by `bun build --compile`.
 */
const EMBEDDED: Partial<Record<string, () => Promise<{ default: string }>>> = {
  x64: () => import("@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp", { with: { type: "file" } }),
  arm64: () => import("@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp", { with: { type: "file" } }),
};

const embedded = (file: string) => /(^|[\\/])(\$bunfs|~BUN)[\\/]/.test(file);

export async function seccompHelper(options: { home?: string; arch?: string; platform?: NodeJS.Platform } = {}): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  const load = EMBEDDED[options.arch ?? process.arch];
  if (!load) return undefined;
  const source = (await load()).default;
  if (!embedded(source)) return source;
  const bytes = await readFile(source);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(options.home ?? os.homedir(), ".casper", "bin");
  const target = path.join(dir, `apply-seccomp-${hash.slice(0, 16)}`);
  const existing = await readFile(target).catch(() => undefined);
  if (existing && createHash("sha256").update(existing).digest("hex") === hash) return target;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.apply-seccomp-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, { mode: 0o700, flag: "wx" });
    await chmod(temporary, 0o700);
    await rename(temporary, target);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  return target;
}
