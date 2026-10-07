import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { HANDOFF_SCRIPT, compareVersions, defaultRunner, gitEnv, newestRelease, runUpdate, type Fetcher, type ProcessRunner } from "../src/update/command";
import { runningFromBinary } from "../src/update/mode";
import { CHECK_EVERY_MS, refreshUpdateCheck, updateChecksOff, updateNotice } from "../src/update/notice";
import { testReleaseKey, type TestKey } from "./support/release-signing";
import { removeTempDir } from "./support/temp-dir";

setDefaultTimeout(30_000);

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await removeTempDir(dir); });

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const DOWNLOAD = "https://github.com/Choaterboater/casper/releases/download";
/** These cases are about everything but the signature, so they hold whether or not a release key is pinned yet. */
const NO_KEY = "";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const installer = (version: string) => `#!/bin/sh\nBASE_URL="\${CASPER_BASE_URL:-${DOWNLOAD}/v${version}}"\necho fake installer\n`;

interface FakeRelease { tag_name: string; draft?: boolean; prerelease?: boolean; assets?: Array<{ name: string; digest?: string }> }

/** GitHub's release list, plus each release's files, served from memory. */
function fakeGitHub(releases: FakeRelease[] | (() => Response), files: Record<string, string> = {}) {
  const asked: string[] = [];
  const fetch: Fetcher = async (url) => {
    asked.push(url);
    if (url.startsWith("https://api.github.com/")) {
      // GitHub publishes a digest for every release file; a release given without assets gets the served installers'.
      const published = (tag: string) => ["install.sh", "install.ps1"].flatMap((name) => {
        const file = files[`${DOWNLOAD}/${tag}/${name}`];
        return file === undefined ? [] : [{ name, digest: `sha256:${sha(file)}` }];
      });
      return typeof releases === "function" ? releases() : Response.json(releases.map((release) => ({ draft: false, prerelease: true, assets: published(release.tag_name), ...release })));
    }
    const file = files[url];
    return file === undefined ? new Response("missing", { status: 404 }) : new Response(file);
  };
  return { fetch, asked };
}

function releaseFiles(version: string, script = installer(version)) {
  return {
    [`${DOWNLOAD}/v${version}/install.sh`]: script,
    [`${DOWNLOAD}/v${version}/install.ps1`]: `$Base = if ($env:CASPER_BASE_URL) { $env:CASPER_BASE_URL } else { '${DOWNLOAD}/v${version}' }\n`,
    [`${DOWNLOAD}/v${version}/SHA256SUMS`]: `${"0".repeat(64)}  casper-darwin-arm64\n`,
  };
}

/** A runner that records what would run and pretends it worked. */
function recordingRunner(result: (argv: string[], env: NodeJS.ProcessEnv) => number = () => 0) {
  const calls: Array<{ argv: string[]; cwd?: string; env: NodeJS.ProcessEnv; inherit?: boolean; script?: string }> = [];
  const run: ProcessRunner = async (argv, options) => {
    const script = argv.find((arg) => /install\.(sh|ps1)$/.test(arg));
    calls.push({ argv, ...(options.cwd ? { cwd: options.cwd } : {}), env: options.env, ...(options.inherit ? { inherit: true } : {}),
      ...(script ? { script: await readFile(script, "utf8") } : {}) });
    return { code: result(argv, options.env), stdout: "", stderr: "" };
  };
  return { run, calls };
}

async function binaryInstall(name = "casper") {
  const dir = await tempDir("casper-update-bin-");
  const executable = path.join(dir, name);
  await writeFile(executable, "old");
  return { dir, executable };
}

test("a compiled binary is told apart from a source checkout by the module path", () => {
  expect(runningFromBinary("/$bunfs/root/casper")).toBe(true);
  expect(runningFromBinary("B:\\~BUN\\root\\casper.exe")).toBe(true);
  expect(runningFromBinary("/home/someone/casper/src/cli-main.ts")).toBe(false);
});

test("versions compare by number, and a pre-release suffix comes before its release", () => {
  expect(compareVersions("0.2.10", "0.2.9")).toBeGreaterThan(0);
  expect(compareVersions("v0.3.0", "0.2.21")).toBeGreaterThan(0);
  expect(compareVersions("0.2.21", "0.2.21")).toBe(0);
  expect(compareVersions("0.2.22-rc.1", "0.2.22")).toBeLessThan(0);
  expect(compareVersions("0.2.22-rc.1", "0.2.21")).toBeGreaterThan(0);
  expect(compareVersions("0.2.22-rc.10", "0.2.22-rc.9")).toBeGreaterThan(0);
});

