import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verificationFlag } from "../src/cli-main";
import { looksLikePath, parseCliArgs, parseMcpCheckArgs, UsageError } from "../src/cli-args";
import { resolveVerificationMode } from "../src/verify/mode";
import { CASPER_VERSION } from "../src/version";
import { needsPosixModes, posixOnly } from "./support/platform";
import { cleanEnv } from "./support/env";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const tempDirs: string[] = [];
afterEach(async () => { for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function run(args: string[], cwd: string, home = cwd) {
  // Exercise default Casper state without inheriting the caller's override.
  const child = Bun.spawn([process.execPath, ...args], {
    cwd, env: cleanEnv({ HOME: home, CASPER_PROFILE: "default" }), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("--verify selects auto and --no-verify selects off for the run, over configuration", () => {
  expect(verificationFlag({ verify: false, noVerify: false })).toBeUndefined();
  expect(verificationFlag({ verify: true, noVerify: false })).toBe("auto");
  expect(verificationFlag({ verify: false, noVerify: true })).toBe("off");
  expect(() => verificationFlag({ verify: true, noVerify: true })).toThrow("--verify and --no-verify cannot be combined");
  expect(resolveVerificationMode({ flag: "off", configured: "auto", interactive: true, measuredMs: 1 })).toBe("off");
  expect(resolveVerificationMode({ flag: "auto", configured: "off", interactive: false })).toBe("auto");
  expect(resolveVerificationMode({ configured: "auto", interactive: false })).toBe("auto");
  expect(resolveVerificationMode({ configured: "offer", interactive: true, measuredMs: 1 })).toBe("offer");
});

test("unconfigured: Casper checks its own work by default; interactive offers instead only once checks are known to take 60 s or more", () => {
  // Not yet timed: the first change runs the checks (and times them), with no command from the user.
  expect(resolveVerificationMode({ interactive: true })).toBe("auto");
  expect(resolveVerificationMode({ interactive: true, measuredMs: 59_999 })).toBe("auto");
  expect(resolveVerificationMode({ interactive: true, measuredMs: 60_000 })).toBe("offer");
  // One-shot cannot ask, so it always checks unless --no-verify or configuration says otherwise.
  expect(resolveVerificationMode({ interactive: false })).toBe("auto");
  expect(resolveVerificationMode({ interactive: false, measuredMs: 600_000 })).toBe("auto");
});

test("--verify --no-verify is rejected before any work starts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  const result = await run([cli, "--verify", "--no-verify", "Summarize"], root);
  expect({ code: result.code, stdout: result.stdout }).toEqual({ code: 64, stdout: "" });
  expect(result.stderr).toContain("--verify and --no-verify cannot be combined");
});

test("a flag following --mcp or --lsp is not taken as a server name", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  const result = await run([cli, "--mcp", "--verify", "Summarize"], root);
  expect({ code: result.code, stdout: result.stdout }).toEqual({ code: 64, stdout: "" });
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
  // Bun's own caches (transpiler, install) may appear under HOME; Casper's store must not.
  expect((await readdir(home)).filter((name) => !["Library", ".cache", ".bun"].includes(name))).toEqual([".pi"]);
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
    const child = Bun.spawn([cli, ...args], { cwd: root, env: cleanEnv({ HOME: root }), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ args, code, stderr }).toEqual({ args, code: 0, stderr: "" });
    expect(stdout).not.toContain("Invalid profile");
  }
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("an unrecognized leading option is a usage error (exit 64), never a model prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  for (const args of [["--bogus"], ["--no-verfy"], ["--no-verify", "--session", "x", "hi"], ["-x"]]) {
    const result = await run([cli, ...args], root);
    expect({ args, code: result.code, stdout: result.stdout }).toEqual({ args, code: 64, stdout: "" });
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
  const help = await run([cli, "--verify", "--verbose", "--help"], root);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("casper <prompt>");
  expect(help.stdout).toContain("--verbose");
});

test("-- ends option parsing, so a prompt may start with a dash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  // From source, Bun's own parser consumes the first `--` after the script; the compiled
  // binary passes it through. Either way Casper receives exactly one.
  const result = await run([cli, "--", "--", "--bogus", "is", "a", "prompt"], root);
  expect(result.stderr).not.toContain("Unknown option");
  expect(result.stdout).toContain("> --bogus is a prompt");
}, 60_000);

test("parseCliArgs reads leading options only; the rest is the prompt", () => {
  expect(parseCliArgs(["--verify", "--verbose", "fix", "the", "-v", "flag"])).toMatchObject({
    verify: true, verbose: true, noVerify: false, command: "prompt", rest: ["fix", "the", "-v", "flag"],
  });
  expect(parseCliArgs(["--mcp", "docs", "--lsp", "ts", "--mcp", "docs"])).toMatchObject({ servers: ["docs"], languageServers: ["ts"], command: "interactive", rest: [] });
  expect(parseCliArgs(["--", "--bogus", "prompt"])).toMatchObject({ command: "prompt", rest: ["--bogus", "prompt"] });
  expect(parseCliArgs(["--no-verify", "--version"])).toMatchObject({ info: "version" });
  // An informational flag wins over option conflicts: it runs nothing.
  expect(parseCliArgs(["--verify", "--no-verify", "--help"])).toMatchObject({ info: "help" });
  expect(parseCliArgs(["learn", "list", "/repo"])).toMatchObject({ command: "learn", rest: ["learn", "list", "/repo"] });
});

test("parseCliArgs rejects every usage mistake with a UsageError", () => {
  const cases: Array<[string[], string]> = [
    [["--bogus"], "Unknown option --bogus"],
    [["-x", "hi"], "Unknown option -x"],
    [["--verify", "--no-verify", "hi"], "--verify and --no-verify cannot be combined"],
    [["--mcp", "--verify", "hi"], "--mcp requires a configured server name"],
    [["--lsp"], "--lsp requires a configured server name"],
    [["--verify", "learn", "/repo"], "learn cannot be combined with options"],
  ];
  for (const [args, message] of cases) {
    let error: unknown;
    try { parseCliArgs(args); } catch (caught) { error = caught; }
    expect({ args, usage: error instanceof UsageError }).toEqual({ args, usage: true });
    expect((error as Error).message).toContain(message);
  }
});

test("learn usage mistakes exit 64 before any learning starts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-flags-"));
  tempDirs.push(root);
  for (const args of [["learn"], ["learn", "promote", "/repo"], ["--verify", "learn", "/repo"]]) {
    const result = await run([cli, ...args], root);
    expect({ args, code: result.code, stdout: result.stdout }).toEqual({ args, code: 64, stdout: "" });
    expect(result.stderr).toMatch(/Usage: casper learn|learn cannot be combined/);
  }
});

