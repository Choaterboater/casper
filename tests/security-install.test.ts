import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findTool, installedVersion, installLockedSpec, pythonFailure, installQuestion, installTool, lockedEntryPath, numberedChoices, ownCopyLine, UV_MISSING } from "../src/security/install";
import { SecurityCheck } from "../src/security/run";
import type { ToolRunner } from "../src/security/spawn";
import { hostPlatform, pinnedToolDir, pinnedToolPath, SECURITY_TOOLS, type LockedSpec, type SecurityToolSpec } from "../src/security/tools";
import { fakeProgram, fakeTools, fixtureRepo, run, SEMGREP_NOT_ON_WINDOWS, SEMGREP_RUNS } from "./fixtures/security-tools/setup";
import { removeTempDir } from "./support/temp-dir";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await removeTempDir(dir); });
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

test("every pinned download has a sha256 and every Python lock line has a hash", () => {
  for (const spec of Object.values(SECURITY_TOOLS)) {
    if (spec.source.kind === "binary") {
      const assets = Object.values(spec.source.assets);
      expect(assets.length).toBeGreaterThanOrEqual(5);
      for (const asset of assets) {
        expect(asset!.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(asset!.url).toStartWith("https://github.com/");
        expect(asset!.url).toContain(spec.version);
      }
    } else {
      const requirements = spec.source.lock.split("\n").filter((line) => line && !line.startsWith("#") && !line.startsWith(" "));
      expect(requirements.length).toBeGreaterThan(0);
      expect(spec.source.lock).toContain(`${spec.source.package}==${spec.version}`);
      for (const requirement of requirements) expect(requirement).toMatch(/^[A-Za-z0-9._-]+(\[[^\]]*\])?==\S+( ; .*)? \\$/);
      // Each requirement is followed by at least one --hash line.
      const blocks = spec.source.lock.split(/\n(?=[A-Za-z0-9])/).filter((block) => !block.startsWith("#"));
      for (const block of blocks) expect(block).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    }
  }
  expect(SECURITY_TOOLS["mcp-scanner"].optIn).toBe(true);
});

function fakeBinarySpec(bytes: Uint8Array, archive: "raw" | "tar.gz", pinned = sha(bytes)): SecurityToolSpec {
  const key = hostPlatform()!;
  return { ...SECURITY_TOOLS.gitleaks, source: { kind: "binary", assets: { [key]: { url: "https://github.com/example/tool/v8.30.1/tool.tar.gz", sha256: pinned, archive, member: archive === "raw" ? "gitleaks" : "gitleaks" } } } };
}

test("a download that does not match the pinned checksum installs nothing", async () => {
  const home = await temp("casper-security-install-");
  const bytes = new TextEncoder().encode("#!/bin/sh\necho evil\n");
  const spec = fakeBinarySpec(bytes, "raw", "0".repeat(64));
  const result = await installTool(spec, { homeDir: home, fetchBytes: async () => bytes });
  expect(result).toEqual({ id: "gitleaks", ok: false, message: "gitleaks download didn't match the pinned checksum. Nothing was installed." });
  expect(await readdir(path.join(home, ".casper")).catch(() => [])).toEqual([]);
  expect((await findTool(spec, { homeDir: home, env: { PATH: "" } })).kind).toBe("missing");
});

test("a matching tar.gz download is unpacked into ~/.casper/tools/<id>-<version> and found as Casper's pinned copy", async () => {
  const home = await temp("casper-security-install-");
  const build = await temp("casper-security-build-");
  await writeFile(path.join(build, "gitleaks"), "#!/bin/sh\necho 8.30.1\n");
  await writeFile(path.join(build, "README.md"), "readme\n");
  run(build, "tar", ["-czf", "tool.tar.gz", "gitleaks", "README.md"]);
  const bytes = new Uint8Array(await readFile(path.join(build, "tool.tar.gz")));
  const spec = fakeBinarySpec(bytes, "tar.gz");
  const fetched: string[] = [];
  const result = await installTool(spec, { homeDir: home, fetchBytes: async (url) => { fetched.push(url); return bytes; } });
  expect(result).toMatchObject({ ok: true, message: "gitleaks 8.30.1 installed" });
  expect(fetched).toHaveLength(1);
  expect(await readdir(pinnedToolDir(home, spec))).toEqual([".casper-installed.json", "bin"]);
  expect(await findTool(spec, { homeDir: home, env: { PATH: "" } })).toEqual({ kind: "pinned", path: pinnedToolPath(home, spec), version: "8.30.1" });
  // Only the pinned file counts: a copy whose marker names another checksum is not Casper's.
  const other = fakeBinarySpec(bytes, "tar.gz", "f".repeat(64));
  expect((await findTool(other, { homeDir: home, env: { PATH: "" } })).kind).toBe("missing");
});

