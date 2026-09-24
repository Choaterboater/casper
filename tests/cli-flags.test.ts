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
  // Exercise default Casper state without inheriting the caller's override.
  const { PI_CODING_AGENT_DIR: _engine, CASPER_AGENT_DIR: _casper, ...inherited } = process.env;
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

test("hostile project.yaml text in a startup error never reaches the terminal as raw escapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  await mkdir(path.join(root, ".casper"));
  const yaml = path.join(root, ".casper/project.yaml");
  // A key in a semantic error, and a YAML parse error whose excerpt quotes the file.
  const hostile = [
    'verify:\n  "x\x1b]52;c;SGk=\x07y": "ok"\n',
    'verify:\n  test: "ok"\n bad: \x1b]0;PWNED\x07\x1b[2J oops: [\n',
  ];
  for (const [index, content] of hostile.entries()) {
    await writeFile(yaml, content);
    for (const entry of [cli, path.resolve(import.meta.dir, "../src/standalone.ts")]) {
      const result = await run([entry, "/project"], root);
      expect({ index, entry, code: result.code }).toEqual({ index, entry, code: 1 });
      expect(result.stderr).toContain("Invalid");
      expect(result.stderr).not.toMatch(/[\x07\x1b]/);
    }
  }
});

posixOnly("the source CLI run through its shebang ignores the opened directory's bunfig.toml and .env", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  const marker = path.join(root, "PRELOAD_RAN");
  await writeFile(path.join(root, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
  await writeFile(path.join(root, "evil.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  // A repository .env could otherwise redirect the credential store or the profile.
  await writeFile(path.join(root, ".env"), "CASPER_PROFILE=../evil\n");
  for (const args of [["--version"], ["/project"]]) {
    const { CASPER_PROFILE: _profile, PI_CODING_AGENT_DIR: _dir, CASPER_AGENT_DIR: _casper, ...inherited } = process.env;
    const child = Bun.spawn([cli, ...args], { cwd: root, env: { ...inherited, HOME: root }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ args, code, stderr }).toEqual({ args, code: 0, stderr: "" });
    expect(stdout).not.toContain("Invalid profile");
  }
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("an unrecognized leading option is a usage error, never a model prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  for (const args of [["--bogus"], ["--no-verfy"], ["--model", "foo", "hi"], ["--no-verify", "--session", "x", "hi"], ["-x"]]) {
    const result = await run([cli, ...args], root);
    expect({ args, code: result.code, stdout: result.stdout }).toEqual({ args, code: 2, stdout: "" });
    expect(result.stderr).toContain(`Unknown option ${args.find((arg) => arg.startsWith("-") && arg !== "--no-verify")}`);
    expect(result.stderr).toContain("casper --help");
  }
  // Nothing started: no engine store, no transcript.
  expect(await Bun.file(path.join(root, ".casper")).exists()).toBe(false);
  expect(await readdir(root).then((names) => names.includes(".casper"))).toBe(false);
});

test("informational flags are honored after the verify/integration options", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  const version = await run([cli, "--no-verify", "--version"], root);
  expect({ code: version.code, stderr: version.stderr }).toEqual({ code: 0, stderr: "" });
  expect(version.stdout).toMatch(/^casper \S+ \([^\n]*\)\n$/);
  const help = await run([cli, "--verify", "--help"], root);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("casper <prompt>");
});

test("-- ends option parsing, so a prompt may start with a dash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  // From source, Bun's own parser consumes the first `--` after the script; the compiled
  // binary passes it through. Either way Casper receives exactly one.
  const result = await run([cli, "--", "--", "--bogus", "is", "a", "prompt"], root);
  expect(result.stderr).not.toContain("Unknown option");
  expect(result.stdout).toContain("> --bogus is a prompt");
});