test("--require-verification turns Casper's checks on for a one-shot prompt", () => {
  const options = parseCliArgs(["--require-verification", "fix", "it"]);
  expect(options).toMatchObject({ requireVerification: true, command: "prompt" });
  expect(verificationFlag(options)).toBe("auto");
  for (const [args, message] of [
    [["--require-verification", "--no-verify", "fix"], "--require-verification cannot be combined with --no-verify"],
    [["--require-verification"], "--require-verification needs a prompt"],
  ] as const) {
    expect(() => parseCliArgs(args)).toThrow(message);
  }
});

test("value options take `--name value` or `--name=value`", () => {
  expect(parseCliArgs(["--model", "openai/gpt-x", "--effort=low", "hi"])).toMatchObject({ model: "openai/gpt-x", effort: "low" });
  expect(parseCliArgs(["--model=@review", "hi"])).toMatchObject({ model: "@review", command: "prompt", rest: ["hi"] });
  expect(parseCliArgs(["--mcp=docs"])).toMatchObject({ servers: ["docs"], command: "interactive" });
  expect(() => parseCliArgs(["--model=", "hi"])).toThrow("--model needs a value");
  expect(() => parseCliArgs(["--model", "--verify", "hi"])).toThrow("--model needs a value");
  expect(() => parseCliArgs(["--bogus=1", "hi"])).toThrow("Unknown option --bogus=1");
});