test("the newest release counts previews, skips drafts and tags that are not versions", () => {
  expect(newestRelease([
    { tag_name: "v0.2.20", prerelease: true, draft: false },
    { tag_name: "v0.2.23", prerelease: false, draft: true },
    { tag_name: "v0.2.22", prerelease: true, draft: false },
    { tag_name: "nightly", prerelease: true, draft: false },
    { tag_name: "v0.2.9", prerelease: false, draft: false },
  ])?.version).toBe("0.2.22");
  expect(newestRelease([])).toBeUndefined();
  expect(newestRelease({ message: "Not Found" })).toBeUndefined();
});

test("binary: already on the newest release says so in one line and changes nothing", async () => {
  const { executable } = await binaryInstall();
  const github = fakeGitHub([{ tag_name: "v0.2.21" }, { tag_name: "v0.2.20" }]);
  const { run, calls } = recordingRunner();
  const lines: string[] = [];
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "darwin" });
  expect(result.exitCode).toBe(0);
  expect(lines).toEqual(["Casper 0.2.21 is the newest release."]);
  expect(calls).toEqual([]);
  expect(github.asked).toEqual(["https://api.github.com/repos/Choaterboater/casper/releases?per_page=30"]);
});

test("binary --check reports a newer release and installs nothing", async () => {
  const { executable } = await binaryInstall();
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22"));
  const { run, calls } = recordingRunner();
  const lines: string[] = [];
  const result = await runUpdate({ releaseKey: NO_KEY, check: true, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "linux" });
  expect(result.exitCode).toBe(0);
  expect(lines).toEqual(["Casper 0.2.22 is out; you have 0.2.21. Run casper update to install it."]);
  expect(calls).toEqual([]);
  expect(github.asked).toHaveLength(1);
});

test("binary: a newer release runs that release's installer on this program's folder, pinned to the new version", async () => {
  const { dir, executable } = await binaryInstall();
  const script = installer("0.2.22");
  const github = fakeGitHub([{ tag_name: "v0.2.22", assets: [{ name: "install.sh", digest: `sha256:${sha(script)}` }] }, { tag_name: "v0.2.21" }], releaseFiles("0.2.22", script));
  const { run, calls } = recordingRunner();
  const lines: string[] = [];
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "darwin", arch: "arm64",
    env: { PATH: "/usr/bin", CASPER_SHA256: "f".repeat(64), CASPER_OS: "windows", CASPER_INSTALL_DIR: "/elsewhere" } });
  expect(result.exitCode).toBe(0);
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.argv[0]).toBe("sh");
  expect(call.argv.slice(2)).toEqual(["--dir", await realDir(dir), "--version", "0.2.22"]);
  expect(call.script).toBe(script);
  expect(call.inherit).toBe(true);
  expect(call.env.CASPER_BASE_URL).toBe(`${DOWNLOAD}/v0.2.22`);
  // The user's own overrides cannot change the hash, the platform or the folder: the hash is this program's line in
  // the list Casper checked, so the installer fetches no list of its own.
  expect(call.env).toMatchObject({ CASPER_SHA256: "0".repeat(64), CASPER_OS: "darwin", CASPER_ARCH: "arm64" });
  expect(call.env.CASPER_INSTALL_DIR).toBeUndefined();
  expect(lines).toEqual(["Updating Casper from 0.2.21 to 0.2.22.", "Casper is now 0.2.22."]);
  // The downloaded installer is gone afterwards.
  await expect(readFile(call.argv[1]!, "utf8")).rejects.toThrow();
});

test("binary: an installer GitHub published no digest for, with no signed list naming it, is never run", async () => {
  const { executable } = await binaryInstall();
  for (const assets of [[], [{ name: "install.sh" }]]) {
    const github = fakeGitHub([{ tag_name: "v0.2.22", assets }], releaseFiles("0.2.22"));
    const { run, calls } = recordingRunner();
    const lines: string[] = [];
    const result = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "linux" });
    expect(result.exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(lines.at(-1)).toBe("GitHub published no checksum for the Casper 0.2.22 installer, so it was not run. Nothing was changed.");
  }
});

test("binary: an installer that does not match its published digest is never run", async () => {
  const { executable } = await binaryInstall();
  const github = fakeGitHub([{ tag_name: "v0.2.22", assets: [{ name: "install.sh", digest: `sha256:${"a".repeat(64)}` }] }], releaseFiles("0.2.22"));
  const { run, calls } = recordingRunner();
  const lines: string[] = [];
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "linux" });
  expect(result.exitCode).toBe(1);
  expect(calls).toEqual([]);
  expect(lines.at(-1)).toBe("The downloaded installer did not match the release's checksum, so it was not run. Nothing was changed.");
});

/** A release whose SHA256SUMS names its installer and is signed with `key` (or carries `signature` instead). */
function signedRelease(version: string, key: TestKey, options: { signature?: string | null; listInstaller?: boolean; script?: string } = {}) {
  const script = options.script ?? installer(version);
  const sums = `${"0".repeat(64)}  casper-linux-x64\n${options.listInstaller === false ? "" : `${sha(installer(version))}  install.sh\n`}`;
  const files: Record<string, string> = { ...releaseFiles(version, script), [`${DOWNLOAD}/v${version}/SHA256SUMS`]: sums };
  if (options.signature !== null) files[`${DOWNLOAD}/v${version}/SHA256SUMS.sig`] = options.signature ?? key.sign(sums);
  return fakeGitHub([{ tag_name: `v${version}` }], files);
}

