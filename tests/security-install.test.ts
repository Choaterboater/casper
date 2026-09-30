import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findTool, installQuestion, installTool, numberedChoices, ownCopyLine, UV_MISSING } from "../src/security/install";
import { SecurityCheck } from "../src/security/run";
import { hostPlatform, pinnedToolDir, SECURITY_TOOLS, type SecurityToolSpec } from "../src/security/tools";
import { fakeTools, fixtureRepo, run } from "./fixtures/security-tools/setup";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
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
  expect(await findTool(spec, { homeDir: home, env: { PATH: "" } })).toEqual({ kind: "pinned", path: path.join(pinnedToolDir(home, spec), "bin", "gitleaks"), version: "8.30.1" });
  // Only the pinned file counts: a copy whose marker names another checksum is not Casper's.
  const other = fakeBinarySpec(bytes, "tar.gz", "f".repeat(64));
  expect((await findTool(other, { homeDir: home, env: { PATH: "" } })).kind).toBe("missing");
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
  await writeFile(path.join(bin, "uv"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(bin, "uv"), 0o755);
  const calls: string[][] = [];
  const result = await installTool(SECURITY_TOOLS.ruff, {
    homeDir: home, env: { PATH: bin, MIST_APITOKEN: "abc123" },
    run: async (options) => {
      calls.push([...options.args]);
      expect(options.env.MIST_APITOKEN).toBeUndefined();
      if (options.args[0] === "pip") {
        const venvBin = path.join(pinnedToolDir(home, SECURITY_TOOLS.ruff), "venv", "bin");
        await mkdir(venvBin, { recursive: true });
        await writeFile(path.join(venvBin, "ruff"), "");
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    },
  });
  expect(result.ok).toBe(true);
  expect(calls[0]!.slice(0, 1)).toEqual(["venv"]);
  expect(calls[1]).toEqual(expect.arrayContaining(["pip", "install", "--require-hashes", "--no-deps", "--only-binary", ":all:"]));
  expect((await findTool(SECURITY_TOOLS.ruff, { homeDir: home, env: { PATH: "" } })).kind).toBe("pinned");
});

test("your own copy on PATH is used and shown with its version next to Casper's pin", async () => {
  const home = await temp("casper-security-install-");
  const bin = await temp("casper-security-path-");
  await writeFile(path.join(bin, "gitleaks"), "#!/bin/sh\necho 8.18.0\n");
  await chmod(path.join(bin, "gitleaks"), 0o755);
  const location = await findTool(SECURITY_TOOLS.gitleaks, { homeDir: home, env: { PATH: bin } });
  expect(location).toEqual({ kind: "path", path: path.join(bin, "gitleaks"), version: "8.18.0" });
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
  expect(report.missing).toEqual(["semgrep", "zizmor", "osv-scanner", "ansible-lint"]);
  expect(report.tools.find((tool) => tool.id === "semgrep")).toMatchObject({ status: "not-run", text: "not installed" });
  expect(await readdir(path.join(home, ".casper")).then((names) => names.sort())).toEqual(["security"]);
});