test("--continue and --resume parse for prompts and interactive sessions alike", () => {
  expect(parseCliArgs(["--continue"])).toMatchObject({ continueConversation: true, command: "interactive" });
  expect(parseCliArgs(["--resume=01a0d1", "go", "on"])).toMatchObject({ resume: "01a0d1", command: "prompt" });
  expect(() => parseCliArgs(["--resume"])).toThrow("--resume needs the start of a conversation ID");
});

test("--max-turns takes a whole number of turns", () => {
  expect(parseCliArgs(["--max-turns", "5", "hi"]).maxTurns).toBe(5);
  for (const value of ["0", "-1", "2.5", "many", "10000"]) expect(() => parseCliArgs(["--max-turns", value, "hi"])).toThrow("--max-turns needs a whole number");
});

test("--json needs a one-shot prompt", () => {
  expect(parseCliArgs(["--json", "fix"])).toMatchObject({ json: true, command: "prompt" });
  expect(() => parseCliArgs(["--json"])).toThrow("--json needs a prompt");
});

test("a lone - reads the one-shot prompt from stdin, so it never appears in the process list", () => {
  expect(parseCliArgs(["--json", "--verify", "-"])).toMatchObject({ command: "prompt", promptFromStdin: true, rest: [] });
  expect(parseCliArgs(["--", "-"])).toMatchObject({ command: "prompt", promptFromStdin: true });
  expect(parseCliArgs(["fix", "-"])).toMatchObject({ command: "prompt", rest: ["fix", "-"] });
  expect(parseCliArgs(["fix"]).promptFromStdin).toBeUndefined();
});

test("only `mcp check` selects the check command; other mcp prompts stay prompts", () => {
  expect(parseCliArgs(["mcp", "check"])).toMatchObject({ command: "mcp-check", rest: ["mcp", "check"] });
  expect(parseCliArgs(["mcp", "docs", "are", "wrong"])).toMatchObject({ command: "prompt" });
  expect(parseMcpCheckArgs(["mcp", "check"])).toEqual({ repo: ".", live: false, quick: false, strict: false, json: false, env: {} });
  expect(parseMcpCheckArgs(["mcp", "check", "./r", "--live", "--quick", "--strict", "--json", "--env", "A=1", "--env=B=x=y", "--", "uv", "run", "x", "--live"])).toEqual({
    repo: "./r", live: true, quick: true, strict: true, json: true, env: { A: "1", B: "x=y" }, command: ["uv", "run", "x", "--live"],
  });
  expect(parseMcpCheckArgs(["mcp", "check", "--server=hpe"])).toMatchObject({ server: "hpe", repo: "." });
});

test("mcp check usage mistakes are UsageErrors that print the usage", () => {
  for (const args of [["mcp", "check", "--bogus"], ["mcp", "check", "a", "b"], ["mcp", "check", "--env", "NOEQUALS"], ["mcp", "check", "--env", "1A=2"],
    ["mcp", "check", "--server"], ["mcp", "check", "--server", "x", "--", "y"], ["mcp", "check", "--"]]) {
    let error: unknown;
    try { parseMcpCheckArgs(args); } catch (caught) { error = caught; }
    expect({ args, usage: error instanceof UsageError }).toEqual({ args, usage: true });
    expect((error as Error).message).toContain("Usage: casper mcp check");
  }
  expect(() => parseCliArgs(["--json", "mcp", "check"])).toThrow("mcp check takes its own flags. Usage: casper mcp check");
});