async function signedUpdate(github: ReturnType<typeof fakeGitHub>, key: TestKey, result?: (argv: string[]) => number | null) {
  const { executable } = await binaryInstall();
  const calls: string[][] = [];
  const run: ProcessRunner = async (argv) => { calls.push(argv); return { code: result ? result(argv) : 0, stdout: "", stderr: "" }; };
  const lines: string[] = [];
  const outcome = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line),
    fetch: github.fetch, run, platform: "linux", arch: "x64", env: {}, releaseKey: key.publicKey });
  return { exitCode: outcome.exitCode, lines, calls };
}

test("binary: with a release key, a signed list that names the installer lets it run, after gh checks where it was built", async () => {
  const key = testReleaseKey();
  const result = await signedUpdate(signedRelease("0.2.22", key), key);
  expect(result.exitCode).toBe(0);
  expect(result.calls.map((argv) => argv.slice(0, 3).join(" "))).toEqual(["gh auth status", "gh attestation verify", "gh attestation verify", expect.stringMatching(/^sh .*install\.sh --dir$/)]);
  expect(result.calls[1]).toEqual(["gh", "attestation", "verify", "--help"]);
  expect(result.calls[2]!.slice(-2)).toEqual(["--repo", "Choaterboater/casper"]);
});

test("binary: with a release key, a missing or bad signature, or a list without the installer, never runs it", async () => {
  const key = testReleaseKey();
  const cases: Array<[ReturnType<typeof fakeGitHub>, string]> = [
    [signedRelease("0.2.22", key, { signature: null }), "Casper 0.2.22 has no release signature (SHA256SUMS.sig), so its installer was not run. Nothing was changed."],
    [signedRelease("0.2.22", key, { signature: testReleaseKey().sign("anything") }), "The release signature on Casper 0.2.22 doesn't match the Casper release key, so its installer was not run. Nothing was changed."],
    [signedRelease("0.2.22", key, { signature: "junk" }), "The release signature on Casper 0.2.22 doesn't match the Casper release key, so its installer was not run. Nothing was changed."],
    [signedRelease("0.2.22", key, { listInstaller: false }), "The signed list for Casper 0.2.22 does not name install.sh, so it was not run. Nothing was changed."],
    [signedRelease("0.2.22", key, { script: `${installer("0.2.22")}# changed\n` }), "The downloaded installer did not match the release's checksum, so it was not run. Nothing was changed."],
  ];
  for (const [github, message] of cases) {
    const result = await signedUpdate(github, key);
    expect({ exitCode: result.exitCode, last: result.lines.at(-1), calls: result.calls }).toEqual({ exitCode: 1, last: message, calls: [] });
  }
});

test("binary: with a release key, the installer gets this program's digest from the signed list and fetches no list itself", async () => {
  const key = testReleaseKey();
  const binary = "b".repeat(64);
  const sums = `${binary}  casper-linux-x64\n${sha(installer("0.2.22"))}  install.sh\n`;
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], { ...releaseFiles("0.2.22"), [`${DOWNLOAD}/v0.2.22/SHA256SUMS`]: sums, [`${DOWNLOAD}/v0.2.22/SHA256SUMS.sig`]: key.sign(sums) });
  const { executable } = await binaryInstall();
  const { run, calls } = recordingRunner();
  const lines: string[] = [];
  const result = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line),
    fetch: github.fetch, run, platform: "linux", arch: "x64", env: { CASPER_SHA256: "f".repeat(64), CASPER_ARCH: "arm64" }, releaseKey: key.publicKey });
  expect(result.exitCode).toBe(0);
  const install = calls.find((call) => call.argv[0] === "sh")!;
  expect(install.env).toMatchObject({ CASPER_SHA256: binary, CASPER_OS: "linux", CASPER_ARCH: "x64" });
  // A signed list that doesn't name this program's file installs nothing.
  const other = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line),
    fetch: github.fetch, run, platform: "linux", arch: "arm64", env: {}, releaseKey: key.publicKey });
  expect(other.exitCode).toBe(1);
  expect(lines.at(-1)).toBe("The signed list for Casper 0.2.22 does not name casper-linux-arm64, so nothing was installed. Nothing was changed.");
  expect(calls.filter((call) => call.argv[0] === "sh")).toHaveLength(1);
});

