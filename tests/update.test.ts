import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { compareVersions, defaultRunner, gitEnv, newestRelease, runUpdate, type Fetcher, type ProcessRunner } from "../src/update/command";
import { runningFromBinary } from "../src/update/mode";
import { CHECK_EVERY_MS, refreshUpdateCheck, updateChecksOff, updateNotice } from "../src/update/notice";

setDefaultTimeout(30_000);

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const DOWNLOAD = "https://github.com/Choaterboater/casper/releases/download";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const installer = (version: string) => `#!/bin/sh\nBASE_URL="\${CASPER_BASE_URL:-${DOWNLOAD}/v${version}}"\necho fake installer\n`;

interface FakeRelease { tag_name: string; draft?: boolean; prerelease?: boolean; assets?: Array<{ name: string; digest?: string }> }

/** GitHub's release list, plus each release's files, served from memory. */
function fakeGitHub(releases: FakeRelease[] | (() => Response), files: Record<string, string> = {}) {
  const asked: string[] = [];
  const fetch: Fetcher = async (url) => {
    asked.push(url);
    if (url.startsWith("https://api.github.com/")) {
      return typeof releases === "function" ? releases() : Response.json(releases.map((release) => ({ draft: false, prerelease: true, assets: [], ...release })));
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
  const result = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "darwin" });
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
  const result = await runUpdate({ check: true, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "linux" });
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
  const result = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "darwin",
    env: { PATH: "/usr/bin", CASPER_SHA256: "f".repeat(64), CASPER_OS: "windows", CASPER_INSTALL_DIR: "/elsewhere" } });
  expect(result.exitCode).toBe(0);
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.argv[0]).toBe("sh");
  expect(call.argv.slice(2)).toEqual(["--dir", await realDir(dir), "--version", "0.2.22"]);
  expect(call.script).toBe(script);
  expect(call.inherit).toBe(true);
  expect(call.env.CASPER_BASE_URL).toBe(`${DOWNLOAD}/v0.2.22`);
  // The user's own overrides cannot change the hash, the platform or the folder.
  expect(call.env.CASPER_SHA256).toBeUndefined();
  expect(call.env.CASPER_OS).toBeUndefined();
  expect(call.env.CASPER_INSTALL_DIR).toBeUndefined();
  expect(lines).toEqual(["Updating Casper from 0.2.21 to 0.2.22.", "Casper is now 0.2.22."]);
  // The downloaded installer is gone afterwards.
  await expect(readFile(call.argv[1]!, "utf8")).rejects.toThrow();
});

test("binary: an installer that does not match its published digest is never run", async () => {
  const { executable } = await binaryInstall();
  const github = fakeGitHub([{ tag_name: "v0.2.22", assets: [{ name: "install.sh", digest: `sha256:${"a".repeat(64)}` }] }], releaseFiles("0.2.22"));
  const { run, calls } = recordingRunner();
  const lines: string[] = [];
  const result = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "linux" });
  expect(result.exitCode).toBe(1);
  expect(calls).toEqual([]);
  expect(lines.at(-1)).toBe("The downloaded installer did not match the release's checksum, so it was not run. Nothing was changed.");
});

test("binary: an installer that points at another release is never run", async () => {
  const { executable } = await binaryInstall();
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22", installer("0.2.20")));
  const { run, calls } = recordingRunner();
  const lines: string[] = [];
  const result = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "linux" });
  expect(result.exitCode).toBe(1);
  expect(calls).toEqual([]);
  expect(lines.at(-1)).toBe("The downloaded installer is for a different release than 0.2.22, so it was not run. Nothing was changed.");
});

test("binary: a failed installer leaves the old program and says so", async () => {
  const { executable } = await binaryInstall();
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22"));
  const { run } = recordingRunner(() => 1);
  const lines: string[] = [];
  const result = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "linux" });
  expect(result.exitCode).toBe(1);
  expect(lines.at(-1)).toBe("The installer stopped before it finished; Casper 0.2.21 is still installed.");
  expect(await readFile(executable, "utf8")).toBe("old");
});

test("binary: a program not named casper is not replaced by an installer that writes casper", async () => {
  const { executable } = await binaryInstall("casper-darwin-arm64");
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22"));
  const { run, calls } = recordingRunner();
  const lines: string[] = [];
  const result = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "darwin" });
  expect(result.exitCode).toBe(1);
  expect(calls).toEqual([]);
  expect(lines.at(-1)).toContain("is named casper-darwin-arm64");
});

