import { afterEach, expect, test } from "bun:test";
import { CASPER_VERSION } from "../src/version";
import { compileExecutable } from "../scripts/compile";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactName, hostTarget, TARGETS } from "../scripts/build-release";
import { posixOnly } from "./support/platform";

const repoRoot = path.resolve(import.meta.dir, "..");
const installer = path.join(repoRoot, "scripts/install.sh");
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A stand-in artifact: the installer never inspects the binary, it runs `--version`, which
 * prints `casper <version> (<running path>)` like the real CLI. */
async function fakeRelease(root: string, artifact: string, digestOverride?: string) {
  const release = path.join(root, "release");
  await mkdir(release, { recursive: true });
  const binary = path.join(release, artifact);
  await writeFile(binary, `#!/bin/sh\n[ "$1" = "--version" ] && echo "casper 0.2.0 ($0)"\nexit 0\n`);
  await chmod(binary, 0o755);
  const digest = digestOverride ?? new Bun.CryptoHasher("sha256").update(await Bun.file(binary).arrayBuffer()).digest("hex");
  await writeFile(path.join(release, "SHA256SUMS"), `${digest}  ${artifact}\n`);
  return release;
}

async function install(release: string, installDir: string, extra: string[] = []) {
  const child = Bun.spawn(["sh", installer, "--dir", installDir, ...extra], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: installDir, CASPER_BASE_URL: release },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("preview installers agree on the versioned GitHub asset directory", async () => {
  const base = `https://github.com/Choaterboater/casper/releases/download/v${CASPER_VERSION}`;
  const shell = await readFile(installer, "utf8");
  const powershell = await readFile(path.join(repoRoot, "scripts/install.ps1"), "utf8");
  expect(shell).toContain('BASE_URL="${CASPER_BASE_URL:-' + base + '}"');
  expect(powershell).toContain(`else { '${base}' }`);
});

// The POSIX installer and the `#!/bin/sh` stand-in artifact it installs only run on a
// POSIX host, so every case here is POSIX-gated: on Windows these skip with a stated
// reason instead of failing. `install.ps1` — the Windows half, which needs PowerShell —
// has no execution test on this host; URL agreement above is static only.
posixOnly("the installer resolves the same artifact name the release build publishes", async () => {
  const child = Bun.spawn(["sh", installer, "--print-target"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(artifactName(hostTarget()));
  expect(TARGETS).toContain(hostTarget());
});

posixOnly("a verified artifact is installed, runs, and reports its version", async () => {
  const root = await tempDir("casper-install-test-");
  const artifact = artifactName(hostTarget());
  const release = await fakeRelease(root, artifact);
  const installDir = path.join(root, "bin");

  const result = await install(release, installDir);
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(result.stdout).toContain(`Installed casper 0.2.0 to ${installDir}/casper`);
  expect(result.stdout).toContain("Add it to your PATH");
  expect((await stat(path.join(installDir, "casper"))).mode & 0o111).not.toBe(0);

  const run = Bun.spawn([path.join(installDir, "casper"), "--version"], { stdout: "pipe" });
  expect((await new Response(run.stdout).text()).trim()).toBe(`casper 0.2.0 (${installDir}/casper)`);
  expect(await run.exited).toBe(0);
});

posixOnly("a checksum mismatch fails closed and installs nothing", async () => {
  const root = await tempDir("casper-install-test-");
  const artifact = artifactName(hostTarget());
  const release = await fakeRelease(root, artifact, "0".repeat(64));
  const installDir = path.join(root, "bin");

  const result = await install(release, installDir);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Checksum mismatch");
  expect(await stat(path.join(installDir, "casper")).then(() => true, () => false)).toBe(false);
});

posixOnly("an artifact without any available digest is never installed", async () => {
  const root = await tempDir("casper-install-test-");
  const artifact = artifactName(hostTarget());
  const release = await fakeRelease(root, artifact);
  await rm(path.join(release, "SHA256SUMS"));
  const installDir = path.join(root, "bin");

  const result = await install(release, installDir);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Refusing to install an unverified binary");
  expect(await stat(path.join(installDir, "casper")).then(() => true, () => false)).toBe(false);
});

posixOnly("an out-of-band digest installs, and a required version mismatch is rejected", async () => {
  const root = await tempDir("casper-install-test-");
  const artifact = artifactName(hostTarget());
  const release = await fakeRelease(root, artifact);
  const digest = (await readFile(path.join(release, "SHA256SUMS"), "utf8")).split(" ")[0]!;
  const installDir = path.join(root, "bin");

  const wrongVersion = await install(release, installDir, ["--sha256", digest, "--version", "9.9.9"]);
  expect(wrongVersion.exitCode).toBe(1);
  expect(wrongVersion.stderr).toContain("Expected version 9.9.9");
  // A rejected pin must not leave a different binary — or a staged download — behind.
  expect(await stat(path.join(installDir, "casper")).then(() => true, () => false)).toBe(false);
  expect((await readdir(installDir)).filter((name) => name.startsWith(".casper-download"))).toEqual([]);

  const pinned = await install(release, installDir, ["--sha256", digest, "--version", "0.2.0"]);
  expect(pinned.exitCode).toBe(0);
  expect(pinned.stdout).toContain("Installed casper 0.2.0");
});

posixOnly("a development symlink is preserved unless replacement is forced", async () => {
  const root = await tempDir("casper-install-test-");
  const artifact = artifactName(hostTarget());
  const release = await fakeRelease(root, artifact);
  const installDir = path.join(root, "bin");
  await mkdir(installDir, { recursive: true });
  const checkout = path.join(root, "checkout-cli.ts");
  await writeFile(checkout, "#!/usr/bin/env bun\n");
  await symlink(checkout, path.join(installDir, "casper"));

  const refused = await install(release, installDir);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain("looks like a development link");

  const forced = await install(release, installDir, ["--force"]);
  expect(forced.exitCode).toBe(0);
  expect((await stat(path.join(installDir, "casper"))).isFile()).toBe(true);
});

posixOnly("a link into a .scratch checkout is reported and never replaced, even when forced", async () => {
  const root = await tempDir("casper-install-test-");
  const artifact = artifactName(hostTarget());
  const release = await fakeRelease(root, artifact);
  const installDir = path.join(root, "bin");
  await mkdir(installDir, { recursive: true });
  const checkout = path.join(root, ".scratch/preview/src/cli.ts");
  await mkdir(path.dirname(checkout), { recursive: true });
  await writeFile(checkout, "#!/usr/bin/env bun\n");
  const target = path.join(installDir, "casper");
  const relative = path.relative(installDir, checkout);
  await symlink(relative, target);

  const forced = await install(release, installDir, ["--force"]);
  expect(forced.exitCode).toBe(1);
  expect(forced.stderr).toContain(`${target} is a symlink to ${await realpath(checkout)}, which is inside a .scratch checkout`);
  expect(await readlink(target)).toBe(relative);
  expect((await readdir(installDir)).filter((name) => name.startsWith(".casper-download"))).toEqual([]);
});
posixOnly("a failing version probe preserves the previous installation even when its output matches", async () => {
  const root = await tempDir("casper-install-test-");
  const artifact = artifactName(hostTarget());
  const release = await fakeRelease(root, artifact);
  const binary = path.join(release, artifact);
  await writeFile(binary, '#!/bin/sh\necho "casper 0.2.0"\nexit 42\n');
  const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(binary).arrayBuffer()).digest("hex");
  await writeFile(path.join(release, "SHA256SUMS"), `${digest}  ${artifact}\n`);
  const installDir = path.join(root, "bin");
  await mkdir(installDir);
  const target = path.join(installDir, "casper");
  await writeFile(target, "previous installation\n");

  const result = await install(release, installDir, ["--version", "0.2.0"]);
  expect(result.exitCode).toBe(1);
  expect(await readFile(target, "utf8")).toBe("previous installation\n");
  expect((await readdir(installDir)).filter(name => name.startsWith(".casper-download"))).toEqual([]);
});

posixOnly("the compiled CLI renders artifact files outside the checkout without Bun on PATH", async () => {
  const root = await tempDir("casper-binary-test-");
  const binary = path.join(root, "casper");
  await compileExecutable(path.join(repoRoot, "src/standalone.ts"), binary);
  const notices = Bun.spawn([binary, "--licenses"], { cwd: root, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  const [noticeText, noticeError, noticeExit] = await Promise.all([new Response(notices.stdout).text(), new Response(notices.stderr).text(), notices.exited]);
  expect({ exit: noticeExit, error: noticeError }).toEqual({ exit: 0, error: "" });
  expect(noticeText).toContain("CASPER — THIRD-PARTY NOTICES");
  expect(noticeText).toContain("@earendil-works/pi-coding-agent@0.85.1");
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(home); await mkdir(project);
  await writeFile(path.join(project, "index.ts"), "export const answer = 42;\n");
  const child = Bun.spawn([binary, "/visualize repo"], {
    cwd: project, env: { HOME: home, TMPDIR: root, PATH: "/usr/bin:/bin", TERM: "dumb" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(stdout).toContain("flowchart LR");
  const artifacts = await readdir(path.join(home, ".casper/visualizations/project"));
  expect(artifacts.some(name => name.endsWith(".mermaid.mmd"))).toBe(true);
  expect(artifacts.some(name => name.endsWith(".mindmesh.json"))).toBe(true);
}, 120_000);

posixOnly("an unsupported platform is reported instead of guessed", async () => {
  const child = Bun.spawn(["sh", installer], {
    env: { ...process.env, CASPER_OS: "FreeBSD", CASPER_ARCH: "x64", CASPER_BASE_URL: "https://example.invalid" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(exitCode).toBe(2);
  expect(stderr).toContain("Unsupported operating system: FreeBSD");
});
