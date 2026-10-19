import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { HANDOFF_SCRIPT, compareVersions, defaultRunner, gitEnv, newestRelease, runUpdate, windowsArgument, wmiCreateScript, type Fetcher, type ProcessRunner } from "../src/update/command";
import { runningFromBinary } from "../src/update/mode";
import { UPDATE_LOG, lastUpdateFailure, startUpdateLog, updateFailureLines } from "../src/update/handoff-log";
import { backgroundUpdate, INSTALLED_NOTE, FAILED_NOTE, CHECK_EVERY_MS, refreshUpdateCheck, updateChecksOff, updateFooterNote, updateNotice } from "../src/update/notice";
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

/** An update whose stand-in gh says `ghVersion` when asked for its version. */
async function signedUpdate(github: ReturnType<typeof fakeGitHub>, key: TestKey, result?: (argv: string[]) => number | null, ghVersion = "gh version 2.56.0 (2024-09-09)\n") {
  const { executable } = await binaryInstall();
  const calls: string[][] = [];
  const run: ProcessRunner = async (argv) => {
    calls.push(argv);
    return { code: result ? result(argv) : 0, stdout: argv.join(" ") === "gh --version" ? ghVersion : "", stderr: "" };
  };
  const lines: string[] = [];
  const outcome = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line),
    fetch: github.fetch, run, platform: "linux", arch: "x64", env: {}, releaseKey: key.publicKey });
  return { exitCode: outcome.exitCode, lines, calls };
}

test("binary: with a release key, a signed list that names the installer lets it run, after gh checks where it was built", async () => {
  const key = testReleaseKey();
  const result = await signedUpdate(signedRelease("0.2.22", key), key);
  expect(result.exitCode).toBe(0);
  expect(result.calls.map((argv) => argv.slice(0, 3).join(" "))).toEqual(["gh auth status", "gh --version", "gh attestation verify", "gh attestation verify", expect.stringMatching(/^sh .*install\.sh --dir$/)]);
  expect(result.calls[2]).toEqual(["gh", "attestation", "verify", "--help"]);
  expect(result.calls[3]!.slice(-2)).toEqual(["--repo", "Choaterboater/casper"]);
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
  // A gh from before 2.47 has no `attestation` command, so even its help fails: that is not a mismatch, even when its
  // version can't be read.
  const old = await signedUpdate(signedRelease("0.2.22", key), key, (argv) => argv[1] === "attestation" ? 1 : 0, "");
  expect(old.exitCode).toBe(0);
  expect(old.calls.map((argv) => argv.slice(0, 4).join(" "))).toEqual(["gh auth status", "gh --version", "gh attestation verify --help", expect.stringMatching(/^sh /)]);
});