test("windows: the running casper.exe moves aside, the installer runs with its settings, and the old copy goes next time", async () => {
  const { dir, executable } = await binaryInstall("casper.exe");
  await writeFile(path.join(dir, "casper.old.exe"), "older");
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22"));
  let presentDuringInstall: string[] = [];
  const { run, calls } = recordingRunner(() => 0);
  const wrapped: ProcessRunner = async (argv, options) => {
    presentDuringInstall = (await readdir(dir)).sort();
    await writeFile(path.join(dir, "casper.exe"), "new");
    return run(argv, options);
  };
  const lines: string[] = [];
  const result = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run: wrapped, platform: "win32", env: { CASPER_SHA256: "x" } });
  expect(result.exitCode).toBe(0);
  const call = calls[0]!;
  expect(call.argv.slice(0, 5)).toEqual(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
  expect(call.argv[5]).toEndWith("install.ps1");
  expect(call.env).toMatchObject({ CASPER_INSTALL_DIR: await realDir(dir), CASPER_VERSION: "0.2.22", CASPER_BASE_URL: `${DOWNLOAD}/v0.2.22` });
  expect(call.env.CASPER_SHA256).toBeUndefined();
  // The leftover from last time is gone and the running program was out of the way while the installer ran.
  expect(presentDuringInstall).toEqual(["casper.old.exe"]);
  expect(await readFile(path.join(dir, "casper.exe"), "utf8")).toBe("new");
  expect(await readFile(path.join(dir, "casper.old.exe"), "utf8")).toBe("old");
});

test("windows: when the installer fails, the running casper.exe is put back", async () => {
  const { dir, executable } = await binaryInstall("casper.exe");
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22"));
  const { run } = recordingRunner(() => 1);
  const lines: string[] = [];
  const result = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "win32" });
  expect(result.exitCode).toBe(1);
  expect((await readdir(dir)).sort()).toEqual(["casper.exe"]);
  expect(await readFile(executable, "utf8")).toBe("old");
});

test("windows: Ctrl-C while the installer runs stops it and puts the running casper.exe back", async () => {
  const { dir, executable } = await binaryInstall("casper.exe");
  const github = fakeGitHub([{ tag_name: "v0.2.22" }], releaseFiles("0.2.22"));
  const controller = new AbortController();
  let tempScript = "";
  // Like a real child: it ends only once it is told to stop.
  const run: ProcessRunner = (argv, options) => new Promise((resolve) => {
    tempScript = argv.at(-1)!;
    options.signal?.addEventListener("abort", () => setTimeout(() => resolve({ code: 1, stdout: "", stderr: "" }), 20), { once: true });
    setTimeout(() => controller.abort(), 10);
  });
  const lines: string[] = [];
  const result = await runUpdate({ check: false, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: github.fetch, run, platform: "win32", signal: controller.signal });
  expect(result.exitCode).toBe(1);
  expect((await readdir(dir)).sort()).toEqual(["casper.exe"]);
  expect(await readFile(executable, "utf8")).toBe("old");
  expect(await readdir(path.dirname(tempScript)).catch(() => "gone")).toBe("gone");
});

test("a GitHub token in GITHUB_TOKEN or GH_TOKEN goes only to the release lookup, and a rejected one is named", async () => {
  const { executable } = await binaryInstall();
  for (const [env, name] of [[{ GITHUB_TOKEN: "t1" }, "GITHUB_TOKEN"], [{ GH_TOKEN: "t2" }, "GH_TOKEN"]] as const) {
    const seen: Array<string | undefined> = [];
    const fetch: Fetcher = async (_url, init) => { seen.push(init?.headers?.Authorization); return new Response("{}", { status: 401 }); };
    const lines: string[] = [];
    const result = await runUpdate({ check: true, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch, run: recordingRunner().run, platform: "linux", env });
    expect(result.exitCode).toBe(1);
    expect(seen).toEqual([`Bearer ${env[name as keyof typeof env]}`]);
    expect(lines).toEqual([`GitHub did not accept the token in ${name}. Nothing was changed.`]);
  }
  const limited: Fetcher = async () => new Response("{}", { status: 403 });
  const lines: string[] = [];
  await runUpdate({ check: true, install: { kind: "binary", executable }, currentVersion: "0.2.21", write: (line) => lines.push(line), fetch: limited, run: recordingRunner().run, platform: "linux", env: { GH_TOKEN: "t" } });
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
});

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
  const result = await runUpdate({ check: false, install: { kind: "checkout", root: checkout }, currentVersion: "0.2.21", write: (line) => lines.push(line), run, bun: "fake-bun", env });
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
  const result = await runUpdate({ check: false, install: { kind: "checkout", root: checkout }, currentVersion: "0.2.21", write: (line) => lines.push(line), run, bun: "fake-bun", env: GIT_ENV });
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
  const result = await runUpdate({ check: false, install: { kind: "checkout", root: folder }, currentVersion: "0.2.21", write: (line) => noGit.push(line), run: missing });
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
