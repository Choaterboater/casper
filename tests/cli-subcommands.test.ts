import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCliArgs, parseSecurityArgs, parseUpdateArgs, SUBCOMMANDS, UsageError } from "../src/cli-args";
import { cleanEnv } from "./support/env";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function run(args: string[]) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "casper-subcommand-"));
  temps.push(cwd);
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: cleanEnv({ HOME: cwd, CASPER_PROFILE: "default" }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, cwd };
}

test("subcommands are matched first, in one fixed order", () => {
  expect(SUBCOMMANDS.map((entry) => entry.name)).toEqual(["learn", "mcp-check", "new", "security", "update"]);
  expect(parseCliArgs(["new"]).command).toBe("new");
  expect(parseCliArgs(["new", "--list"]).command).toBe("new");
  expect(parseCliArgs(["new", "python-cli", "ping-tool"]).command).toBe("new");
  expect(parseCliArgs(["security"]).command).toBe("security");
  expect(parseCliArgs(["security", "./repo", "--json"]).command).toBe("security");
  expect(parseCliArgs(["mcp", "check", "."]).command).toBe("mcp-check");
  expect(parseCliArgs(["update"]).command).toBe("update");
  expect(parseCliArgs(["update", "--check"]).command).toBe("update");
});

test("ordinary sentences that start with a subcommand's word stay prompts", () => {
  expect(parseCliArgs(["new", "ideas", "for", "the", "app"]).command).toBe("prompt");
  expect(parseCliArgs(["security", "review", "of", "the", "login", "code"]).command).toBe("prompt");
  // One quoted request with a slash in it is words, not a folder.
  expect(parseCliArgs(["security", "review the /login handler"]).command).toBe("prompt");
  expect(parseCliArgs(["mcp", "docs", "are", "wrong"]).command).toBe("prompt");
  expect(parseCliArgs(["update", "the", "readme"]).command).toBe("prompt");
  expect(parseCliArgs(["update the readme"]).command).toBe("prompt");
  expect(parseCliArgs(["update", "--check", "the", "readme"]).command).toBe("prompt");
});

test("casper update takes only --check; anything else is a usage mistake, and leading options are refused", () => {
  expect(parseUpdateArgs(["update"])).toEqual({ check: false });
  expect(parseUpdateArgs(["update", "--check"])).toEqual({ check: true });
  expect(() => parseUpdateArgs(["update", "--bogus"])).toThrow("Unknown option --bogus. Usage: casper update [--check]");
  expect(parseCliArgs(["update", "--bogus"]).command).toBe("update");
  expect(() => parseCliArgs(["--verbose", "update"])).toThrow("update takes its own flags. Usage: casper update [--check]");
});

test("casper security <folder> is the command when the folder is there, even without ./", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "casper-security-folder-"));
  temps.push(cwd);
  await mkdir(path.join(cwd, "app"));
  const before = process.cwd();
  process.chdir(cwd);
  try {
    expect(parseCliArgs(["security", "app"])).toMatchObject({ command: "security", rest: ["security", "app"] });
    expect(parseCliArgs(["security", "app", "--json"]).command).toBe("security");
    // A word that is not a folder here stays part of a prompt.
    expect(parseCliArgs(["security", "audit"]).command).toBe("prompt");
  } finally { process.chdir(before); }
});

test("a subcommand takes its own flags, never Casper's leading options", () => {
  expect(() => parseCliArgs(["--verbose", "new", "--list"])).toThrow(UsageError);
  expect(() => parseCliArgs(["--json", "security"])).toThrow("security takes its own flags. Usage: casper security [repo] [--json] [--strict] [--install] [--mcp-tools <file>]");
  expect(() => parseSecurityArgs(["security", "--bogus"])).toThrow("Unknown option --bogus");
  expect(parseSecurityArgs(["security", "../app", "--strict", "--install"])).toEqual({ repo: "../app", json: false, strict: true, install: true });
  expect(parseSecurityArgs(["security", "--mcp-tools", "tools.json"])).toEqual({ repo: ".", json: false, strict: false, install: false, mcpTools: "tools.json" });
  expect(parseCliArgs(["security", "--mcp-tools", "tools.json"]).command).toBe("security");
  expect(() => parseSecurityArgs(["security", "--mcp-tools"])).toThrow("Usage: casper security");
});

test("casper new --list prints the templates with no model and no saved state", async () => {
  const { stdout, code } = await run(["new", "--list"]);
  expect(code).toBe(0);
  expect(stdout).toContain("python-cli");
  expect(stdout).toContain("network-mcp");
});

test("casper new without a template, when it can't ask, is a usage mistake (exit 64)", async () => {
  const { stdout, code } = await run(["new", "my-tool"]);
  expect(code).toBe(64);
  expect(stdout).toContain("casper new needs a template and a name when it can't ask");
});

test("casper security: a bad flag or folder exits 64; a run prints the tools' report and never calls a model", async () => {
  expect((await run(["security", "--bogus"])).code).toBe(64);
  const missing = await run(["security", "./not-there"]);
  expect(missing.code).toBe(64);
  expect(missing.stderr).toContain("security: not a folder: ./not-there");
  const json = await run(["security", ".", "--json"]);
  expect([0, 1]).toContain(json.code);
  const report = JSON.parse(json.stdout.trim()) as { version: number; exitCode: number };
  expect(report.version).toBe(1);
  expect(report.exitCode).toBe(json.code);
});

test("casper update with a bad flag exits 64 before it looks anything up", async () => {
  const { stderr, code } = await run(["update", "--bogus"]);
  expect(code).toBe(64);
  expect(stderr).toContain("Unknown option --bogus. Usage: casper update [--check]");
});
