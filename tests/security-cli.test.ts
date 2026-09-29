import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SECURITY_OFFLINE_LINE } from "../src/security/format";
import { SECURITY_TOOLS } from "../src/security/tools";
import { fixtureRepo } from "./fixtures/security-tools/setup";
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
  for (const spec of Object.values(SECURITY_TOOLS)) {
    const wrapper = path.join(bin, spec.command);
    await writeFile(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} ${spec.id} ${JSON.stringify(record)} canned "$@"\n`);
    await chmod(wrapper, 0o755);
  }
  const db = path.join(home, ".casper", "security", "osv-db", "osv-scalibr", "PyPI");
  await mkdir(db, { recursive: true });
  await writeFile(path.join(db, "all.zip"), "");
  return { home, bin, record };
}

async function casper(cwd: string, home: string, bin: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd, env: cleanEnv({ HOME: home, CASPER_PROFILE: "default", PATH: `${bin}:/usr/bin:/bin` }), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("casper security runs the tools through the subcommand, prints a plain report with counts and exits 1 on problems", async () => {
  const root = await fixtureRepo("casper-security-cli-"); temps.push(root);
  const { home, bin } = await machine();
  const text = await casper(root, home, bin, ["security"]);
  expect(text.code).toBe(1);
  expect(text.stdout).toContain(`Security check: ${path.basename(root)}`);
  expect(text.stdout).toContain(SECURITY_OFFLINE_LINE);
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
  const { home, bin } = await machine();
  // A clean gitleaks and an osv-scanner with no advisory data.
  await writeFile(path.join(bin, "gitleaks"), "#!/bin/sh\necho '[]'\n");
  await writeFile(path.join(bin, "osv-scanner"), "#!/bin/sh\necho '{\"results\":[]}'\n");
  await rm(path.join(home, ".casper", "security", "osv-db"), { recursive: true, force: true });
  const plain = await casper(root, home, bin, ["security"]);
  expect(plain.stdout).toContain("osv-scanner");
  expect(plain.stdout).toContain("no advisory data yet");
  expect(plain.code).toBe(0);
  expect((await casper(root, home, bin, ["security", "--strict"])).code).toBe(1);
});
