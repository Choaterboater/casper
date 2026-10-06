import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatNewProjectReceipt } from "../src/new/receipt";
import { createProject } from "../src/new/scaffold";

/**
 * Real `casper new` runs: real uv, bun and git, packages from pypi.org and npm. Off by default
 * (no network in the normal suite); .github/workflows/live-checks.yml sets TEST_LIVE_NEW=1 with uv installed. Each test
 * fails when its template is broken. (CASPER_* variables are stripped by the test preload, so the
 * switch has a plain name.)
 */

const uv = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;
const live = process.env.TEST_LIVE_NEW === "1" && uv && process.platform !== "win32";
const LONG = 15 * 60_000;
const REPO = path.resolve(import.meta.dir, "..");

let root = "";
let parent = "";
let env: NodeJS.ProcessEnv = {};

describe.skipIf(!live)("casper new, live", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "casper-new-live-"));
    parent = path.join(root, "Projects");
    await mkdir(parent);
    const gitconfig = path.join(root, "gitconfig");
    await writeFile(gitconfig, "[user]\n\tname = Live Test\n\temail = live@example.com\n");
    // bun from this test run first on PATH, so web-app uses the same Bun.
    env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" };
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  const make = async (template: string, name: string) => {
    const result = await createProject({ parent, name, template, env, homeDir: root });
    expect(`${formatNewProjectReceipt(result).join("\n")}\n${result.output ?? ""}`).toStartWith("Ready: ");
    return path.join(parent, name);
  };
  const run = (argv: string[], cwd: string, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(argv[0]!, argv.slice(1), { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: LONG });

  test("python-cli: created, and uv run pytest passes", async () => {
    const dir = await make("python-cli", "demo-cli");
    expect(run(["uv", "run", "pytest", "-q"], dir).status).toBe(0);
  }, LONG);

  test("network-mcp: created, its tests pass, and casper mcp check --quick exits 0", async () => {
    const dir = await make("network-mcp", "demo-mcp");
    expect(run(["uv", "run", "pytest", "-q"], dir).status).toBe(0);
    const check = run([process.execPath, path.join(REPO, "src/cli.ts"), "mcp", "check", "--quick", dir], REPO);
    expect(`${check.status}\n${check.stdout}`).toStartWith("0\n");
  }, LONG);

  test("mist-python: tests pass offline after creation (recorded answers only)", async () => {
    const dir = await make("mist-python", "demo-mist");
    const offline = run(["uv", "run", "pytest", "-q"], dir, { UV_OFFLINE: "1", HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" });
    expect(`${offline.status}\n${offline.stdout}`).toStartWith("0\n");
  }, LONG);

  test("noc-dashboard: created, and the page test passes on sample data", async () => {
    const dir = await make("noc-dashboard", "demo-noc");
    expect(run(["uv", "run", "pytest", "-q"], dir, { UV_OFFLINE: "1" }).status).toBe(0);
  }, LONG);

  test("web-app: created with bun init --react=tailwind, and bun test passes", async () => {
    const dir = await make("web-app", "demo-web");
    expect(run([process.execPath, "test"], dir).status).toBe(0);
  }, LONG);

  test("vite-react: created with bun create vite, and bun test passes", async () => {
    const dir = await make("vite-react", "demo-vite");
    expect(run([process.execPath, "test"], dir).status).toBe(0);
  }, LONG);

  test("aoscx-ansible and junos-ansible: created, and their file checks pass", async () => {
    for (const [template, name] of [["aoscx-ansible", "demo-cx"], ["junos-ansible", "demo-junos"]] as const) {
      const dir = await make(template, name);
      expect(run(["uv", "run", "pytest", "-q"], dir, { UV_OFFLINE: "1" }).status).toBe(0);
    }
  }, LONG);
});

test.skipIf(live)("live casper new runs are off (set TEST_LIVE_NEW=1 with uv installed)", () => {
  expect(live).toBe(false);
});