// Git Bash puts Git's GNU tar first on PATH. It reads "C:\…" as a remote host and can't open a zip (the Windows
// downloads are zips), so on Windows Casper unpacks with Windows' own tar.exe.
test.if(process.platform === "win32")("on Windows a GNU tar first on PATH doesn't stop the unpack", async () => {
  const home = await temp("casper-security-install-");
  const build = await temp("casper-security-build-");
  const gnu = await temp("casper-security-gnu-tar-");
  await fakeProgram(gnu, "tar", [process.execPath, "-e", "process.stderr.write('tar (child): Cannot connect to C: resolve failed\\n'); process.exit(2)"]);
  await writeFile(path.join(build, "gitleaks.exe"), "not really a program\n");
  const windowsTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  run(build, windowsTar, ["-a", "-cf", "tool.zip", "gitleaks.exe"]);
  const bytes = new Uint8Array(await readFile(path.join(build, "tool.zip")));
  const spec: SecurityToolSpec = { ...SECURITY_TOOLS.gitleaks, source: { kind: "binary", assets: { [hostPlatform()!]: { url: "https://github.com/example/tool/v8.30.1/tool.zip", sha256: sha(bytes), archive: "zip", member: "gitleaks.exe" } } } };
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"));
  env.PATH = [gnu, process.env.PATH ?? process.env.Path ?? ""].join(path.delimiter);
  const result = await installTool(spec, { homeDir: home, env, fetchBytes: async () => bytes });
  expect(result).toMatchObject({ ok: true, message: "gitleaks 8.30.1 installed" });
  expect(await readFile(pinnedToolPath(home, spec), "utf8")).toBe("not really a program\n");
});

test("Python tools need uv; without it the install says so and leaves nothing behind", async () => {
  const home = await temp("casper-security-install-");
  const result = await installTool(SECURITY_TOOLS.ruff, { homeDir: home, env: { PATH: "/nonexistent" } });
  expect(result).toEqual({ id: "ruff", ok: false, message: UV_MISSING });
  expect(await readdir(path.join(home, ".casper", "tools")).catch(() => [])).toEqual([]);
});