test("binary: a gh that has `attestation` but is older than 2.56 is not asked to check, so it cannot stop the update", async () => {
  const key = testReleaseKey();
  const failsCheck = (argv: string[]) => argv[1] === "attestation" && !argv.includes("--help") ? 1 : 0;
  for (const version of ["gh version 2.47.0 (2024-04-03)\n", "gh version 2.55.0 (2024-08-20)\nhttps://github.com/cli/cli/releases/tag/v2.55.0\n"]) {
    const old = await signedUpdate(signedRelease("0.2.22", key), key, failsCheck, version);
    expect({ version, exitCode: old.exitCode, calls: old.calls.map((argv) => argv.slice(0, 3).join(" ")) })
      .toEqual({ version, exitCode: 0, calls: ["gh auth status", "gh --version", expect.stringMatching(/^sh /)] });
  }
  // From 2.56, or when gh's version can't be read, a failed check is still a refusal.
  for (const version of ["gh version 2.56.0 (2024-09-09)\n", "gh version 3.0.0\n", "gh version DEV\n", ""]) {
    const refused = await signedUpdate(signedRelease("0.2.22", key), key, failsCheck, version);
    expect({ version, exitCode: refused.exitCode, last: refused.lines.at(-1) })
      .toEqual({ version, exitCode: 1, last: "The downloaded installer doesn't match a Casper build from GitHub, so it was not run. Nothing was changed." });
  }
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
  // Started by Windows (WMI), the helper gets none of Casper's settings: the installer's ones go as checked parameters.
  expect(arg("-BaseUrl")).toBe(`${DOWNLOAD}/v0.2.22`);
  // Nothing is downloaded again and the running program is untouched.
  expect(github.asked.filter((url) => url.endsWith("install.ps1"))).toHaveLength(1);
  expect(await readdir(dir)).toEqual(["casper.exe"]);
  // Said plainly: nothing to close, the helper finishes once this command ends.
  expect(lines.at(-1)).toBe("The update finishes in the background: Windows can't replace a running program, so a hidden helper installs 0.2.22 as soon as this command ends, in about 30 seconds. A Casper you already have open keeps 0.2.21 until you restart it.");
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

const GIT_ENV: Record<string, string> = (() => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !/^GIT_/i.test(name)) env[name] = value;
  // These cases exercise enabled updates, even on CI. Opt-out behavior has its own explicit env tests.
  return { ...env, CI: "0", CASPER_NO_UPDATE_CHECK: "0", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
})();

beforeEach(async () => {
  // Git for Windows cannot read os.devNull as a config file. Use real empty files on every OS.
  const root = await tempDir("casper-update-git-config-");
  const config = path.join(root, "empty.gitconfig");
  await writeFile(config, "");
  GIT_ENV.GIT_CONFIG_GLOBAL = config;
  GIT_ENV.GIT_CONFIG_SYSTEM = config;
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${os.devNull}`, ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function commitVersion(repo: string, version: string, lock?: string, message = `v${version}`) {
  await writeFile(path.join(repo, "package.json"), `${JSON.stringify({ name: "casper", version }, null, 2)}\n`);
  if (lock !== undefined) await writeFile(path.join(repo, "bun.lock"), lock);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

function configureFixtureGit(repo: string): void {
  git(repo, "config", "--local", "user.name", "Test");
  git(repo, "config", "--local", "user.email", "test@example.com");
  git(repo, "config", "--local", "core.autocrlf", "false");
}

async function checkoutPair() {
  const root = await tempDir("casper-update-git-");
  const upstream = path.join(root, "upstream");
  await mkdir(upstream);
  git(upstream, "init", "-q");
  configureFixtureGit(upstream);
  await commitVersion(upstream, "0.2.21", "lock-1");
  git(root, "clone", "-q", upstream, "checkout");
  const checkout = path.join(root, "checkout");
  configureFixtureGit(checkout);
  git(checkout, "branch", "--set-upstream-to=origin/main", "main");
  git(checkout, "remote", "set-head", "origin", "main");
  return { upstream, checkout };
}

test("checkout fixtures explicitly own main, local identity and origin/HEAD without ambient git config", async () => {
  const { upstream, checkout } = await checkoutPair();
  for (const repo of [upstream, checkout]) {
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(repo, "config", "--local", "user.name")).toBe("Test");
    expect(git(repo, "config", "--local", "user.email")).toBe("test@example.com");
  }
  expect(git(checkout, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).toBe("origin/main");
  expect(git(checkout, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")).toBe("origin/main");
  expect(updateChecksOff(GIT_ENV)).toBe(false);
});

// Production gitEnv intentionally removes GIT_CONFIG_* overrides. Reapply test isolation after that boundary.
const fixtureGitRunner: ProcessRunner = (argv, options) => defaultRunner(argv, {
  ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: GIT_ENV.GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM: "1" },
});

test.each(["global", "system"] as const)("fixture git uses an empty temporary %s config for setup and update subprocesses on every OS", async level => {
  const config = GIT_ENV[`GIT_CONFIG_${level.toUpperCase()}`]!;
  expect(config).toBeTypeOf("string");
  expect(temps).toContain(path.dirname(config));
  expect((await stat(config)).isFile()).toBe(true);
  expect(await readFile(config, "utf8")).toBe("");
  expect(git(path.dirname(config), "config", `--${level}`, "--list")).toBe("");
  // Even an explicit inherited override cannot escape the fixture after production strips GIT_CONFIG_*.
  const result = await fixtureGitRunner(["git", "config", `--${level}`, "--list"], {
    cwd: path.dirname(config), env: { ...gitEnv(GIT_ENV), [`GIT_CONFIG_${level.toUpperCase()}`]: path.join(path.dirname(config), "missing-config") },
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
});

/** Real git; `bun` is recorded, not run. */
function checkoutRunner() {
  const bunCalls: Array<{ argv: string[]; cwd?: string }> = [];
  const run: ProcessRunner = async (argv, options) => {
    if (argv[0] === "fake-bun") { bunCalls.push({ argv, ...(options.cwd ? { cwd: options.cwd } : {}) }); return { code: 0, stdout: "", stderr: "" }; }
    return fixtureGitRunner(argv, options);
  };
  return { run, bunCalls };
}

test("the update git runner ignores global excludes even after production gitEnv strips config overrides", async () => {
  const { checkout } = await checkoutPair();
  const home = await tempDir("casper-update-git-home-");
  const ignored = path.join(home, "ignored");
  await writeFile(ignored, "notes.txt\n");
  git(home, "config", "--file", path.join(home, ".gitconfig"), "core.excludesFile", ignored);
  await writeFile(path.join(checkout, "notes.txt"), "untracked work");
  const env = gitEnv({ ...GIT_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config") });
  expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
  const status = await fixtureGitRunner(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: checkout, env });
  expect(status.code).toBe(0);
  expect(status.stdout.trim()).toBe("?? notes.txt");
});

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

test("checkout: a checkout only ahead of a remote it cannot reach names the network, not its own commits", async () => {
  const { upstream, checkout } = await checkoutPair();
  await commitVersion(checkout, "0.2.21-local", undefined, "local work");
  git(checkout, "remote", "set-url", "origin", path.join(path.dirname(upstream), "missing"));
  const unreachable = await updateCheckout(checkout);
  expect(unreachable.exitCode).toBe(1);
  expect(unreachable.lines).toEqual([`Git could not pull into the Casper checkout at ${checkout} (is the network down?), so it was not updated.`]);
  git(checkout, "remote", "set-url", "origin", upstream);
  const reached = await updateCheckout(checkout);
  expect(reached.exitCode).toBe(0);
  expect(reached.lines).toEqual([`The Casper checkout at ${checkout} is already up to date (0.2.21-local).`]);
}, 60_000);

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
  const run: ProcessRunner = async (argv, options) => argv[0] === "fake-bun" ? { code: 1, stdout: "", stderr: "" } : fixtureGitRunner(argv, options);
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
  // The footer keeps a short note of it.
  expect(await updateFooterNote(options)).toBe("Casper 0.2.22 is out · casper update");
  // Within a day it does not ask again; after a day it does.
  now += CHECK_EVERY_MS - 1;
  await refreshUpdateCheck(options);
  expect(github.asked).toHaveLength(1);
  now += 1;
  await refreshUpdateCheck(options);
  expect(github.asked).toHaveLength(2);
  // Once updated, the same saved release is not newer.
  expect(await updateNotice({ ...options, currentVersion: "0.2.22" })).toBeUndefined();
  expect(await updateFooterNote({ ...options, currentVersion: "0.2.22" })).toBeUndefined();
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
  let now = 1_000_000;
  const options = { install: { kind: "checkout" as const, root: checkout }, currentVersion: "0.2.21", stateDir, run, env: GIT_ENV, now: () => now };
  await refreshUpdateCheck(options);
  expect(await updateNotice(options)).toBeUndefined();
  await commitVersion(upstream, "0.2.22");
  await commitVersion(upstream, "0.2.23");
  now += CHECK_EVERY_MS;
  await refreshUpdateCheck(options);
  expect(await updateNotice(options)).toBe("The Casper checkout is 2 changes behind. Run casper update to pull them.");
  expect(await updateFooterNote(options)).toBe("Casper update ready · casper update");
  git(checkout, "pull", "-q", "--ff-only");
  expect(await updateNotice(options)).toBeUndefined();
  expect(await updateFooterNote(options)).toBeUndefined();
});

test("notice: a checkout branch with no remote is quiet", async () => {
  const { checkout } = await checkoutPair();
  git(checkout, "checkout", "-q", "-b", "solo");
  const stateDir = await tempDir("casper-notice-");
  const { run } = checkoutRunner();
  await refreshUpdateCheck({ install: { kind: "checkout", root: checkout }, currentVersion: "0.2.21", stateDir, run, env: GIT_ENV });
  expect(await readdir(stateDir)).toEqual([]);
});

/** A session's app, as far as the new-version line and the footer note use it: the footer's update note is recorded. */
function noticeApp(home: string, fetch: Fetcher, clock: { now: number }, updates: "auto" | "notify" | "off" = "notify") {
  const notes: Array<string | undefined> = [];
  const lines: string[] = [];
  const drawn: string[] = [];
  const app = {
    updateCheck: { install: { kind: "binary" as const, executable: "/opt/casper/casper" }, currentVersion: "0.2.21", fetch, env: {}, now: () => clock.now },
    interactive: true, commandActive: false,
    sessionHomeDir: home, homeDir: () => home, updateCheckAbort: new AbortController(), updatedInSession: false, updateNote: undefined as string | undefined,
    projectContext: { info: { name: "project", root: home }, updates } as { info: { name: string; root: string }; updates?: "auto" | "notify" | "off" },
    output: { write: (text: string) => { lines.push(text); } },
    terminal: { rich: false, setTitle: () => { drawn.push("title"); }, setBadge: () => { drawn.push("badge"); }, setStatus: () => { drawn.push("status"); },
      setUpdate: (text?: string) => { notes.push(text); } },
  };
  return { app, notes, lines, drawn };
}

/** Each ask the fake GitHub gets, as a promise for the nth one. */
function countedGitHub(releases: FakeRelease[] | (() => Response)) {
  const github = fakeGitHub(releases);
  const waits: Array<() => void> = [];
  const asked = (n: number) => new Promise<void>((resolve) => { if (github.asked.length >= n) resolve(); else waits.push(() => { if (github.asked.length >= n) resolve(); }); });
  const fetch: Fetcher = async (url, init) => { const response = await github.fetch(url, init); for (const wait of waits) wait(); return response; };
  return { github, fetch, asked };
}

test("notice: a session puts the footer note up when its background check finds a newer release, and looks again while open", async () => {
  const { reportNewerCasper, updateTick } = await import("../src/app/wiring");
  const { updateFooter } = await import("../src/app/footer");
  const home = await tempDir("casper-notice-home-");
  const { github, fetch, asked } = countedGitHub([{ tag_name: "v0.2.22" }, { tag_name: "v0.2.21" }]);
  const clock = { now: 1_000_000 };
  const { app, notes, lines, drawn } = noticeApp(home, fetch, clock);
  const saved = { CI: process.env.CI, CASPER_NO_UPDATE_CHECK: process.env.CASPER_NO_UPDATE_CHECK, tick: updateTick.ms };
  delete process.env.CI; delete process.env.CASPER_NO_UPDATE_CHECK;
  updateTick.ms = 20;
  const settled = async () => { const count = notes.length; for (let i = 0; i < 200 && notes.length === count; i++) await new Promise((resolve) => setTimeout(resolve, 5)); };
  try {
    type App = Parameters<typeof reportNewerCasper>[0];
    // Nothing checked yet: no line and no note; the check runs in the background and the note comes up when it ends.
    await reportNewerCasper(app as unknown as App, app.projectContext as unknown as Parameters<typeof reportNewerCasper>[1]);
    expect(lines).toEqual([]);
    await asked(1);
    await settled();
    expect(notes.at(-1)).toBe("Casper 0.2.22 is out · casper update");
    // Only the note: the start never draws the status line, whose "idle" would say Casper reads keys before it does.
    expect(drawn).toEqual([]);
    // A later tick within the day reads the saved check and asks GitHub nothing; a day later it asks again.
    await settled();
    expect(github.asked).toHaveLength(1);
    clock.now += CHECK_EVERY_MS;
    await asked(2);
    // Turned off in /settings mid-session: the note goes and no tick asks GitHub any more.
    app.projectContext.updates = "off";
    updateFooter(app as unknown as App);
    expect(notes.at(-1)).toBeUndefined();
    clock.now += CHECK_EVERY_MS;
    await settled(); await settled();
    expect(github.asked).toHaveLength(2);
    // Back on, and /doctor installed the update in this session: restart, not update.
    delete app.projectContext.updates;
    app.updatedInSession = true;
    updateFooter(app as unknown as App);
    expect(notes.at(-1)).toBe("✔ Update installed · restart to use it");
    // Closing the session stops the ticks.
    app.updateCheckAbort.abort();
    const count = notes.length;
    clock.now += CHECK_EVERY_MS;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notes).toHaveLength(count);
    expect(github.asked).toHaveLength(2);
  } finally {
    app.updateCheckAbort.abort();
    updateTick.ms = saved.tick;
    for (const name of ["CI", "CASPER_NO_UPDATE_CHECK"] as const) if (saved[name] !== undefined) process.env[name] = saved[name];
  }
});

test("notice: a failed look is not tried again for a day, however often the session's tick runs", async () => {
  const { reportNewerCasper, updateTick } = await import("../src/app/wiring");
  const home = await tempDir("casper-notice-home-");
  const { github, fetch, asked } = countedGitHub(() => new Response("busy", { status: 503 }));
  const clock = { now: 1_000_000 };
  const { app, notes } = noticeApp(home, fetch, clock);
  const saved = { CI: process.env.CI, CASPER_NO_UPDATE_CHECK: process.env.CASPER_NO_UPDATE_CHECK, tick: updateTick.ms };
  delete process.env.CI; delete process.env.CASPER_NO_UPDATE_CHECK;
  updateTick.ms = 20;
  try {
    type App = Parameters<typeof reportNewerCasper>[0];
    await reportNewerCasper(app as unknown as App, app.projectContext as unknown as Parameters<typeof reportNewerCasper>[1]);
    await asked(1);
    // GitHub was busy: nothing is saved, and many ticks within the day ask nothing more.
    clock.now += CHECK_EVERY_MS - 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(github.asked).toHaveLength(1);
    expect(notes.filter(Boolean).every(note => note === "update failed · casper update")).toBe(true);
    // A day after the try, it asks once more.
    clock.now += 1;
    await asked(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(github.asked).toHaveLength(2);
  } finally {
    app.updateCheckAbort.abort();
    updateTick.ms = saved.tick;
    for (const name of ["CI", "CASPER_NO_UPDATE_CHECK"] as const) if (saved[name] !== undefined) process.env[name] = saved[name];
  }
});

test("notice: with updates: false a session says nothing, shows no note and asks GitHub nothing", async () => {
  const { reportNewerCasper } = await import("../src/app/wiring");
  const home = await tempDir("casper-notice-home-");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper", "update-check.json"), JSON.stringify({ checkedAt: 1, kind: "binary", version: "0.2.22" }));
  const { github, fetch } = countedGitHub([{ tag_name: "v0.2.23" }]);
  const { app, notes, lines } = noticeApp(home, fetch, { now: 1_000_000_000 }, "off");
  const saved = { CI: process.env.CI, CASPER_NO_UPDATE_CHECK: process.env.CASPER_NO_UPDATE_CHECK };
  delete process.env.CI; delete process.env.CASPER_NO_UPDATE_CHECK;
  try {
    type App = Parameters<typeof reportNewerCasper>[0];
    await reportNewerCasper(app as unknown as App, app.projectContext as unknown as Parameters<typeof reportNewerCasper>[1]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lines).toEqual([]);
    expect(notes.filter(Boolean)).toEqual([]);
    expect(github.asked).toEqual([]);
  } finally {
    app.updateCheckAbort.abort();
    for (const name of ["CI", "CASPER_NO_UPDATE_CHECK"] as const) if (saved[name] !== undefined) process.env[name] = saved[name];
  }
});

test("notice: CASPER_NO_UPDATE_CHECK or CI turns it off", () => {
  expect(updateChecksOff({})).toBe(false);
  expect(updateChecksOff({ CASPER_NO_UPDATE_CHECK: "1" })).toBe(true);
  expect(updateChecksOff({ CASPER_NO_UPDATE_CHECK: "0" })).toBe(false);
  expect(updateChecksOff({ CI: "true" })).toBe(true);
  expect(updateChecksOff({ CI: "false" })).toBe(false);
});

// --- The Windows handoff writes update.log, and a failed update is said plainly ---

test("windows: the handoff gets a log file in the state folder, started as pending, and a failed start leaves no log", async () => {
  const { executable } = await binaryInstall("casper.exe");
  const stateDir = await tempDir("casper-state-");
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22"));
  const handoff = fakeHandoff();
  const result = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: () => {}, fetch: github.fetch, run: recordingRunner().run, startDetached: handoff.start, pid: 4242, platform: "win32", stateDir });
  expect(result.exitCode).toBe(0);
  const argv = handoff.calls[0]!.argv;
  expect(argv[argv.indexOf("-LogFile") + 1]).toBe(path.join(stateDir, UPDATE_LOG));
  const log = await readFile(path.join(stateDir, UPDATE_LOG), "utf8");
  expect(log).toContain("target: 0.2.22");
  expect(log.trimEnd().split("\n").at(-1)).toBe("result: pending");
  await removeTempDir(argv[argv.indexOf("-Cleanup") + 1]!);
  // A helper that could not start leaves nothing behind that would later look like a failed update.
  const failed = await tempDir("casper-state-");
  const none = await runUpdate({ releaseKey: NO_KEY, check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: () => {}, fetch: github.fetch, run: recordingRunner().run, startDetached: fakeHandoff(false).start, platform: "win32", stateDir: failed });
  expect(none.exitCode).toBe(1);
  expect(await readdir(failed)).toEqual([]);
});

test("windows: every way out of the handoff script writes a result line first, and the steps are logged", () => {
  const lines = HANDOFF_SCRIPT.split("\n");
  lines.forEach((line, index) => {
    if (/^\s*exit\b/.test(line)) expect(lines[index - 1]).toContain("result: failed");
  });
  for (const step of ["helper started", "exited", "installer SHA-256 expected", "running the installer", "the installer finished", "installed program version", "result: ok", "error: "]) {
    expect(HANDOFF_SCRIPT).toContain(step);
  }
  // A thrown error is written down before the temp folder goes, not swallowed.
  expect(HANDOFF_SCRIPT).toMatch(/catch \{\s*Write-Step \('error: '/);
  expect(HANDOFF_SCRIPT).not.toMatch(/Invoke-Expression|iex\b|DownloadString|Invoke-WebRequest|irm\b/i);
});

test("update log: failed and never-finished updates are found; ok, still running and already-installed ones are not", async () => {
  const stateDir = await tempDir("casper-state-");
  const file = path.join(stateDir, UPDATE_LOG);
  const write = (...lines: string[]) => writeFile(file, `\uFEFF${lines.join("\r\n")}\r\n`);
  expect(await lastUpdateFailure(stateDir, "0.2.26")).toBeUndefined();
  await write("target: 0.2.27", "2026-10-08T12:00:00 helper started", "2026-10-08T12:00:09 result: failed: Casper did not exit in time, so nothing was changed");
  expect(await lastUpdateFailure(stateDir, "0.2.26")).toMatchObject({ version: "0.2.27", reason: "Casper did not exit in time, so nothing was changed" });
  expect(await lastUpdateFailure(stateDir, "0.2.27")).toBeUndefined();
  await write("target: 0.2.27", "result: pending", "2026-10-08T12:00:09 result: ok");
  expect(await lastUpdateFailure(stateDir, "0.2.26")).toBeUndefined();
  const fresh = (await import("node:fs")).statSync(file).mtimeMs;
  await write("target: 0.2.27", "result: pending");
  expect(await lastUpdateFailure(stateDir, "0.2.26", fresh + 60_000)).toBeUndefined();
  expect(await lastUpdateFailure(stateDir, "0.2.26", fresh + 60 * 60_000)).toMatchObject({ version: "0.2.27", reason: "the helper that installs it never finished" });
  await startUpdateLog(stateDir, "0.2.26", "0.2.27");
  expect(await readFile(file, "utf8")).toContain("result: pending");
});

test("update log: casper update, the session start line and casper doctor all say the last update failed, and name the log and the one-liner", async () => {
  const stateDir = await tempDir("casper-state-");
  await writeFile(path.join(stateDir, UPDATE_LOG), "target: 0.2.22\nresult: failed: the installer ran, but the program in the install folder says version '0.2.21' and not 0.2.22\n");
  const failure = (await lastUpdateFailure(stateDir, "0.2.21"))!;
  const said = updateFailureLines(failure).join("\n");
  expect(said).toContain("The last update to Casper 0.2.22 did not finish");
  expect(said).toContain(path.join(stateDir, UPDATE_LOG));
  expect(said).toContain(`irm ${DOWNLOAD}/v0.2.22/install.ps1 | iex`);
  // casper update
  const { executable } = await binaryInstall("casper.exe");
  const lines: string[] = [];
  await runUpdate({ releaseKey: NO_KEY, check: true, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22")).fetch, platform: "win32", stateDir });
  expect(lines.join("\n")).toContain("did not finish");
  // the line at the start of a session
  const line = await updateNotice({ install: { kind: "binary", executable }, currentVersion: "0.2.21", stateDir, env: {}, fetch: fakeGitHub([]).fetch });
  expect(line).toContain("did not finish");
  // once this Casper is the new version, nothing is said
  expect(await updateNotice({ install: { kind: "binary", executable }, currentVersion: "0.2.22", stateDir, env: {}, fetch: fakeGitHub([]).fetch })).toBeUndefined();
});

test("windows: an argument is quoted the way Windows programs read their command line; & and % stay literal", () => {
  expect(windowsArgument("plain")).toBe("plain");
  expect(windowsArgument("")).toBe('""');
  expect(windowsArgument("C:\\Users\\Jo Smith\\AppData")).toBe('"C:\\Users\\Jo Smith\\AppData"');
  expect(windowsArgument("a&b%PATH%")).toBe("a&b%PATH%");
  expect(windowsArgument('say "hi"')).toBe('"say \\"hi\\""');
  // Backslashes are doubled only before a quote, including the closing one.
  expect(windowsArgument("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
  expect(windowsArgument('a\\"b')).toBe('a\\\\\\"b'.replace(/^/, '"') + '"');
  expect(() => windowsArgument("two\nlines")).toThrow();
  expect(() => windowsArgument("nul\0")).toThrow();
});

test("windows: the helper is started by Windows' WMI service with the full PowerShell path and one quoted command line", () => {
  const script = wmiCreateScript(["powershell", "-File", "C:\\Users\\O'Neil\\handoff.ps1", "-InstallDir", "C:\\Program Files\\Casper"], "C:\\Windows");
  expect(script).toContain("Invoke-CimMethod -ClassName Win32_Process -MethodName Create");
  // The whole line is one PowerShell single-quoted literal: a quote in a path is doubled, so nothing in it runs.
  expect(script).toContain("CommandLine = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -File C:\\Users\\O''Neil\\handoff.ps1 -InstallDir \"C:\\Program Files\\Casper\"'");
  expect(script).toMatch(/started ' \+ \$r\.ProcessId\); exit 0/);
  expect(script).not.toMatch(/Invoke-Expression|iex\b|DownloadString|Invoke-WebRequest|irm\b/i);
  expect(() => wmiCreateScript(["powershell", "-File", "bad\nline"], "C:\\Windows")).toThrow();
});

test("windows: the helper sets the installer's settings only from checked parameters, never from its own environment", () => {
  for (const pattern of ["$BaseUrl = ''", "$BinarySha256 = ''", "$Arch = ''"]) expect(HANDOFF_SCRIPT).toContain(pattern);
  expect(HANDOFF_SCRIPT).toContain("ValidatePattern('^(https://github\\.com/Choaterboater/casper/releases/download/v[0-9A-Za-z.-]+)?$')");
  expect(HANDOFF_SCRIPT).toContain("foreach ($Name in @('CASPER_BASE_URL', 'CASPER_SHA256', 'CASPER_ARCH', 'CASPER_OS')) { Remove-Item");
  expect(HANDOFF_SCRIPT.indexOf("if ($BaseUrl) { $env:CASPER_BASE_URL = $BaseUrl }")).toBeLessThan(HANDOFF_SCRIPT.indexOf("& $Installer"));
});

async function until(predicate: () => boolean) {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}

const auto = { mode: "auto" as const, canInstall: () => true };

test("background binary uses the normal signed, hashed and provenance-checked installer quietly, once a day", async () => {
  const key = testReleaseKey();
  const { executable } = await binaryInstall();
  const stateDir = await tempDir("casper-auto-");
  const github = signedRelease("0.2.22", key);
  const calls: Array<{ argv: string[]; inherit?: boolean }> = [];
  const run: ProcessRunner = async (argv, options) => {
    calls.push({ argv, inherit: options.inherit });
    return { code: 0, stdout: argv[1] === "--version" ? "gh version 2.56.0" : "", stderr: "" };
  };
  const options = { install: { kind: "binary" as const, executable }, currentVersion: "0.2.21", stateDir, fetch: github.fetch, run,
    env: {}, platform: "linux" as const, arch: "x64", releaseKey: key.publicKey };
  expect(await backgroundUpdate(options, auto)).toBe(INSTALLED_NOTE);
  expect(calls.map(call => call.argv.slice(0, 3).join(" "))).toEqual(["gh auth status", "gh --version", "gh attestation verify", "gh attestation verify", expect.stringMatching(/^sh /)]);
  expect(calls.at(-1)!.inherit).toBe(false);
  expect(await readFile(executable, "utf8")).toBe("old"); // The fake runner did not replace the running program.
  expect(await backgroundUpdate(options, auto)).toBe(INSTALLED_NOTE);
  expect(calls.filter(call => call.argv[0] === "sh")).toHaveLength(1);
  expect(await updateFooterNote(options)).toBe(INSTALLED_NOTE);
});

test("background verification refuses missing/bad signatures, bad hashes and provenance; install failures log without terminal output", async () => {
  const key = testReleaseKey();
  for (const kind of ["signature", "hash", "provenance", "install", "lookup"] as const) {
    const { executable } = await binaryInstall();
    const stateDir = await tempDir("casper-auto-fail-");
    const github = kind === "lookup" ? fakeGitHub(() => new Response("busy", { status: 503 }))
      : signedRelease("0.2.22", key, kind === "signature" ? { signature: null } : kind === "hash" ? { script: installer("0.2.22") + "changed" } : {});
    const calls: string[][] = [];
    const run: ProcessRunner = async (argv) => {
      calls.push(argv);
      return { code: kind === "provenance" && argv[1] === "attestation" && !argv.includes("--help") || kind === "install" && argv[0] === "sh" ? 1 : 0,
        stdout: argv[1] === "--version" ? "gh version 2.56.0" : "", stderr: "" };
    };
    const options = { install: { kind: "binary" as const, executable }, currentVersion: "0.2.21", stateDir, fetch: github.fetch, run,
      env: {}, platform: "linux" as const, arch: "x64", releaseKey: key.publicKey };
    expect(await backgroundUpdate(options, auto)).toBe(FAILED_NOTE);
    expect(await updateFooterNote(options)).toBe(FAILED_NOTE);
    expect(await readFile(executable, "utf8")).toBe("old");
    expect(await readFile(path.join(stateDir, "update.log"), "utf8")).toContain("result: failed:");
    expect(calls.some(argv => argv[0] === "sh")).toBe(kind === "install");
    const looked = github.asked.length;
    await backgroundUpdate(options, auto);
    expect(github.asked).toHaveLength(looked);
  }
});

test("background notify, off, environment opt-outs and a busy caller never install", async () => {
  for (const mode of ["notify", "off", "busy", "ci", "env"] as const) {
    const stateDir = await tempDir("casper-auto-mode-");
    const github = fakeGitHub([{ tag_name: "v0.2.22" }]);
    const { run, calls } = recordingRunner();
    const options = { install: { kind: "binary" as const, executable: "/opt/casper/casper" }, currentVersion: "0.2.21", stateDir, fetch: github.fetch, run,
      env: mode === "ci" ? { CI: "1" } : mode === "env" ? { CASPER_NO_UPDATE_CHECK: "1" } : {} };
    const note = await backgroundUpdate(options, { mode: mode === "notify" || mode === "off" ? mode : "auto", canInstall: () => mode !== "busy" });
    expect(note).toBe(mode === "notify" || mode === "busy" ? "Casper 0.2.22 is out · casper update" : undefined);
    expect(calls).toEqual([]);
    expect(github.asked).toHaveLength(mode === "notify" || mode === "busy" ? 1 : 0);
  }
});

test("a failed extra probe cannot erase the shared daily installation-attempt guard", async () => {
  const key = testReleaseKey();
  const { executable } = await binaryInstall();
  const stateDir = await tempDir("casper-auto-attempt-");
  const bad = signedRelease("0.2.22", key, { signature: null });
  const good = signedRelease("0.2.22", key);
  let phase = 0, now = 1_000_000;
  const fetch: Fetcher = (url, init) => phase === 0 ? bad.fetch(url, init) : phase === 1 ? Promise.resolve(new Response("busy", { status: 503 })) : good.fetch(url, init);
  const { run, calls } = recordingRunner();
  const options = { install: { kind: "binary" as const, executable }, currentVersion: "0.2.21", stateDir, fetch, run, env: {},
    platform: "linux" as const, arch: "x64", releaseKey: key.publicKey, now: () => now };
  expect(await backgroundUpdate(options, auto)).toBe(FAILED_NOTE);
  const attemptedAt = JSON.parse(await readFile(path.join(stateDir, "update-check.json"), "utf8")).attemptedAt;
  phase = 1;
  expect(await backgroundUpdate(options, { ...auto, early: true })).toBe(FAILED_NOTE);
  expect(JSON.parse(await readFile(path.join(stateDir, "update-check.json"), "utf8")).attemptedAt).toBe(attemptedAt);
  phase = 2;
  await backgroundUpdate(options, { ...auto, early: true });
  expect(calls).toEqual([]);
  now += CHECK_EVERY_MS;
  expect(await backgroundUpdate(options, auto)).toBe(INSTALLED_NOTE);
  expect(await updateFooterNote(options)).toBe(INSTALLED_NOTE);
  expect((await readdir(stateDir)).includes("update.log")).toBe(false);
});

test("two sessions reclaiming a dead lock still run at most one updater", async () => {
  const stateDir = await tempDir("casper-auto-lock-");
  const lock = path.join(stateDir, "update.lock");
  await mkdir(lock);
  await writeFile(path.join(lock, "owner"), "0:dead");
  await utimes(lock, new Date(0), new Date(0));
  const { executable } = await binaryInstall();
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22"));
  const { run, calls } = recordingRunner();
  const options = { install: { kind: "binary" as const, executable }, currentVersion: "0.2.21", stateDir, fetch: github.fetch, run, env: {}, releaseKey: NO_KEY, platform: "linux" as const };
  const notes = await Promise.all([backgroundUpdate(options, auto), backgroundUpdate(options, auto)]);
  expect(notes).toContain(INSTALLED_NOTE);
  expect(calls.filter(call => call.argv[0] === "sh")).toHaveLength(1);
  expect((await readdir(stateDir)).filter(name => name.endsWith(".lock"))).toEqual([]);
});

test("background checkout fast-forwards only clean default branches and installs only changed lockfiles", async () => {
  for (const lockChanged of [false, true]) {
    const { upstream, checkout } = await checkoutPair();
    await commitVersion(upstream, "0.2.22", lockChanged ? "lock-2" : undefined);
    const { run, bunCalls } = checkoutRunner();
    const stateDir = await tempDir("casper-auto-source-");
    const options = { install: { kind: "checkout" as const, root: checkout }, currentVersion: "0.2.21", stateDir, run, bun: "fake-bun", env: GIT_ENV };
    expect(await backgroundUpdate(options, auto)).toBe(INSTALLED_NOTE);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
    expect(bunCalls).toEqual(lockChanged ? [{ argv: ["fake-bun", "install", "--frozen-lockfile"], cwd: checkout }] : []);
    expect(await updateFooterNote({ ...options, startedAt: Date.now() - 60_000 })).toBe(INSTALLED_NOTE);
    expect(await updateFooterNote({ ...options, startedAt: Date.now() + 1 })).toBeUndefined();
  }
});

test("a failed frozen install keeps its notice; manual retry finishes dependencies with or without another fast-forward", async () => {
  for (const advance of [false, true]) {
    const { upstream, checkout } = await checkoutPair();
    await commitVersion(upstream, "0.2.22", "lock-2");
    const stateDir = await tempDir("casper-auto-dependencies-");
    let fail = true, installs = 0;
    const run: ProcessRunner = (argv, options) => {
      if (argv[0] === "fake-bun") { installs++; return Promise.resolve({ code: fail ? 1 : 0, stdout: "", stderr: "" }); }
      return fixtureGitRunner(argv, options);
    };
    const options = { install: { kind: "checkout" as const, root: checkout }, currentVersion: "0.2.21", stateDir, run, bun: "fake-bun", env: GIT_ENV };
    expect(await backgroundUpdate(options, auto)).toBe(FAILED_NOTE);
    expect(await updateFooterNote(options)).toBe(FAILED_NOTE);
    expect(await readFile(path.join(stateDir, "update.log"), "utf8")).toContain("result: failed:");
    await refreshUpdateCheck(options, true);
    expect(await updateFooterNote(options)).toBe(FAILED_NOTE);
    // A later commit without a lockfile change must not strand the earlier failed install forever.
    if (advance) await commitVersion(upstream, "0.2.23");
    fail = false;
    expect((await runUpdate({ ...options, check: false, write() {} })).updated).toBe(true);
    expect(installs).toBe(2);
    expect(await updateFooterNote({ ...options, startedAt: Date.now() - 60_000 })).toBe(INSTALLED_NOTE);
    expect((await readdir(stateDir)).includes("update-dependencies.json")).toBe(false);
  }
});

test("background checkout accepts a known non-main default and defers when the default is unknown", async () => {
  for (const known of [false, true]) {
    const { upstream, checkout } = await checkoutPair();
    if (known) {
      git(upstream, "branch", "-m", "stable");
      git(checkout, "fetch");
      git(checkout, "switch", "-c", "stable", "--track", "origin/stable");
      git(checkout, "remote", "set-head", "origin", "stable");
    } else git(checkout, "remote", "set-head", "origin", "--delete");
    await commitVersion(upstream, "0.2.22");
    const before = git(checkout, "rev-parse", "HEAD");
    const { run } = checkoutRunner();
    const stateDir = await tempDir("casper-auto-default-");
    // Newer git may rediscover origin/HEAD during fetch; model an unknown default consistently on all git versions.
    const runner: ProcessRunner = (argv, options) => !known && argv.includes("refs/remotes/origin/HEAD")
      ? Promise.resolve({ code: 1, stdout: "", stderr: "" }) : run(argv, options);
    const note = await backgroundUpdate({ install: { kind: "checkout", root: checkout }, currentVersion: "0.2.21", stateDir, run: runner, bun: "fake-bun", env: GIT_ENV }, auto);
    expect(note).toBe(known ? INSTALLED_NOTE : "Casper update ready · casper update");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(known ? git(upstream, "rev-parse", "HEAD") : before);
  }
});

test("background checkout leaves tracked dirt, untracked files, other branches, detached heads and local commits untouched", async () => {
  for (const unsafe of ["tracked", "untracked", "branch", "detached", "diverged", "ahead"] as const) {
    const { upstream, checkout } = await checkoutPair();
    await commitVersion(upstream, "0.2.22");
    if (unsafe === "tracked") await writeFile(path.join(checkout, "bun.lock"), "work in progress");
    if (unsafe === "untracked") await writeFile(path.join(checkout, "notes.txt"), "work in progress");
    if (unsafe === "branch") { git(checkout, "switch", "-c", "work"); git(checkout, "branch", "--set-upstream-to=origin/main"); }
    if (unsafe === "detached") { git(checkout, "switch", "--detach"); }
    if (unsafe === "diverged") await commitVersion(checkout, "0.2.21-local");
    if (unsafe === "ahead") { git(checkout, "pull", "--ff-only"); await commitVersion(checkout, "0.2.23-local"); }
    const before = git(checkout, "rev-parse", "HEAD"), status = git(checkout, "status", "--porcelain", "--untracked-files=all");
    const { run, bunCalls } = checkoutRunner();
    const stateDir = await tempDir("casper-auto-unsafe-");
    const note = await backgroundUpdate({ install: { kind: "checkout", root: checkout }, currentVersion: "0.2.21", stateDir, run, bun: "fake-bun", env: GIT_ENV }, auto);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before);
    expect(git(checkout, "status", "--porcelain", "--untracked-files=all")).toBe(status);
    expect(bunCalls).toEqual([]);
    expect(note).toBe(unsafe === "ahead" || unsafe === "detached" ? undefined : "Casper update ready · casper update");
  }
});

test("session probes once after a few minutes, defers during tasks/checks, respects daily cache and prints plain news once", async () => {
  const { reportNewerCasper, updateTick } = await import("../src/app/wiring");
  const saved = { CI: process.env.CI, CASPER_NO_UPDATE_CHECK: process.env.CASPER_NO_UPDATE_CHECK, ...updateTick };
  delete process.env.CI; delete process.env.CASPER_NO_UPDATE_CHECK;
  updateTick.ms = 10; updateTick.earlyMs = 50;
  const home = await tempDir("casper-auto-timer-");
  let version = "0.2.21";
  const github = countedGitHub(() => Response.json([{ draft: false, tag_name: `v${version}` }]));
  const { app, notes, lines } = noticeApp(home, github.fetch, { now: 1_000_000 });
  const host = app as unknown as Parameters<typeof reportNewerCasper>[0];
  try {
    app.commandActive = true;
    await reportNewerCasper(host, host.projectContext!);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(github.github.asked).toHaveLength(0);
    app.commandActive = false;
    host.verificationWork = Promise.resolve({} as never);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(github.github.asked).toHaveLength(0);
    host.verificationWork = undefined;
    // The postponed early check is still only one probe.
    await until(() => github.github.asked.length === 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(github.github.asked).toHaveLength(1);
    expect(lines).toEqual([]);
    // A fresh session's extra early probe sees a release published after its startup lookup.
    app.updateCheckAbort.abort();
    const second = noticeApp(home, github.fetch, { now: 1_000_001 });
    const next = second.app as unknown as Parameters<typeof reportNewerCasper>[0];
    try {
      await reportNewerCasper(next, next.projectContext!);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(github.github.asked).toHaveLength(1);
      version = "0.2.22";
      await until(() => second.notes.includes("Casper 0.2.22 is out · casper update"));
      expect(github.github.asked).toHaveLength(2);
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(github.github.asked).toHaveLength(2);
      expect(second.lines).toEqual(["[update] Casper 0.2.22 is out · casper update\n"]);
    } finally { next.updateCheckAbort.abort(); await next.updateWork; }
    expect(notes.filter(Boolean)).toEqual([]);
  } finally {
    app.updateCheckAbort.abort(); await host.updateWork;
    updateTick.ms = saved.ms; updateTick.earlyMs = saved.earlyMs;
    for (const name of ["CI", "CASPER_NO_UPDATE_CHECK"] as const) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
});

test("one-shot and JSON reporters only print saved news once and never check or install", async () => {
  const { reportNewerCasper } = await import("../src/app/wiring");
  const saved = { CI: process.env.CI, CASPER_NO_UPDATE_CHECK: process.env.CASPER_NO_UPDATE_CHECK };
  delete process.env.CI; delete process.env.CASPER_NO_UPDATE_CHECK;
  try {
    for (const json of [false, true]) {
      const home = await tempDir("casper-auto-once-");
      await mkdir(path.join(home, ".casper"));
      await writeFile(path.join(home, ".casper", "update-check.json"), JSON.stringify({ checkedAt: 1, kind: "binary", version: "0.2.22" }));
      const github = countedGitHub([{ tag_name: "v0.2.23" }]);
      const { app, lines } = noticeApp(home, github.fetch, { now: CHECK_EVERY_MS * 2 }, "auto");
      const host = app as unknown as Parameters<typeof reportNewerCasper>[0];
      host.interactive = json;
      if (json) Object.assign(host, { onEvent: () => {} });
      await reportNewerCasper(host, host.projectContext!);
      expect(host.updateWork).toBeUndefined();
      expect(github.github.asked).toHaveLength(0);
      expect(lines).toEqual(["[update] Casper 0.2.22 is out · casper update\n"]);
      host.updateCheckAbort.abort();
    }
  } finally {
    for (const name of ["CI", "CASPER_NO_UPDATE_CHECK"] as const) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
});

test("background Windows handoff waits for a long session to exit, logs pending and keeps the old executable", async () => {
  const { executable } = await binaryInstall("casper.exe");
  const stateDir = await tempDir("casper-auto-windows-");
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22"));
  const handoff = fakeHandoff();
  const options = { install: { kind: "binary" as const, executable }, currentVersion: "0.2.21", stateDir, fetch: github.fetch,
    run: recordingRunner().run, startDetached: handoff.start, platform: "win32" as const, releaseKey: NO_KEY, env: {}, pid: process.pid };
  expect(await backgroundUpdate(options, auto)).toBe(INSTALLED_NOTE);
  const argv = handoff.calls[0]!.argv;
  expect(argv.slice(argv.indexOf("-WaitSeconds"), argv.indexOf("-WaitSeconds") + 2)).toEqual(["-WaitSeconds", "0"]);
  expect(HANDOFF_SCRIPT).toContain("if ($WaitSeconds -eq 0) { $casper.WaitForExit() }");
  expect(await readFile(executable, "utf8")).toBe("old");
  expect(await lastUpdateFailure(stateDir, "0.2.21", Date.now() + CHECK_EVERY_MS)).toBeUndefined();
  expect(await readFile(path.join(stateDir, "update.log"), "utf8")).toContain(`waiting-for-exit: ${process.pid}`);
});