test("windows: the installer gets this program's file and digest from the list Casper checked", async () => {
  const { executable } = await binaryInstall("casper.exe");
  const sums = `${"c".repeat(64)}  casper-windows-x64.exe\n`;
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], { ...releaseFiles("0.2.22"), [`${DOWNLOAD}/v0.2.22/SHA256SUMS`]: sums });
  const { run } = recordingRunner();
  const handoff = fakeHandoff();
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: () => {}, fetch: github.fetch, run, startDetached: handoff.start, platform: "win32", arch: "x64" });
  expect(result.exitCode).toBe(0);
  const calls = handoff.calls;
  expect(calls[0]!.env).toMatchObject({ CASPER_SHA256: "c".repeat(64), CASPER_ARCH: "x64" });
});

test("binary: gh signed in and saying the installer isn't a Casper build stops the update; gh missing, signed out or too old does not", async () => {
  const key = testReleaseKey();
  const refused = await signedUpdate(signedRelease("0.2.22", key), key, (argv) => argv[1] === "attestation" && !argv.includes("--help") ? 1 : 0);
  expect(refused.exitCode).toBe(1);
  expect(refused.lines.at(-1)).toBe("The downloaded installer doesn't match a Casper build from GitHub, so it was not run. Nothing was changed.");
  expect(refused.calls.some((argv) => argv[0] === "sh")).toBe(false);
  for (const auth of [1, null]) {
    const result = await signedUpdate(signedRelease("0.2.22", key), key, (argv) => argv[0] === "gh" ? auth : 0);
    expect(result.exitCode).toBe(0);
    expect(result.calls.map((argv) => argv[0])).toEqual(["gh", "sh"]);
  }
  // A gh from before 2.49 has no `attestation` command, so even its help fails: that is not a mismatch.
  const old = await signedUpdate(signedRelease("0.2.22", key), key, (argv) => argv[1] === "attestation" ? 1 : 0);
  expect(old.exitCode).toBe(0);
  expect(old.calls.map((argv) => argv.slice(0, 4).join(" "))).toEqual(["gh auth status", "gh attestation verify --help", expect.stringMatching(/^sh /)]);
});

test("binary: an installer that points at another release is never run", async () => {
  const { executable } = await binaryInstall();
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22", installer("0.2.20")));
  const { run, calls } = recordingRunner();
  const lines: string[] = [];
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "linux" });
  expect(result.exitCode).toBe(1);
  expect(calls).toEqual([]);
  expect(lines.at(-1)).toBe("The downloaded installer is for a different release than 0.2.22, so it was not run. Nothing was changed.");
});

test("binary: a failed installer leaves the old program and says so", async () => {
  const { executable } = await binaryInstall();
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22"));
  const { run } = recordingRunner(() => 1);
  const lines: string[] = [];
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "linux" });
  expect(result.exitCode).toBe(1);
  expect(lines.at(-1)).toBe("The installer stopped before it finished; Casper 0.2.21 is still installed.");
  expect(await readFile(executable, "utf8")).toBe("old");
});

test("binary: a program not named casper is not replaced by an installer that writes casper", async () => {
  const { executable } = await binaryInstall("casper-darwin-arm64");
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22"));
  const { run, calls } = recordingRunner();
  const lines: string[] = [];
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "darwin" });
  expect(result.exitCode).toBe(1);
  expect(calls).toEqual([]);
  expect(lines.at(-1)).toContain("is named casper-darwin-arm64");
});

/** A stand-in for the detached start: records the command and the installer file as it was at that moment. */
function fakeHandoff(started = true) {
  const calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv; installer?: string; script?: string }> = [];
  const start = async (argv: string[], options: { env: NodeJS.ProcessEnv }) => {
    const at = (flag: string) => argv[argv.indexOf(flag) + 1]!;
    calls.push({ argv, env: options.env, installer: await readFile(at("-Installer"), "utf8").catch(() => undefined), script: await readFile(at("-File"), "utf8").catch(() => undefined) });
    return started;
  };
  return { start, calls };
}

test("windows: the verified installer is handed to a detached process that waits for this one, and Casper exits 0", async () => {
  const { dir, executable } = await binaryInstall("casper.exe");
  const files = releaseFiles("0.2.22");
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], files);
  const { run, calls: ran } = recordingRunner();
  const handoff = fakeHandoff();
  const lines: string[] = [];
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, startDetached: handoff.start, pid: 4242, platform: "win32" });
  expect(result.exitCode).toBe(0);
  expect(ran).toEqual([]);
  expect(handoff.calls).toHaveLength(1);
  const { argv, env, installer: handed } = handoff.calls[0]!;
  expect(argv.slice(0, 9)).toEqual(["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", argv[8]!]);
  const arg = (flag: string) => argv[argv.indexOf(flag) + 1];
  expect(arg("-WaitPid")).toBe("4242");
  expect(arg("-InstallDir")).toBe(await realDir(dir));
  expect(arg("-Version")).toBe("0.2.22");
  // The file it will run is exactly the verified installer, and its hash travels with it.
  expect(handed).toBe(files[`${DOWNLOAD}/v0.2.22/install.ps1`]);
  expect(arg("-InstallerSha256")).toBe(sha(files[`${DOWNLOAD}/v0.2.22/install.ps1`]));
  expect(env).toMatchObject({ CASPER_BASE_URL: `${DOWNLOAD}/v0.2.22` });
  // Nothing is downloaded again and the running program is untouched.
  expect(github.asked.filter((url) => url.endsWith("install.ps1"))).toHaveLength(1);
  expect(await readdir(dir)).toEqual(["casper.exe"]);
  expect(lines.at(-1)).toBe("Casper will finish updating when this window closes: it is replacing its own program. Run casper --version afterwards.");
  // The temp folder stays for the handoff, which removes it itself.
  const cleanup = arg("-Cleanup")!;
  expect(await readdir(cleanup)).toContain("install.ps1");
  await removeTempDir(cleanup);
});

