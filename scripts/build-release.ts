#!/usr/bin/env bun

/**
 * Builds the release artifacts an installer downloads: one self-contained binary per
 * platform, `SHA256SUMS`, and a copy of both installers — the whole directory is what
 * gets uploaded, so `<base>/install.sh` and `<base>/install.ps1` exist next to the
 * binaries they fetch. The compiled binary embeds Bun and every dependency, so the
 * installed `casper` needs neither this checkout nor Bun on the target machine.
 *
 *   bun run build:release              # host platform only (fast, for verification)
 *   bun run build:release -- --all     # every published platform
 *   bun run build:release -- --target bun-linux-x64
 */

import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CASPER_VERSION } from "../src/version";

const repoRoot = path.resolve(import.meta.dir, "..");
const outputDir = path.join(repoRoot, "dist/release");

/**
 * The installers are published beside the artifacts they download, so uploading this
 * one directory makes the documented one-liner reachable: `curl -fsSL <base>/install.sh | sh`.
 * They are copies, not moved: `scripts/` stays the single source of truth, and neither
 * appears in `SHA256SUMS` — the sums file covers the binaries the installer verifies,
 * and an installer cannot meaningfully verify itself.
 */
const INSTALLERS = [
  { file: "install.sh", mode: 0o755 },
  { file: "install.ps1", mode: 0o644 },
] as const;

/** Bun compile targets, in the order the installer and release notes list them. */
const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
] as const;

type CompileTarget = (typeof TARGETS)[number];

function hostTarget(): CompileTarget {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const target = `bun-${os}-${arch}` as CompileTarget;
  if (!TARGETS.includes(target)) {
    throw new Error(`No published artifact for this host (${target}); pass --target with a supported target`);
  }
  return target;
}

/** `bun-darwin-arm64` → `casper-darwin-arm64`, plus `.exe` on Windows. */
export function artifactName(target: string): string {
  const platform = target.replace(/^bun-/, "");
  return `casper-${platform}${platform.startsWith("windows") ? ".exe" : ""}`;
}

async function packageVersion(): Promise<string> {
  const manifest = (await Bun.file(path.join(repoRoot, "package.json")).json()) as { version?: string };
  if (!manifest.version) throw new Error("package.json has no version");
  return manifest.version;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const manifestVersion = await packageVersion();
  if (manifestVersion !== CASPER_VERSION) {
    throw new Error(`Version drift: package.json is ${manifestVersion} but src/version.ts reports ${CASPER_VERSION}`);
  }

  const all = args.includes("--all");
  const targetFlag = args.indexOf("--target");
  const requested = targetFlag >= 0 ? args[targetFlag + 1] : undefined;
  if (targetFlag >= 0 && !requested) throw new Error("--target needs a Bun compile target");
  if (requested && !TARGETS.includes(requested as CompileTarget)) {
    throw new Error(`Unsupported target ${requested}; supported: ${TARGETS.join(", ")}`);
  }
  const targets = requested ? [requested] : all ? [...TARGETS] : [hostTarget()];

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const checksums: string[] = [];
  for (const target of targets) {
    const name = artifactName(target);
    const outfile = path.join(outputDir, name);
    const build = Bun.spawnSync([
      process.execPath, "build", path.join(repoRoot, "src/cli.ts"),
      "--compile", "--minify", `--target=${target}`, `--outfile=${outfile}`,
    ], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
    if (build.exitCode !== 0) throw new Error(`Compile failed for ${target}`);
    const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(outfile).arrayBuffer()).digest("hex");
    checksums.push(`${digest}  ${name}`);
    const size = (await Bun.file(outfile).size / (1024 * 1024)).toFixed(1);
    process.stdout.write(`${name}  ${size} MB  sha256 ${digest.slice(0, 16)}…\n`);
  }

  // `sha256sum -c` compatible, so a downloader can verify with standard tools too.
  await writeFile(path.join(outputDir, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  await writeFile(path.join(outputDir, "VERSION"), `${CASPER_VERSION}\n`);
  for (const installer of INSTALLERS) {
    const destination = path.join(outputDir, installer.file);
    await copyFile(path.join(repoRoot, "scripts", installer.file), destination);
    await chmod(destination, installer.mode);
  }
  process.stdout.write(`\n${targets.length} artifact(s) plus install.sh and install.ps1 in dist/release for casper ${CASPER_VERSION}\n`);
  process.stdout.write("Set the release-host default in scripts/install.sh and scripts/install.ps1 BEFORE building; upload the whole resulting directory.\n");
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[release] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { TARGETS, hostTarget };
