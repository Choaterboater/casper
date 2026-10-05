import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SECURITY_TOOLS } from "../src/security/tools";
import { fakeProgram, fixtureRepo } from "./fixtures/security-tools/setup";
import { cleanEnv } from "./support/env";

setDefaultTimeout(60_000);

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const fake = path.resolve(import.meta.dir, "fixtures/security-tools/fake-tool.ts");
const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** Fake copies of the tools on PATH (the user's own copies, as far as Casper can tell), and advisory data in HOME. */
async function machine(): Promise<{ home: string; bin: string; record: string }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-security-cli-home-"));
  temps.push(home);
  const bin = path.join(home, "bin");
  const record = path.join(home, "record");
  await mkdir(bin, { recursive: true });
  await mkdir(record, { recursive: true });
  for (const spec of Object.values(SECURITY_TOOLS)) await fakeProgram(bin, spec.command, [process.execPath, fake, spec.id, record, "canned"]);
  const db = path.join(home, ".casper", "security", "osv-db", "osv-scalibr", "PyPI");
  await mkdir(db, { recursive: true });
  await writeFile(path.join(db, "all.zip"), "");
  return { home, bin, record };
}

async function casper(cwd: string, home: string, bin: string, args: string[]) {
  // The fakes, then git and the system's own programs. Windows reads the home folder from USERPROFILE.
  const system = process.platform === "win32" ? [path.dirname(Bun.which("git")!), path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : ["/usr/bin", "/bin"];
  const env = cleanEnv({ HOME: home, USERPROFILE: home, CASPER_PROFILE: "default" });
  for (const name of Object.keys(env)) if (name.toUpperCase() === "PATH") delete env[name];
  env.PATH = [bin, ...system].join(path.delimiter);
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("casper security runs the tools through the subcommand, prints a plain report with counts and exits 1 on problems", async () => {
  const root = await fixtureRepo("casper-security-cli-"); temps.push(root);
  const { home, bin } = await machine();
  const text = await casper(root, home, bin, ["security"]);
  expect(text.code).toBe(1);
  expect(text.stdout).toContain(`Security check: ${path.basename(root)}`);
  expect(text.stdout).toContain("Casper runs these tools");
  expect(text.stdout).toMatch(/Result: \d+ problems?.*This is what these tools found\. It does not prove the code has no problems\./);
  expect(text.stdout).toMatch(/gitleaks: using your/);
  expect(text.stdout).not.toMatch(/\bsecure\b|\bsafe\b/i);
  // The token in the fixture never reaches the report.
  expect(text.stdout).not.toContain("ghp_");

  const json = await casper(root, home, bin, ["security", ".", "--json"]);
  expect(json.code).toBe(1);
  const report = JSON.parse(json.stdout.trim()) as { version: number; problems: number; exitCode: number };
  expect(report).toMatchObject({ version: 1, exitCode: 1 });
  expect(report.problems).toBeGreaterThan(0);

  expect((await casper(root, home, bin, ["security", "--bogus"])).code).toBe(64);
});

test("mcp-scanner stays off unless --mcp-tools names a saved tool list", async () => {
  const root = await fixtureRepo("casper-security-cli-mcp-"); temps.push(root);
  const { home, bin, record } = await machine();
  const off = await casper(root, home, bin, ["security"]);
  expect(off.stdout).toContain("off; casper security --mcp-tools <file> checks the tool descriptions (large install)");
  expect(await Bun.file(path.join(record, "mcp-scanner.json")).exists()).toBe(false);
  const on = await casper(root, home, bin, ["security", "--mcp-tools", "tools.json", "--json"]);
  const report = JSON.parse(on.stdout.trim()) as { tools: Array<{ id: string; status: string }> };
  expect(report.tools.find((tool) => tool.id === "mcp-scanner")?.status).toBe("problems");
  expect((await casper(root, home, bin, ["security", "--mcp-tools", "missing.json"])).code).toBe(64);
});

test("with nothing to find the run exits 0, and --strict exits 1 when a check did not run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-security-cli-empty-")); temps.push(root);
  await writeFile(path.join(root, "README.md"), "# notes\n");
  await writeFile(path.join(root, "requirements.txt"), "requests==2.32.0\n");
  const { home, bin, record } = await machine();
  // A clean gitleaks and an osv-scanner with no advisory data.
  for (const id of ["gitleaks", "osv-scanner"] as const) await fakeProgram(bin, SECURITY_TOOLS[id].command, [process.execPath, fake, id, record, "clean"]);
  await rm(path.join(home, ".casper", "security", "osv-db"), { recursive: true, force: true });
  const plain = await casper(root, home, bin, ["security"]);
  expect(plain.stdout).toContain("osv-scanner");
  expect(plain.stdout).toContain("no advisory data yet");
  expect(plain.code).toBe(0);
  expect((await casper(root, home, bin, ["security", "--strict"])).code).toBe(1);
});