test("a known option after the prompt is a usage mistake (64) found before anything runs; -v inside words and -- stay prompts", async () => {
  for (const [args, shown] of [[["fix", "it", "--verify"], 'casper --verify "fix it"'], [["fix", "it", "--model", "x/y"], 'casper --model x/y "fix it"'],
    [["fix", "--json"], 'casper --json "fix"'], [["fix", "it", "--model=x/y"], 'casper --model=x/y "fix it"']] as const) {
    let error: unknown;
    try { parseCliArgs([...args]); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(UsageError);
    const words = JSON.stringify(args.join(" "));
    expect((error as Error).message).toBe(`Options go before the prompt: ${shown}. To send it as words, quote the whole request: casper ${words}.`);
    // The quoted request is one argument, so it is sent as words (Bun drops a leading -- when casper runs from source).
    expect(parseCliArgs([args.join(" ")])).toMatchObject({ command: "prompt", rest: [args.join(" ")] });
  }
  expect(parseCliArgs(["fix", "the", "-v", "flag"])).toMatchObject({ command: "prompt", rest: ["fix", "the", "-v", "flag"] });
  expect(parseCliArgs(["--", "fix", "--verify"])).toMatchObject({ command: "prompt", rest: ["fix", "--verify"] });
  expect(() => parseCliArgs(["-", "--json"])).toThrow(UsageError);

  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-trailing-"));
  tempDirs.push(root);
  const result = await run([cli, "fix", "the", "login", "bug", "--verify"], root);
  expect({ code: result.code, stdout: result.stdout }).toEqual({ code: 64, stdout: "" });
  expect(result.stderr).toContain('Options go before the prompt: casper --verify "fix the login bug". To send it as words, quote the whole request: casper "fix the login bug --verify".');
  expect(await readdir(root)).not.toContain(".casper");
});

test("casper <folder> opens that folder; a path that is not a folder exits 64", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cli-folder-"));
  tempDirs.push(root);
  const project = path.join(root, "mist-mcp");
  await mkdir(project);
  await writeFile(path.join(project, "README.md"), "a project\n");
  const child = Bun.spawn([process.execPath, cli, "./mist-mcp"], { cwd: root, env: cleanEnv({ HOME: root, CASPER_PROFILE: "default" }), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write("/project\n"); child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain(" project   mist-mcp\n stack");
  expect(stdout).not.toContain("[model]");

  const missing = await run([cli, "./missing/"], root);
  expect({ code: missing.code, stdout: missing.stdout }).toEqual({ code: 64, stdout: "" });
  expect(missing.stderr).toContain("Not a folder: ./missing/");
  const twice = await run([cli, "--cd", root, "./mist-mcp"], root);
  expect(twice.code).toBe(64);
  const trailing = await run([cli, "./mist-mcp", "--cd", root], root);
  expect(trailing.code).toBe(64);
  expect(parseCliArgs(["./mist-mcp"])).toMatchObject({ command: "prompt", folderCandidate: true });
  // A slash command given as one word, with or without its arguments, is still a command, not a path.
  const slash = await run([cli, "/help all"], root);
  expect({ code: slash.code, stderr: slash.stderr }).toEqual({ code: 0, stderr: "" });
  // Only one word that can only be a path is refused; a quoted request with a slash in it is a prompt.
  for (const word of ["./missing/", "../x", "~/nowhere", "/no/such/place", "missing/", "C:\\code"]) expect(looksLikePath(word)).toBe(true);
  for (const word of ["Add POST /notes that creates a note", "fix src/app.py", "src/app.py", "/help all", "and/or"]) expect(looksLikePath(word)).toBe(false);
  const quoted = await run([cli, "fix the bug in src/app.py"], root);
  expect(quoted.code).not.toBe(64);
  expect(quoted.stderr).not.toContain("Not a folder");
}, 60_000); // seven CLI starts in a row

test("--allow-host, --allow-write and --allow-reach allow one host, folder or machine for this run, and may repeat", () => {
  const options = parseCliArgs(["--allow-host", "api.mist.com", "--allow-host=pypi.org", "--allow-write", "../shared", "--allow-reach", "10.0.0.5", "fix it"]);
  expect(options.allowHosts).toEqual(["api.mist.com", "pypi.org"]);
  expect(options.allowWrites).toEqual(["../shared"]);
  expect(options.allowReach).toEqual(["10.0.0.5"]);
  expect(options.rest).toEqual(["fix it"]);
  expect(() => parseCliArgs(["--allow-host"])).toThrow("--allow-host needs a host: --allow-host <host>");
  expect(() => parseCliArgs(["--allow-write", "--verify", "x"])).toThrow("--allow-write needs a folder: --allow-write <folder>");
  expect(() => parseCliArgs(["--allow-reach", "a b"])).toThrow("--allow-reach needs a machine: --allow-reach <host>");
});