test("windows: the handoff script waits on one pid, runs nothing when the check is unclear, and builds no command text", () => {
  expect(HANDOFF_SCRIPT).toContain("Get-Process -Id $WaitPid");
  expect(HANDOFF_SCRIPT).toContain("WaitForExit");
  expect(HANDOFF_SCRIPT).toContain("Get-FileHash");
  expect(HANDOFF_SCRIPT).not.toMatch(/Invoke-Expression|iex\b|DownloadString|Invoke-WebRequest|irm\b/i);
});

test("windows: when the detached start fails, the old message is shown and nothing is left behind", async () => {
  const { dir, executable } = await binaryInstall("casper.exe");
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22"));
  const { run } = recordingRunner();
  const handoff = fakeHandoff(false);
  const lines: string[] = [];
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, startDetached: handoff.start, platform: "win32" });
  expect(result.exitCode).toBe(1);
  expect(lines.at(-1)).toBe(`Windows would not let Casper move its own program aside. Close Casper, then run this in PowerShell: irm ${DOWNLOAD}/v0.2.22/install.ps1 | iex`);
  expect(await readdir(dir)).toEqual(["casper.exe"]);
  const folder = path.dirname(handoff.calls[0]!.argv[handoff.calls[0]!.argv.indexOf("-Installer") + 1]!);
  expect(await readdir(folder).catch(() => "gone")).toBe("gone");
  const threw = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: () => {}, fetch: github.fetch, run, startDetached: async () => { throw new Error("no"); }, platform: "win32" });
  expect(threw.exitCode).toBe(1);
});

test("windows: an installer that fails verification is never handed off", async () => {
  const { executable } = await binaryInstall("casper.exe");
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], { ...releaseFiles("0.2.22"), [`${DOWNLOAD}/v0.2.22/install.ps1`]: "Write-Host tampered\n" });
  const handoff = fakeHandoff();
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: () => {}, fetch: github.fetch, run: recordingRunner().run, startDetached: handoff.start, platform: "win32" });
  expect(result.exitCode).toBe(1);
  expect(handoff.calls).toEqual([]);
});

test("non-Windows: the installer still runs in this process and nothing is handed off", async () => {
  const { executable } = await binaryInstall();
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22"));
  const { run, calls } = recordingRunner();
  const handoff = fakeHandoff();
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: () => {}, fetch: github.fetch, run, startDetached: handoff.start, platform: "linux" });
  expect(result.exitCode).toBe(0);
  expect(calls[0]!.argv[0]).toBe("sh");
  expect(handoff.calls).toEqual([]);
});

test("a GitHub token in GITHUB_TOKEN or GH_TOKEN goes only to the release lookup, and a rejected one is named", async () => {
  const { executable } = await binaryInstall();
  for (const [env, name] of [[{ GITHUB_TOKEN: "t1" }, "GITHUB_TOKEN"], [{ GH_TOKEN: "t2" }, "GH_TOKEN"]] as const) {
    const seen: Array<string | undefined> = [];
    const fetch: Fetcher = async (_url, init) => { seen.push(init?.headers?.Authorization); return new Response("{}", { status: 401 }); };
    const lines: string[] = [];
    const result = await runUpdate({ releaseKey: NO_KEY, check: true, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch, run: recordingRunner().run, platform: "linux", env });
    expect(result.exitCode).toBe(1);
    expect(seen).toEqual([`Bearer ${env[name as keyof typeof env]}`]);
    expect(lines).toEqual([`GitHub did not accept the token in ${name}. Nothing was changed.`]);
  }
  const limited: Fetcher = async () => new Response("{}", { status: 403 });
  const lines: string[] = [];
  await runUpdate({ releaseKey: NO_KEY, check: true, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: limited, run: recordingRunner().run, platform: "linux", env: { GH_TOKEN: "t" } });
  expect(lines).toEqual(["GitHub is limiting requests right now; try again later. Nothing was changed."]);
});

