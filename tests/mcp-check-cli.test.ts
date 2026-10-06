import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanEnv } from "./support/env";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function repo(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-check-cli-"));
  temps.push(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

async function run(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: cleanEnv({ HOME: cwd, USERPROFILE: cwd, CASPER_PROFILE: "default" }), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

const fixture = path.resolve(import.meta.dir, "fixtures/mcp-check-server.ts");
const fixtureServer = (mode: string, env: Record<string, string> = {}) =>
  ({ command: process.execPath, args: [fixture], env: { FIXTURE_MODE: mode, FIXTURE_READ_ONLY: "1", ...env } });
const readOnlyExample = { mcpServers: { fixture: fixtureServer("good") } };
// The repo's tests: a package.json script, not make, which is not on every Windows machine.
const passingTests = { "package.json": { scripts: { test: "echo ok" } }, "bun.lock": "" };

test("a clean repo exits 0 and prints the offline notice and the report", async () => {
  const root = await repo({ ".mcp.json.example": readOnlyExample, ...passingTests });
  const result = await run(["mcp", "check", "."], root);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Offline is best effort: a program that reads its own .env or opens SSH itself can still reach the network.");
  expect(result.stdout).toContain("  ok    tests         bun run test (");
  expect(result.stdout).toContain("  ok    .mcp.json.example  keeps writes off");
  expect(result.stdout).toContain("Result: 0 problems, 1 warning, 0 notes");
});

test("a problem exits 1, and warnings exit 1 only with --strict", async () => {
  const secret = await repo({ ".mcp.json.example": { mcpServers: { mist: fixtureServer("good", { MIST_API_TOKEN: "x".repeat(10) + "1234567890abcdefghij0123456789", MIST_READ_ONLY: "true" }) } } });
  const failed = await run(["mcp", "check"], secret);
  expect(failed.code).toBe(1);
  expect(failed.stdout).toContain("has a secret in plain text (env MIST_API_TOKEN, 40 chars)");
  expect(failed.stdout).not.toContain("1234567890abcdefghij");

  const warnings = await repo({ "README.md": "no example config" });
  expect((await run(["mcp", "check", warnings, "--", process.execPath, fixture], warnings)).code).toBe(0);
  expect((await run(["mcp", "check", warnings, "--strict", "--", process.execPath, fixture], warnings)).code).toBe(1);
}, 60_000);

test("a server with a mislabeled tool exits 1; the same repo with a clean server exits 0", async () => {
  const lying = await repo({ ".mcp.json.example": { mcpServers: { fixture: fixtureServer("lying") } }, ...passingTests });
  const failed = await run(["mcp", "check", "."], lying);
  expect(failed.code).toBe(1);
  expect(failed.stdout).toContain("  ok    starts        in ");
  expect(failed.stdout).toContain("  fail  label         delete_site is labeled read-only, but the name says it changes things.");
  const clean = await repo({ ".mcp.json.example": readOnlyExample, ...passingTests });
  const passed = await run(["mcp", "check", "."], clean);
  expect(passed.stdout).toContain("  ok    starts        in ");
  expect(passed.code).toBe(0);
}, 60_000); // two full checks, each running the repo's tests and starting its server

test("--json prints one JSON report with version 1 on stdout; progress goes to stderr", async () => {
  const root = await repo({ ".mcp.json.example": readOnlyExample, ".casper/mcp-check.json": { doctor: "echo doctor-ran" } });
  const result = await run(["mcp", "check", "--json", "--quick"], root);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({ version: 1, offline: true, exitCode: 0 });
  expect(report.findings.find((finding: { label: string }) => finding.label === "doctor")).toMatchObject({ status: "ok" });
  expect(result.stderr).toContain("Running doctor: echo doctor-ran");
  expect(result.code).toBe(0);
});

test("usage mistakes exit 64 before anything runs", async () => {
  const root = await repo({ ".casper/mcp-check.json": { doctor: "touch ran.txt" } });
  for (const args of [["mcp", "check", "--bogus"], ["--json", "mcp", "check"], ["mcp", "check", "a", "b"], ["mcp", "check", "--server", "x", "--", "y"], ["mcp", "check", "--env", "1A=2"], ["mcp", "check", "./missing"]]) {
    const result = await run(args, root);
    expect({ args, code: result.code, stdout: result.stdout }).toEqual({ args, code: 64, stdout: "" });
    expect(result.stderr).toMatch(/Usage: casper mcp check|not a folder/);
  }
  expect(await Bun.file(path.join(root, "ran.txt")).exists()).toBe(false);
});
