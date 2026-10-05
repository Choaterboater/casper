import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverMCPConfiguration, type MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { NETWORK_SERVER, networkServerEntry } from "../src/mcp/network/server";
import { runNetworkUpdate, type SetupHost } from "../src/mcp/network/setup";
import { installedVersion, installLockedSpec, type InstallOptions } from "../src/security/install";
import type { ToolRunner } from "../src/security/spawn";

/**
 * Plan D on a real file system. The old version's folder is held open by a running process (on Windows that keeps the
 * folder from being renamed) until the server stops; the update must swap the folders then, and must keep the old
 * version when something else still holds it. Runs on every OS; the "still held" cases only mean something on Windows.
 */

const windows = process.platform === "win32";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const target = (home: string) => path.join(home, ".casper", "tools", NETWORK_SERVER.id);
const heldFile = (home: string) => path.join(target(home), "venv", "held.txt");

/** A uv on PATH (never run: the runner stands in for it) whose `pip install` writes the server's entry and one more file. */
async function fakeUv(): Promise<Pick<InstallOptions, "env" | "run">> {
  const bin = await temp("casper-swap-uv-");
  const uv = path.join(bin, windows ? "uv.cmd" : "uv");
  await writeFile(uv, windows ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  await chmod(uv, 0o755);
  const run: ToolRunner = async (call) => {
    if (call.args[0] === "pip") {
      const python = call.args[call.args.indexOf("--python") + 1]!;
      const scripts = path.dirname(python);
      await mkdir(scripts, { recursive: true });
      await writeFile(path.join(scripts, `${NETWORK_SERVER.source.entry}${windows ? ".exe" : ""}`), "entry");
      await writeFile(path.join(path.dirname(scripts), "held.txt"), "held");
    }
    return { exitCode: 0, signal: null, stdout: "", stderr: "" };
  };
  return { env: { PATH: bin }, run };
}

/** Another process holding the old version's file open, like a second Casper window running the server. */
async function holder(file: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", `require("fs").openSync(${JSON.stringify(file)}, "r"); console.log("held"); setInterval(() => {}, 1000)`], { stdio: ["ignore", "pipe", "inherit"] });
  cleanup.push(() => stop(child));
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("exit", (code) => reject(new Error(`holder exited (${code})`)));
  });
  return child;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}

/** Can the old version's folder be renamed right now? (Windows says no while a file in it is open.) */
async function folderMoves(home: string): Promise<boolean> {
  try {
    await rename(target(home), `${target(home)}.probe`);
    await rename(`${target(home)}.probe`, target(home));
    return true;
  } catch { return false; }
}

async function olderInstall(): Promise<{ home: string; install: Pick<InstallOptions, "env" | "run"> }> {
  const home = await temp("casper-swap-home-");
  const install = await fakeUv();
  expect((await installLockedSpec({ ...NETWORK_SERVER, version: "0.0.9" }, { homeDir: home, ...install })).ok).toBe(true);
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper", "mcp.json"), JSON.stringify({ mcpServers: { network: networkServerEntry(home) } }, null, 2));
  return { home, install };
}

function host(home: string, install: Pick<InstallOptions, "env" | "run">, restart: SetupHost["restart"]): SetupHost & { output: string } {
  const result: SetupHost & { output: string } = {
    homeDir: home, output: "", install,
    canAsk: () => true,
    chooseAnswer: async () => "2",
    write: (text) => { result.output += text; },
    configured: async () => (await discoverMCPConfiguration({ projectRoot: home, homeDir: home })).servers,
    connect: async () => ({ ok: true }),
    restart,
  };
  return result;
}

const leftovers = async (home: string) => (await readdir(path.dirname(target(home)))).filter((name) => name !== NETWORK_SERVER.id);

test("the update swaps the folders once the server stops, though its files were held open until then", async () => {
  const { home, install } = await olderInstall();
  const server = await holder(heldFile(home));
  if (windows) expect(await folderMoves(home)).toBe(false);
  const setup = host(home, install, async (_name, whileStopped) => {
    await stop(server);
    await whileStopped?.();
  });
  expect(await runNetworkUpdate(setup, { explicit: true })).toBe("updated");
  expect(setup.output).toContain(`Network server updated to ${NETWORK_SERVER.version}.`);
  expect(await installedVersion(home, NETWORK_SERVER)).toBe(NETWORK_SERVER.version);
  expect(await leftovers(home)).toEqual([]);
}, 30_000);

test.if(windows)("Windows: while another process still holds the old version, the update keeps it and says what to do", async () => {
  const { home, install } = await olderInstall();
  const otherWindow = await holder(heldFile(home));
  const setup = host(home, install, async (_name, whileStopped) => { await whileStopped?.(); });
  expect(await runNetworkUpdate(setup, { explicit: true })).toBe("failed");
  expect(setup.output).toContain("Casper couldn't swap in the new version (its files are in use). The network server keeps 0.0.9 and is running again.");
  expect(await installedVersion(home, NETWORK_SERVER)).toBe("0.0.9");
  expect(await leftovers(home)).toEqual([]);
  // Once that window closes, the next try goes through.
  await stop(otherWindow);
  expect(await runNetworkUpdate(setup, { explicit: true })).toBe("updated");
  expect(await installedVersion(home, NETWORK_SERVER)).toBe(NETWORK_SERVER.version);
  expect(await leftovers(home)).toEqual([]);
}, 30_000);

test("through the MCP manager: the running server is stopped before the swap, and starts again after it", async () => {
  const { home, install } = await olderInstall();
  const definition: MCPServerDefinition = {
    name: "network", source: path.join(home, ".casper", "mcp.json"), scope: "user", cwd: home, disabled: false,
    transport: { type: "stdio", command: process.execPath, args: [path.join(import.meta.dir, "fixtures", "holding-mcp-server.ts")], env: { HOLD_FILE: heldFile(home) } },
  };
  const manager = new MCPManager({ servers: [definition], diagnostics: [] }, { timeoutMs: 20_000, homeDir: home });
  cleanup.push(() => manager.close());
  await manager.connect("network");
  if (windows) expect(await folderMoves(home)).toBe(false);
  const setup = host(home, install, (name, whileStopped) => manager.restartAfterCalls(name, whileStopped ? { whileStopped } : {}));
  expect(await runNetworkUpdate(setup, { explicit: true })).toBe("updated");
  expect(await installedVersion(home, NETWORK_SERVER)).toBe(NETWORK_SERVER.version);
  expect(await leftovers(home)).toEqual([]);
  expect(manager.status().find((item) => item.name === "network")?.state).toBe("ready");
}, 60_000);