test("GitHub unreachable, limiting requests or answering nonsense: one plain line, exit 1, nothing changed", async () => {
  const { executable } = await binaryInstall();
  const cases: Array<[Fetcher, string]> = [
    [async () => { throw new TypeError("fetch failed"); }, "Could not reach GitHub to look for a newer Casper. Nothing was changed."],
    [async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }), "GitHub is limiting requests right now; try again later, or set GITHUB_TOKEN to a GitHub token for a higher limit. Nothing was changed."],
    [async () => new Response("{}", { status: 429 }), "GitHub is limiting requests right now; try again later, or set GITHUB_TOKEN to a GitHub token for a higher limit. Nothing was changed."],
    [async () => new Response("oops", { status: 502 }), "GitHub answered with an error (HTTP 502). Nothing was changed."],
    [async () => new Response("<html>not json</html>"), "GitHub's list of Casper releases could not be read. Nothing was changed."],
    [async () => Response.json([]), "GitHub's list of Casper releases could not be read. Nothing was changed."],
  ];
  for (const [fetch, message] of cases) {
    const { run, calls } = recordingRunner();
    const lines: string[] = [];
    for (const check of [false, true]) {
      lines.length = 0;
      const result = await runUpdate({ check, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch, run, platform: "linux", env: {} });
      expect(result.exitCode).toBe(1);
      expect(lines).toEqual([message]);
    }
    expect(calls).toEqual([]);
  }
  expect(await readFile(executable, "utf8")).toBe("old");
});

// --- Source checkout: real git, a fake bun ---

const GIT_ENV = (() => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !/^GIT_/i.test(name)) env[name] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
})();

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function commitVersion(repo: string, version: string, lock?: string, message = `v${version}`) {
  await writeFile(path.join(repo, "package.json"), `${JSON.stringify({ name: "casper", version }, null, 2)}\n`);
  if (lock !== undefined) await writeFile(path.join(repo, "bun.lock"), lock);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

async function checkoutPair() {
  const root = await tempDir("casper-update-git-");
  const upstream = path.join(root, "upstream");
  await mkdir(upstream);
  git(upstream, "init", "-q");
  await commitVersion(upstream, "0.2.21", "lock-1");
  git(root, "clone", "-q", upstream, "checkout");
  return { upstream, checkout: path.join(root, "checkout") };
}

/** Real git; `bun` is recorded, not run. */
function checkoutRunner() {
  const bunCalls: Array<{ argv: string[]; cwd?: string }> = [];
  const run: ProcessRunner = async (argv, options) => {
    if (argv[0] === "fake-bun") { bunCalls.push({ argv, ...(options.cwd ? { cwd: options.cwd } : {}) }); return { code: 0, stdout: "", stderr: "" }; }
    return defaultRunner(argv, options);
  };
  return { run, bunCalls };
}

async function updateCheckout(checkout: string, check = false) {
  const { run, bunCalls } = checkoutRunner();
  const lines: string[] = [];
  const fetch: Fetcher = async () => { throw new Error("a checkout never asks GitHub for releases"); };
  const result = await runUpdate({ check, install: { kind: "checkout", root: checkout }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch, run, bun: "fake-bun", env: GIT_ENV });
  return { ...result, lines, bunCalls };
}

test("checkout: already up to date pulls nothing and runs nothing else", async () => {
  const { checkout } = await checkoutPair();
  const { exitCode, lines, bunCalls } = await updateCheckout(checkout);
  expect(exitCode).toBe(0);
  expect(lines).toEqual([`The Casper checkout at ${checkout} is already up to date (0.2.21).`]);
  expect(bunCalls).toEqual([]);
}, 60_000);

test("checkout: newer commits are pulled and the new version is named; an unchanged lockfile needs no install", async () => {
  const { upstream, checkout } = await checkoutPair();
  await commitVersion(upstream, "0.2.22");
  const { exitCode, lines, bunCalls } = await updateCheckout(checkout);
  expect(exitCode).toBe(0);
  expect(lines).toEqual([`Updated the Casper checkout at ${checkout} from 0.2.21 to 0.2.22.`]);
  expect(bunCalls).toEqual([]);
  expect(JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8")).version).toBe("0.2.22");
});

test("checkout: a changed lockfile runs bun install --frozen-lockfile in the checkout", async () => {
  const { upstream, checkout } = await checkoutPair();
  await commitVersion(upstream, "0.2.21", "lock-2", "new dependency");
  const { exitCode, lines, bunCalls } = await updateCheckout(checkout);
  expect(exitCode).toBe(0);
  expect(bunCalls).toEqual([{ argv: ["fake-bun", "install", "--frozen-lockfile"], cwd: checkout }]);
  expect(lines).toEqual([
    `Updated the Casper checkout at ${checkout} (still 0.2.21, 1 new change).`,
    "Casper's dependency list (bun.lock) changed, so it ran bun install in the checkout.",
  ]);
});

test("checkout: a pull that cannot fast-forward changes nothing and exits 1", async () => {
  const { upstream, checkout } = await checkoutPair();
  await commitVersion(upstream, "0.2.22");
  await commitVersion(checkout, "0.2.21-local", undefined, "local work");
  const before = git(checkout, "rev-parse", "HEAD");
  const { exitCode, lines, bunCalls } = await updateCheckout(checkout);
  expect(exitCode).toBe(1);
  expect(lines).toEqual([`The Casper checkout at ${checkout} has its own commits or changes in the way, so it was not updated; nothing was forced.`]);
  expect(git(checkout, "rev-parse", "HEAD")).toBe(before);
  expect(bunCalls).toEqual([]);
});

test("checkout: its own commits are told apart from a network problem in any language", async () => {
  const { upstream, checkout } = await checkoutPair();
  await commitVersion(upstream, "0.2.22");
  await commitVersion(checkout, "0.2.21-local", undefined, "local work");
  const { run } = checkoutRunner();
  const lines: string[] = [];
  const env = { ...GIT_ENV, LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", LANGUAGE: "de" };
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "checkout", root: checkout }, currentVersion: "0.2.21", write: (line) => lines.push(line), run, bun: "fake-bun", env });
  expect(result.exitCode).toBe(1);
  expect(lines).toEqual([`The Casper checkout at ${checkout} has its own commits or changes in the way, so it was not updated; nothing was forced.`]);
});