test("a hash-locked install runs uv with --require-hashes and no source builds", async () => {
  const home = await temp("casper-security-install-");
  const bin = await temp("casper-security-uv-");
  await fakeUv(bin);
  const calls: string[][] = [];
  const result = await installTool(SECURITY_TOOLS.ruff, {
    homeDir: home, env: { PATH: bin, MIST_APITOKEN: "abc123" },
    run: async (options) => {
      calls.push([...options.args]);
      expect(options.env.MIST_APITOKEN).toBeUndefined();
      if (options.args[0] === "pip") {
        const entry = pinnedToolPath(home, SECURITY_TOOLS.ruff);
        await mkdir(path.dirname(entry), { recursive: true });
        await writeFile(entry, "");
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    },
  });
  expect(result.ok).toBe(true);
  expect(calls[0]!.slice(0, 1)).toEqual(["venv"]);
  expect(calls[1]).toEqual(expect.arrayContaining(["pip", "install", "--require-hashes", "--no-deps", "--only-binary", ":all:"]));
  // A version published minutes ago is found even when uv cached the package list before it.
  expect(calls[1]).toContain("--refresh");
  expect((await findTool(SECURITY_TOOLS.ruff, { homeDir: home, env: { PATH: "" } })).kind).toBe("pinned");
});

test("your own copy on PATH is used and shown with its version next to Casper's pin", async () => {
  const home = await temp("casper-security-install-");
  const bin = await temp("casper-security-path-");
  const own = await fakeProgram(bin, "gitleaks", [process.execPath, "-e", "console.log('8.18.0')"]);
  const location = await findTool(SECURITY_TOOLS.gitleaks, { homeDir: home, env: { PATH: bin } });
  expect(location).toEqual({ kind: "path", path: own, version: "8.18.0" });
  expect(ownCopyLine(SECURITY_TOOLS.gitleaks, location)).toBe("gitleaks: using your 8.18.0 (Casper pins 8.30.1)");
});

test("the install question is numbered and names the tools, the size and the hosts", () => {
  const question = installQuestion([SECURITY_TOOLS.gitleaks, SECURITY_TOOLS.semgrep, SECURITY_TOOLS.zizmor, SECURITY_TOOLS["osv-scanner"]]);
  expect(question.text).toBe("Security checks need 4 tools that aren't installed: gitleaks, semgrep, zizmor, osv-scanner (about 400 MB from github.com and pypi.org).");
  expect(numberedChoices(question.choices)).toBe("1 Stop · 2 Run what's installed · 3 Install them");
});

test("a check with tools missing reports them and downloads nothing ('2 Run what's installed')", async () => {
  const root = await fixtureRepo("casper-security-missing-");
  temps.push(root);
  const home = await temp("casper-security-install-");
  const tools = await fakeTools(home, { gitleaks: "clean", semgrep: "missing", zizmor: "missing", "osv-scanner": "missing", "ansible-lint": "missing" });
  const report = await new SecurityCheck({ root, homeDir: home, find: tools.find }).run();
  expect(report.missing).toEqual([...SEMGREP_RUNS ? ["semgrep" as const] : [], "zizmor", "osv-scanner", "ansible-lint"]);
  expect(report.tools.find((tool) => tool.id === "semgrep")).toMatchObject({ status: "not-run", text: SEMGREP_RUNS ? "not installed" : SEMGREP_NOT_ON_WINDOWS });
  expect(await readdir(path.join(home, ".casper")).then((names) => names.sort())).toEqual(["security"]);
});

// ---------------------------------------------------------------------------------------------------------
// One locked installer for tools and MCP servers

const exists = (file: string) => stat(file).then(() => true, () => false);

/** A uv that is only found on PATH, never run (the tests pass their own runner). Windows finds programs by extension. */
async function fakeUv(bin: string): Promise<void> {
  const uv = path.join(bin, process.platform === "win32" ? "uv.exe" : "uv");
  await writeFile(uv, "#!/bin/sh\nexit 0\n");
  await chmod(uv, 0o755);
}

async function fakeUvDir(): Promise<string> {
  const bin = await temp("casper-locked-uv-");
  await fakeUv(bin);
  return bin;
}

function lockedSpec(version: string): LockedSpec {
  return {
    id: "casper-network-mcp", label: "casper-network-mcp", version,
    source: { kind: "uv-lock", package: "casper-network-mcp", lock: `casper-network-mcp==${version} --hash=sha256:00\n`,
      lockName: "casper-network-mcp.lock.txt", python: ">=3.12", entry: "casper-network-mcp" },
    approxMB: 40, hosts: ["pypi.org", "files.pythonhosted.org"],
  };
}

test("a hash-locked install uses uv's cache in ~/.casper, never the shared one shell commands may write", async () => {
  const home = await temp("casper-locked-home-");
  const envs: Array<string | undefined> = [];
  const calls: string[][] = [];
  const record = fakeRun(calls);
  const result = await installLockedSpec(lockedSpec("0.1.0"), { homeDir: home, env: { PATH: await fakeUvDir(), UV_CACHE_DIR: path.join(home, ".cache/uv") },
    run: async (run) => { envs.push(run.env.UV_CACHE_DIR); return record(run); } });
  expect(result.ok).toBe(true);
  expect(envs).toEqual([path.join(home, ".casper", "uv-cache"), path.join(home, ".casper", "uv-cache")]);
});

/** uv as a fake: `pip install` writes the entry next to the venv's python (wherever the venv is being built), or exits 1. */
function fakeRun(calls: string[][], options: { pipExit?: number } = {}): ToolRunner {
  return async (run) => {
    calls.push([...run.args]);
    if (run.args[0] === "pip") {
      if (options.pipExit) return { exitCode: options.pipExit, signal: null, stdout: "", stderr: "" };
      const python = run.args[run.args.indexOf("--python") + 1]!;
      await mkdir(path.dirname(python), { recursive: true });
      await writeFile(path.join(path.dirname(python), process.platform === "win32" ? "casper-network-mcp.exe" : "casper-network-mcp"), "#!/bin/sh\n");
    }
    return { exitCode: 0, signal: null, stdout: "", stderr: "" };
  };
}

test("a non-security locked spec installs into ~/.casper/tools/<id>/venv with the marker written last", async () => {
  const home = await temp("casper-locked-home-");
  const calls: string[][] = [];
  const spec = lockedSpec("0.1.0");
  const result = await installLockedSpec(spec, { homeDir: home, env: { PATH: await fakeUvDir() }, run: fakeRun(calls) });
  expect(result.ok).toBe(true);
  expect(result.entryPath).toBe(lockedEntryPath(home, spec));
  expect(lockedEntryPath(home, spec, "darwin")).toBe(path.join(home, ".casper", "tools", "casper-network-mcp", "venv", "bin", "casper-network-mcp"));
  expect(calls.some((args) => args.includes("--require-hashes") && args.includes("--no-deps"))).toBe(true);
  // Built elsewhere and moved into place, so the venv must not hold absolute paths to where it was built.
  expect(calls[0]).toEqual(expect.arrayContaining(["venv", "--relocatable"]));
  expect(await exists(path.join(home, ".casper/tools/casper-network-mcp/.casper-installed.json"))).toBe(true);
  expect(await exists(lockedEntryPath(home, spec))).toBe(true);
  expect(await installedVersion(home, spec)).toBe("0.1.0");
  expect((await readdir(path.join(home, ".casper", "tools"))).sort()).toEqual(["casper-network-mcp"]);
});

test("a failed locked install leaves nothing behind", async () => {
  const home = await temp("casper-locked-home-");
  const spec = lockedSpec("0.1.0");
  const result = await installLockedSpec(spec, { homeDir: home, env: { PATH: await fakeUvDir() }, run: fakeRun([], { pipExit: 1 }) });
  expect(result.ok).toBe(false);
  expect(result.message).toBe("casper-network-mcp: the install failed.");
  expect(await exists(path.join(home, ".casper", "tools", "casper-network-mcp"))).toBe(false);
  expect(await readdir(path.join(home, ".casper", "tools")).catch(() => [])).toEqual([]);
  expect(await installedVersion(home, spec)).toBeUndefined();
});

test("a locked install without uv says so in the caller's words and installs nothing", async () => {
  const home = await temp("casper-locked-home-");
  const result = await installLockedSpec(lockedSpec("0.1.0"), { homeDir: home, env: { PATH: "/nonexistent" }, uvMissing: "Needs uv." });
  expect(result).toEqual({ ok: false, message: "Needs uv." });
  expect(await readdir(path.join(home, ".casper", "tools")).catch(() => [])).toEqual([]);
});

test("a newer version replaces the folder in place; the entry path does not change", async () => {
  const home = await temp("casper-locked-home-");
  const uv = await fakeUvDir();
  const first = await installLockedSpec(lockedSpec("0.1.0"), { homeDir: home, env: { PATH: uv }, run: fakeRun([]) });
  const second = await installLockedSpec(lockedSpec("0.2.0"), { homeDir: home, env: { PATH: uv }, run: fakeRun([]) });
  expect(second.ok).toBe(true);
  expect(second.entryPath).toBe(first.entryPath!);
  expect(lockedEntryPath(home, lockedSpec("0.2.0"))).toBe(lockedEntryPath(home, lockedSpec("0.1.0")));
  expect(await installedVersion(home, lockedSpec("0.2.0"))).toBe("0.2.0");
  expect(await readFile(path.join(home, ".casper/tools/casper-network-mcp/casper-network-mcp.lock.txt"), "utf8")).toContain("==0.2.0");
  expect(await readdir(path.join(home, ".casper", "tools"))).toEqual(["casper-network-mcp"]);
});

test("a failed upgrade keeps the old version working", async () => {
  const home = await temp("casper-locked-home-");
  const uv = await fakeUvDir();
  await installLockedSpec(lockedSpec("0.1.0"), { homeDir: home, env: { PATH: uv }, run: fakeRun([]) });
  const upgrade = await installLockedSpec(lockedSpec("0.2.0"), { homeDir: home, env: { PATH: uv }, run: fakeRun([], { pipExit: 1 }) });
  expect(upgrade.ok).toBe(false);
  expect(await installedVersion(home, lockedSpec("0.2.0"))).toBe("0.1.0");
  expect(await exists(lockedEntryPath(home, lockedSpec("0.1.0")))).toBe(true);
  expect(await readdir(path.join(home, ".casper", "tools"))).toEqual(["casper-network-mcp"]);
});

test("an install killed between the two renames is put back by the next install", async () => {
  const home = await temp("casper-locked-home-");
  const uv = await fakeUvDir();
  await installLockedSpec(lockedSpec("0.1.0"), { homeDir: home, env: { PATH: uv }, run: fakeRun([]) });
  const tools = path.join(home, ".casper", "tools");
  const { rename } = await import("node:fs/promises");
  await rename(path.join(tools, "casper-network-mcp"), path.join(tools, "casper-network-mcp.old"));
  const retry = await installLockedSpec(lockedSpec("0.2.0"), { homeDir: home, env: { PATH: uv }, run: fakeRun([], { pipExit: 1 }) });
  expect(retry.ok).toBe(false);
  expect(await installedVersion(home, lockedSpec("0.2.0"))).toBe("0.1.0");
  expect(await readdir(tools)).toEqual(["casper-network-mcp"]);
});

test("security tools keep their versioned folders", () => {
  const semgrep = SECURITY_TOOLS.semgrep;
  expect(pinnedToolDir("/home/someone", semgrep)).toBe(path.join("/home/someone", ".casper", "tools", `${semgrep.id}-${semgrep.version}`));
});

test("a failed hash-locked install says why in plain words, with uv's own last line", async () => {
  const home = await temp("casper-security-install-");
  const bin = await temp("casper-security-uv-");
  await fakeUv(bin);
  const failing =(stderr: string) => installTool(SECURITY_TOOLS.ruff, {
    homeDir: home, env: { PATH: bin },
    run: async (options) => options.args[0] === "pip" ? { exitCode: 1, signal: null, stdout: "", stderr } : { exitCode: 0, signal: null, stdout: "", stderr: "" },
  });
  const offline = await failing("error: Failed to fetch: `https://pypi.org/simple/ruff/`\n  Caused by: dns error: failed to lookup address information\n");
  expect(offline.ok).toBe(false);
  expect(offline.message).toBe("ruff S: the install couldn't reach pypi.org. Check your internet connection, then try again. (uv: Caused by: dns error: failed to lookup address information)");
  const hash = await failing("error: Hash mismatch for `ruff==0.15.0`\n");
  expect(hash.message).toBe("ruff S: a download did not match its pinned hash, so nothing was installed. Try again later. (uv: error: Hash mismatch for `ruff==0.15.0`)");
  const wheel = await failing("error: Distribution `ruff==0.15.0` can't be installed because it doesn't have a source distribution or wheel for the current platform\n");
  expect(wheel.message).toContain("ruff S: there is no ready-made build of it for this computer.");
  const other = await failing("error: something else\n");
  expect(other.message).toBe("ruff S: the install failed. (uv: error: something else)");
});

test("when uv cannot make the Python environment, the message says why in plain words and keeps uv's last line", () => {
  const blocked = pythonFailure(">=3.12", "error: Failed to install cpython-3.12\n  Caused by: error sending request for url (https://github.com/astral-sh/python-build-standalone): dns error: failed to lookup address");
  expect(blocked).toContain("no Python >=3.12 and uv could not download one");
  expect(blocked).toContain("github.com");
  expect(blocked).toContain("(uv: Caused by: error sending request");
  expect(pythonFailure(">=3.12", "error: Python downloads are disabled")).toContain("UV_PYTHON_DOWNLOADS");
  expect(pythonFailure(">=3.12", "error: No interpreter found for Python >=3.12 in managed installations or search path")).toContain('uv python install 3.12');
  expect(pythonFailure(">=3.12", "")).toContain('Try "uv python install 3.12"');
});
