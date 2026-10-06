import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatSecurityReport } from "../src/security/format";
import { osvDbState, updateOsvDb } from "../src/security/install";
import { OSV_NO_DATA, SecurityCheck } from "../src/security/run";
import { fakeTools, fixtureRepo } from "./fixtures/security-tools/setup";
import { removeTempDir } from "./support/temp-dir";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await removeTempDir(dir); });

const NOW = new Date("2026-09-29T12:00:00Z");

test("with no advisory data osv-scanner is 'not run' with the update hint, never 'ok'", async () => {
  const root = await fixtureRepo("casper-security-osv-");
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-security-osv-home-"));
  temps.push(root, home);
  const tools = await fakeTools(home);
  const report = await new SecurityCheck({ root, homeDir: home, find: tools.find, only: ["osv-scanner"], now: () => NOW }).run();
  expect(report.tools).toEqual([expect.objectContaining({ id: "osv-scanner", status: "not-run", text: OSV_NO_DATA })]);
  expect(formatSecurityReport(report)).toContain("osv-scanner   not run      no advisory data yet. /security-review update downloads it (asks first)");
  expect(await tools.recorded("osv-scanner")).toBeUndefined();
});

test("with data downloaded 9 days ago the line shows the date and the age", async () => {
  const root = await fixtureRepo("casper-security-osv-");
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-security-osv-home-"));
  temps.push(root, home);
  const dir = path.join(home, ".casper", "security", "osv-db", "osv-scalibr", "PyPI");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "all.zip"), "");
  const downloaded = new Date("2026-09-20T08:00:00Z");
  await utimes(path.join(dir, "all.zip"), downloaded, downloaded);
  expect(await osvDbState(home, NOW)).toEqual({ present: true, ecosystems: ["PyPI"], downloadedAt: downloaded, ageDays: 9 });
  const tools = await fakeTools(home, { "osv-scanner": "clean" });
  const report = await new SecurityCheck({ root, homeDir: home, find: tools.find, only: ["osv-scanner"], now: () => NOW }).run();
  expect(formatSecurityReport(report)).toContain("osv-scanner   ok           advisory data downloaded 2026-09-20 (9 days old)");
});

test("the update step asks osv-scanner to download into Casper's folder, with no credentials", async () => {
  const root = await fixtureRepo("casper-security-osv-");
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-security-osv-home-"));
  temps.push(root, home);
  const seen: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
  const result = await updateOsvDb(root, "/pinned/osv-scanner", {
    homeDir: home, env: { PATH: "/usr/bin", HTTPS_PROXY: "http://corp:8080", MIST_APITOKEN: "abc123" },
    run: async (options) => {
      seen.push({ args: options.args, env: options.env });
      const dir = path.join(options.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY!, "osv-scalibr", "PyPI");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "all.zip"), "zip");
      return { exitCode: 1, signal: null, stdout: "{}", stderr: "" };
    },
  });
  expect(result).toEqual({ ok: true, message: "Advisory data downloaded for PyPI." });
  expect(seen[0]!.args).toContain("--download-offline-databases");
  expect(seen[0]!.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY).toBe(path.join(home, ".casper", "security", "osv-db"));
  expect(seen[0]!.env.HTTPS_PROXY).toBe("http://corp:8080");
  expect(seen[0]!.env.MIST_APITOKEN).toBeUndefined();
});