test("checkout: git keeps the user's way of reaching the remote but not settings that point at another repository", () => {
  const env = gitEnv({ PATH: "/usr/bin", GIT_SSH_COMMAND: "ssh -i key", GIT_SSH: "ssh", GIT_ASKPASS: "askpass", GIT_PROXY_COMMAND: "proxy",
    GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere", GIT_INDEX_FILE: "i", GIT_CONFIG_GLOBAL: "c", GIT_CONFIG_COUNT: "1", GIT_CEILING_DIRECTORIES: "/", GIT_NAMESPACE: "n", LANG: "de_DE.UTF-8" });
  expect(env).toMatchObject({ PATH: "/usr/bin", GIT_SSH_COMMAND: "ssh -i key", GIT_SSH: "ssh", GIT_ASKPASS: "askpass", GIT_PROXY_COMMAND: "proxy",
    GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANGUAGE: "C" });
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT", "GIT_CEILING_DIRECTORIES", "GIT_NAMESPACE"]) expect(env[name]).toBeUndefined();
});

test("checkout: a changed lockfile whose bun install fails says what is left to do and exits 1", async () => {
  const { upstream, checkout } = await checkoutPair();
  await commitVersion(upstream, "0.2.22", "lock-2");
  const lines: string[] = [];
  const run: ProcessRunner = async (argv, options) => argv[0] === "fake-bun" ? { code: 1, stdout: "", stderr: "" } : defaultRunner(argv, options);
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "checkout", root: checkout }, currentVersion: "0.2.21", write: (line) => lines.push(line), run, bun: "fake-bun", env: GIT_ENV });
  expect(result.exitCode).toBe(1);
  expect(lines).toEqual([
    `Updated the Casper checkout at ${checkout} from 0.2.21 to 0.2.22.`,
    `Casper's dependency list (bun.lock) changed, but bun install failed; run bun install --frozen-lockfile in ${checkout}.`,
  ]);
});

test("checkout: no branch to pull from is said plainly", async () => {
  const { checkout } = await checkoutPair();
  git(checkout, "checkout", "-q", "-b", "solo");
  const { exitCode, lines } = await updateCheckout(checkout);
  expect(exitCode).toBe(1);
  expect(lines).toEqual([`The Casper checkout at ${checkout} is on solo, which has no remote to pull from, so it was not updated. `
    + "To update it, switch to main (git switch main) and run casper update again."]);
  const checked = await updateCheckout(checkout, true);
  expect(checked.lines).toEqual([`The Casper checkout at ${checkout} is on solo, which has no remote to pull from. `
    + "To update it, switch to main (git switch main) and run casper update again."]);
  git(checkout, "remote", "set-head", "origin", "--delete");
  expect((await updateCheckout(checkout)).lines).toEqual([`The Casper checkout at ${checkout} is on solo, which has no remote to pull from, so it was not updated.`]);
  git(checkout, "checkout", "-q", "--detach");
  expect((await updateCheckout(checkout)).lines).toEqual([`The Casper checkout at ${checkout} is not on a branch, so there is nothing to pull from and it was not updated.`]);
});

test("checkout: a folder that is not a git checkout, or no git, is said plainly", async () => {
  const folder = await tempDir("casper-update-plain-");
  const { exitCode, lines } = await updateCheckout(folder);
  expect(exitCode).toBe(1);
  expect(lines).toEqual([`Casper runs from ${folder}, which is not a git checkout, so it cannot be updated with git.`]);
  const missing: ProcessRunner = async () => ({ code: null, stdout: "", stderr: "" });
  const noGit: string[] = [];
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "checkout", root: folder }, currentVersion: "0.2.21", write: (line) => noGit.push(line), run: missing });
  expect(result.exitCode).toBe(1);
  expect(noGit).toEqual([`Git is not installed, so the Casper checkout at ${folder} cannot be updated.`]);
});

