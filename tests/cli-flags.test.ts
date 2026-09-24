import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAutoVerify } from "../src/cli";
import { CASPER_VERSION } from "../src/version";
import { needsPosixModes, posixOnly } from "./support/platform";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const tempDirs: string[] = [];
afterEach(async () => { for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function run(args: string[], cwd: string, home = cwd) {
  // The CLI defaults its engine store only when PI_CODING_AGENT_DIR is unset.
  const { PI_CODING_AGENT_DIR: _inherited, ...inherited } = process.env;
  const child = Bun.spawn([process.execPath, ...args], {
    cwd, env: { ...inherited, HOME: home, CASPER_PROFILE: "default" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("interactive sessions offer casper_check unless --no-verify; one-shot prompts need --verify", () => {
  expect(resolveAutoVerify({ verify: false, noVerify: false, interactive: true })).toBe(true);
  expect(resolveAutoVerify({ verify: false, noVerify: true, interactive: true })).toBe(false);
  expect(resolveAutoVerify({ verify: false, noVerify: false, interactive: false })).toBe(false);
  expect(resolveAutoVerify({ verify: true, noVerify: false, interactive: false })).toBe(true);
  expect(() => resolveAutoVerify({ verify: true, noVerify: true, interactive: true })).toThrow("--verify and --no-verify cannot be combined");
});

test("--verify --no-verify is rejected before any work starts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  const result = await run([cli, "--verify", "--no-verify", "Summarize"], root);
  expect({ code: result.code, stdout: result.stdout }).toEqual({ code: 1, stdout: "" });
  expect(result.stderr).toContain("--verify and --no-verify cannot be combined");
});

test("a flag following --mcp or --lsp is not taken as a server name", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  const result = await run([cli, "--mcp", "--verify", "Summarize"], root);
  expect({ code: result.code, stdout: result.stdout }).toEqual({ code: 1, stdout: "" });
  expect(result.stderr).toContain("--mcp requires a configured server name");
});

posixOnly("--version names the cli.ts that actually runs, through a PATH-style symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  const link = path.join(root, "casper");
  await symlink(cli, link);
  const result = await run([link, "--version"], root);
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  expect(result.stdout).toBe(`casper ${CASPER_VERSION} (${await realpath(cli)})\n`);
});

/** A Pi CLI user's home: the first Casper run would import these credentials. */
async function piUserHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-home-"));
  tempDirs.push(home);
  await mkdir(path.join(home, ".pi/agent"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(home, ".pi/agent/auth.json"), JSON.stringify({
    fixture: { type: "api_key", key: "synthetic-legacy" },
    "openai-codex": { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 1 },
  }), { mode: 0o600 });
  return home;
}

test("--version, --help and --licenses have no side effects: one version line, no store, no import", async () => {
  const home = await piUserHome();
  const version = await run([cli, "--version"], home);
  expect({ code: version.code, stderr: version.stderr }).toEqual({ code: 0, stderr: "" });
  // The installers identify the binary by this exact single line.
  expect(version.stdout).toMatch(/^casper \S+ \([^\n]*\)\n$/);
  for (const flag of ["--help", "--licenses"]) {
    const result = await run([cli, flag], home);
    expect({ flag, code: result.code, imported: result.stdout.includes("[auth]") }).toEqual({ flag, code: 0, imported: false });
  }
  // Bun's own transpiler cache may appear under HOME; Casper's store must not.
  expect((await readdir(home)).filter((name) => name !== "Library" && name !== ".cache")).toEqual([".pi"]);
});

test("a real session reports the one-time credential import on stderr, not stdout", async () => {
  const home = await piUserHome();
  const result = await run([cli, "/help"], home);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("[auth]");
  expect(result.stderr).toContain("[auth] Imported existing credentials into ~/.casper/agent.");
  expect(result.stderr).toContain("run /login openai-codex to sign in Casper");
  expect(await Bun.file(path.join(home, ".casper/agent/auth.json")).json()).toEqual({ fixture: { type: "api_key", key: "synthetic-legacy" } });
});

needsPosixModes("a read-only HOME still prints the version and help", async () => {
  const home = await piUserHome();
  await chmod(home, 0o500);
  try {
    for (const flag of ["--version", "--help"]) {
      const result = await run([cli, flag], home);
      expect({ flag, code: result.code, stderr: result.stderr }).toEqual({ flag, code: 0, stderr: "" });
    }
  } finally { await chmod(home, 0o700); }
});
