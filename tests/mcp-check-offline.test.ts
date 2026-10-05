import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpCheck } from "../src/mcp/check/index";
import { DEAD_PROXY, liveEnv, offlineEnv } from "../src/mcp/check/sandbox";
import type { McpCheckCommand } from "../src/cli-args";
import { checkCommand } from "./support/check-command";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

test("offline removes credentials and points every web proxy at a dead local port", () => {
  const env = offlineEnv({
    PATH: "/usr/bin", HOME: "/home/me", MIST_API_TOKEN: "t", CLEARPASS_CLIENT_SECRET: "s", JUNOS_PASSWORD: "p", OPENAI_APIKEY: "k",
    GITHUB_BEARER: "b", AWS_CREDENTIALS: "c", SSH_PRIVATE_KEY: "k", https_proxy: "http://corp:8080", Http_Proxy: "http://corp:8080", DEVICES: "devices.json",
  }, { FIXTURE_TOKEN: "given on purpose" });
  expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/me", DEVICES: "devices.json", FIXTURE_TOKEN: "given on purpose" });
  for (const name of ["MIST_API_TOKEN", "CLEARPASS_CLIENT_SECRET", "JUNOS_PASSWORD", "OPENAI_APIKEY", "GITHUB_BEARER", "AWS_CREDENTIALS", "SSH_PRIVATE_KEY", "Http_Proxy"]) {
    expect(env[name]).toBeUndefined();
  }
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) expect(env[name]).toBe(DEAD_PROXY);
  expect(env).toMatchObject({ NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1", UV_OFFLINE: "1", PIP_NO_INDEX: "1", npm_config_offline: "true" });
  expect(liveEnv({ MIST_API_TOKEN: "t" }, { A: "1" })).toEqual({ MIST_API_TOKEN: "t", A: "1" });
});

async function envRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-check-offline-"));
  temps.push(root);
  await mkdir(path.join(root, ".casper"));
  // A script file, not `bun -e '…'`: the doctor runs through cmd.exe on Windows, which has no single quotes.
  await writeFile(path.join(root, "dump-env.js"), `require("fs").writeFileSync("env.json", JSON.stringify({ token: process.env.MIST_API_TOKEN ?? "absent", proxy: process.env.HTTPS_PROXY ?? null, extra: process.env.EXTRA ?? null }));\n`);
  await writeFile(path.join(root, ".casper/mcp-check.json"), JSON.stringify({ doctor: `${JSON.stringify(process.execPath)} dump-env.js` }));
  return root;
}

const command = (repo: string, extra: Partial<McpCheckCommand> = {}): McpCheckCommand =>
  ({ repo, live: false, quick: true, strict: false, json: false, env: {}, ...extra });

test("the repo's own commands run offline by default: no credentials, dead proxy, --env applied", async () => {
  const root = await envRepo();
  const baseEnv = { ...process.env, MIST_API_TOKEN: "real-token", HTTPS_PROXY: "http://corp:8080" };
  await new McpCheck(command(root, { env: { EXTRA: "yes" } }), { baseEnv }).run();
  expect(JSON.parse(await readFile(path.join(root, "env.json"), "utf8"))).toEqual({ token: "absent", proxy: DEAD_PROXY, extra: "yes" });

  await new McpCheck(command(root, { live: true }), { baseEnv }).run();
  expect(JSON.parse(await readFile(path.join(root, "env.json"), "utf8"))).toEqual({ token: "real-token", proxy: "http://corp:8080", extra: null });
});

test("offline calls no live step; --live without live checks says so plainly", async () => {
  const root = await envRepo();
  let liveRan = false;
  const offline = await new McpCheck(command(root), { live: async () => { liveRan = true; return []; } }).run();
  expect(liveRan).toBe(false);
  expect(offline.offline).toBe(true);
  expect(offline.findings.some((finding) => finding.section === "live")).toBe(false);
  const live = await new McpCheck(command(root, { live: true })).run();
  expect(live.offline).toBe(false);
  expect(live.findings.find((finding) => finding.section === "live")).toMatchObject({ status: "skip" });
});

test("close() stops a running repo command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-check-close-"));
  temps.push(root);
  await mkdir(path.join(root, ".casper"));
  await writeFile(path.join(root, ".casper/mcp-check.json"), JSON.stringify({ doctor: checkCommand("sleep:30000") }));
  const check = new McpCheck(command(root));
  const started = performance.now();
  const running = check.run();
  await Bun.sleep(200);
  await check.close();
  const report = await running;
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(report.findings.find((finding) => finding.label === "doctor")).toMatchObject({ status: "skip", text: "stopped" });
});