test("checkout --check fetches and counts what is waiting, and changes nothing else", async () => {
  const { upstream, checkout } = await checkoutPair();
  const current = await updateCheckout(checkout, true);
  expect(current.lines).toEqual([`The Casper checkout at ${checkout} is up to date (0.2.21).`]);
  await commitVersion(upstream, "0.2.22", "lock-2");
  await commitVersion(upstream, "0.2.23");
  const before = git(checkout, "rev-parse", "HEAD");
  const { exitCode, lines, bunCalls } = await updateCheckout(checkout, true);
  expect(exitCode).toBe(0);
  expect(lines).toEqual([`The Casper checkout at ${checkout} is 2 changes behind. Run casper update to pull them.`]);
  expect(git(checkout, "rev-parse", "HEAD")).toBe(before);
  expect(bunCalls).toEqual([]);
});

async function realDir(dir: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(dir);
}

// --- The new-version line at the start of a session ---

test("notice: a release binary shows the newer release from the last check, and looks again only once a day", async () => {
  const stateDir = await tempDir("casper-notice-");
  const github = fakeGitHub([{ tag_name: "v0.2.22" }, { tag_name: "v0.2.21" }]);
  let now = 1_000_000;
  const options = { install: { kind: "binary" as const, executable: "/opt/casper/casper" }, currentVersion: "0.2.21", stateDir, fetch: github.fetch, env: {}, now: () => now };
  // Nothing checked yet: nothing to show, and starting never waits on GitHub.
  expect(await updateNotice(options)).toBeUndefined();
  expect(github.asked).toEqual([]);
  await refreshUpdateCheck(options);
  expect(github.asked).toHaveLength(1);
  expect(await updateNotice(options)).toBe("Casper 0.2.22 is out (you have 0.2.21). Run casper update to install it.");
  // Within a day it does not ask again; after a day it does.
  now += CHECK_EVERY_MS - 1;
  await refreshUpdateCheck(options);
  expect(github.asked).toHaveLength(1);
  now += 1;
  await refreshUpdateCheck(options);
  expect(github.asked).toHaveLength(2);
  // Once updated, the same saved release is not newer.
  expect(await updateNotice({ ...options, currentVersion: "0.2.22" })).toBeUndefined();
});

test("notice: a failed release lookup saves nothing and shows nothing", async () => {
  const stateDir = await tempDir("casper-notice-");
  const github = fakeGitHub(() => new Response("busy", { status: 503 }));
  const options = { install: { kind: "binary" as const, executable: "/opt/casper/casper" }, currentVersion: "0.2.21", stateDir, fetch: github.fetch, env: {} };
  await refreshUpdateCheck(options);
  expect(await readdir(stateDir)).toEqual([]);
  expect(await updateNotice(options)).toBeUndefined();
});

test("notice: a checkout counts what it is behind, and the count goes away once it moves", async () => {
  const { upstream, checkout } = await checkoutPair();
  const stateDir = await tempDir("casper-notice-");
  const { run } = checkoutRunner();
  const options = { install: { kind: "checkout" as const, root: checkout }, currentVersion: "0.2.21", stateDir, run, env: GIT_ENV };
  await refreshUpdateCheck(options);
  expect(await updateNotice(options)).toBeUndefined();
  await commitVersion(upstream, "0.2.22");
  await commitVersion(upstream, "0.2.23");
  await refreshUpdateCheck({ ...options, now: () => Date.now() + CHECK_EVERY_MS });
  expect(await updateNotice(options)).toBe("The Casper checkout is 2 changes behind. Run casper update to pull them.");
  git(checkout, "pull", "-q", "--ff-only");
  expect(await updateNotice(options)).toBeUndefined();
});

test("notice: a checkout branch with no remote is quiet", async () => {
  const { checkout } = await checkoutPair();
  git(checkout, "checkout", "-q", "-b", "solo");
  const stateDir = await tempDir("casper-notice-");
  const { run } = checkoutRunner();
  await refreshUpdateCheck({ install: { kind: "checkout", root: checkout }, currentVersion: "0.2.21", stateDir, run, env: GIT_ENV });
  expect(await readdir(stateDir)).toEqual([]);
});

test("notice: CASPER_NO_UPDATE_CHECK or CI turns it off", () => {
  expect(updateChecksOff({})).toBe(false);
  expect(updateChecksOff({ CASPER_NO_UPDATE_CHECK: "1" })).toBe(true);
  expect(updateChecksOff({ CASPER_NO_UPDATE_CHECK: "0" })).toBe(false);
  expect(updateChecksOff({ CI: "true" })).toBe(true);
  expect(updateChecksOff({ CI: "false" })).toBe(false);
});
