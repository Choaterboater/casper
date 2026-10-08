import { pinnedToolPath, type PinnedSpec, type PlatformKey } from "./tools";

/**
 * The ripgrep Casper fetches when none is on PATH: the official static release from BurntSushi/ripgrep, pinned
 * to one version and one sha256 per computer. The sha256 values are the ones the release lists beside each
 * download (the .sha256 files); `bun run scripts/check-tool-pins.ts` checks them again in CI.
 * It installs to ~/.casper/tools/ripgrep-<version>/bin/ like the security tools.
 */
export const RIPGREP_VERSION = "15.2.0";
const BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}`;
const name = (target: string, ext: string) => `ripgrep-${RIPGREP_VERSION}-${target}.${ext}`;
const asset = (target: string, ext: "tar.gz" | "zip", sha256: string, program: string) =>
  ({ url: `${BASE}/${name(target, ext)}`, sha256, archive: ext, member: `ripgrep-${RIPGREP_VERSION}-${target}/${program}` }) as const;

export const RIPGREP: PinnedSpec & { licence: string; homepage: string; approxMB: number; hosts: string[] } = {
  id: "ripgrep", label: "ripgrep", command: "rg", version: RIPGREP_VERSION, licence: "MIT or Unlicense",
  homepage: "https://github.com/BurntSushi/ripgrep", approxMB: 5, hosts: ["github.com"],
  source: { kind: "binary", assets: {
    "linux-x64": asset("x86_64-unknown-linux-musl", "tar.gz", "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c", "rg"),
    "linux-arm64": asset("aarch64-unknown-linux-musl", "tar.gz", "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915", "rg"),
    "darwin-x64": asset("x86_64-apple-darwin", "tar.gz", "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1", "rg"),
    "darwin-arm64": asset("aarch64-apple-darwin", "tar.gz", "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4", "rg"),
    "win32-x64": asset("x86_64-pc-windows-msvc", "zip", "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5", "rg.exe"),
    "win32-arm64": asset("aarch64-pc-windows-msvc", "zip", "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f", "rg.exe"),
  } },
};

/**
 * The sha256 of the `rg` / `rg.exe` program INSIDE each archive above (not of the archive). The release build embeds
 * that program in the compiled Casper after checking it against this; a compiled Casper checks the embedded bytes
 * against this again before it writes or runs them. Computed from the official 15.2.0 assets.
 */
export const RIPGREP_BINARY_SHA256: Record<PlatformKey, string> = {
  "linux-x64": "e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849",
  "linux-arm64": "c14cdb389f34e504d69e386cfc67d5c5d9a730a990de03ca6910b2a15e30386a",
  "darwin-x64": "0c9a0066db0d26b640777db88045b0ccdd58509a746700e43e1c4ff8707a5ed0",
  "darwin-arm64": "a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e",
  "win32-x64": "14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680",
  "win32-arm64": "d33a29a9ef03c9f4c03be9e8d88498e6e2d2e566d64cdbdef97f9afc8f13120c",
};

/** Where the pinned copy's program is (or would be) for this home folder. */
export function pinnedRipgrepPath(homeDir: string, platform: NodeJS.Platform = process.platform): string {
  return pinnedToolPath(homeDir, RIPGREP, platform);
}
