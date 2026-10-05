import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { NETWORK_SETUP_CHOICES, NETWORK_UPDATE_CHOICES } from "../src/app/safe-choices";
import { discoverMCPConfiguration, type MCPServerDefinition } from "../src/mcp/config";
import { NETWORK_SERVER, networkServerEntry } from "../src/mcp/network/server";
import {
  namesNetworkProduct, networkSetupLine, networkSetupQuestion, runNetworkSetup, runNetworkUpdate, shouldOfferNetworkSetup, shouldOfferNetworkUpdate,
  type SetupHost,
} from "../src/mcp/network/setup";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeStartOptions } from "../src/runtime/types";
import { installedVersion, type InstallOptions } from "../src/security/install";
import type { ToolRunner } from "../src/security/spawn";
import type { LockedSpec } from "../src/security/tools";
import { SkillRegistry } from "../src/skills/registry";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const exists = (file: string) => stat(file).then(() => true, () => false);

const fixtureServer = path.join(import.meta.dir, "fixtures/mcp-network-server.ts");

/** A fake uv on PATH and a runner whose `pip install` writes the server's entry: a script that starts the MCP fixture. */
async function fakeInstall(options: { pipExit?: number } = {}): Promise<Pick<InstallOptions, "env" | "run"> & { calls: string[][] }> {
  const bin = await temp("casper-network-uv-");
  await writeFile(path.join(bin, "uv"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(bin, "uv"), 0o755);
  const calls: string[][] = [];
  const run: ToolRunner = async (call) => {
    calls.push([...call.args]);
    if (call.args[0] === "pip") {
      if (options.pipExit) return { exitCode: options.pipExit, signal: null, stdout: "", stderr: "" };
      const python = call.args[call.args.indexOf("--python") + 1]!;
      await mkdir(path.dirname(python), { recursive: true });
      const entry = path.join(path.dirname(python), NETWORK_SERVER.source.entry);
      await writeFile(entry, `#!/bin/sh\nexec "${process.execPath}" "${fixtureServer}" "$@"\n`);
      await chmod(entry, 0o755);
    }
    return { exitCode: 0, signal: null, stdout: "", stderr: "" };
  };
  return { env: { PATH: bin }, run, calls };
}

const pinned = (version: string): LockedSpec => ({ ...NETWORK_SERVER, version });

interface FakeSetupHost extends SetupHost {
  output: string;
  installs: string[];
  connected: { name: string; writes: "off" | "on"; remembered: boolean }[];
  restarts: string[];
  asked: string[];
  uvInstalls: number;
}

/**
 * The setup flow's host, as a fake. `answers` come through the exact-answer channel (digits typed after the
 * question appeared).
 * `servers` are the definitions in ~/.casper/mcp.json (connect re-reads them).
 */
async function fakeSetupHost(options: { answers?: string[]; canAsk?: boolean; pipExit?: number; homeDir?: string; uvMissing?: boolean; uvInstall?: "ok" | "fail" } = {}): Promise<FakeSetupHost> {
  const homeDir = options.homeDir ?? await temp("casper-network-home-");
  const answers = [...options.answers ?? []];
  const install = await fakeInstall({ pipExit: options.pipExit });
  // No uv on PATH: the PATH holds only an empty folder.
  if (options.uvMissing) install.env = { PATH: await temp("casper-network-nouv-") };
  const host: FakeSetupHost = {
    homeDir, output: "", installs: [], connected: [], restarts: [], asked: [],
    canAsk: () => options.canAsk ?? true,
    write: (text) => { host.output += text; },
    chooseAnswer: async (preview, _question, choices) => {
      host.asked.push(preview);
      const answer = answers.shift();
      return answer === undefined ? undefined : choices.includes(answer) ? answer : "no";
    },
    configured: async () => {
      const configuration = await discoverMCPConfiguration({ projectRoot: homeDir, homeDir, platform: "linux" });
      return configuration.servers;
    },
    connect: async (name) => { host.connected.push({ name, writes: "off", remembered: true }); return { ok: true }; },
    restart: async (name, whileStopped) => { host.restarts.push(name); await whileStopped?.(); },
    install: { env: install.env, run: install.run },
    installer: async (spec, installOptions) => {
      host.installs.push(spec.version);
      const { installLockedSpec } = await import("../src/security/install");
      return installLockedSpec(spec, installOptions);
    },
    // uv's official installer, as a fake: it puts uv in ~/.local/bin, which is not on Casper's PATH.
    uvInstaller: async () => {
      host.uvInstalls++;
      if (options.uvInstall === "fail") return { ok: false, message: "curl: (6) Could not resolve host: astral.sh" };
      await mkdir(path.join(homeDir, ".local/bin"), { recursive: true });
      await writeFile(path.join(homeDir, ".local/bin/uv"), "#!/bin/sh\nexit 0\n");
      await chmod(path.join(homeDir, ".local/bin/uv"), 0o755);
      return { ok: true };
    },
    uvInstalls: 0,
  };
  return host;
}

async function writeMcp(home: string, servers: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

test("setup choices are safe first", () => {
  expect([...NETWORK_SETUP_CHOICES]).toEqual(["Not now", "Set it up"]);
  expect([...NETWORK_UPDATE_CHOICES]).toEqual(["Not now", "Update it"]);
  const question = networkSetupQuestion();
  expect(question.choices).toEqual(["Not now", "Set it up"]);
  expect(question.text).toBe(`Casper can set up its network server (casper-network-mcp ${NETWORK_SERVER.version}, about ${NETWORK_SERVER.approxMB} MB from pypi.org, installed with uv into ~/.casper/tools).\nIt starts read-only. Logins are asked per product the first time you use it.`);
});

test("the offer comes for Mist, Central, ClearPass and Wi-Fi questions, not for others", () => {
  for (const prompt of [
    "list the Mist APs at Branch-12", "Which Central sites are down?", "check clearpass auth", "why is the wifi slow on the APs", "add a WLAN",
    "rename the SSID", "bounce switch port 1/1/3", "an access point is offline", "Aruba gateway health", "what does Marvis say about Branch-12",
    "cppm endpoints for 10.1.1.5", "list my GreenLake devices", "Aruba Central inventory", "juniper mist webhooks", "is the Wi-Fi down at the site",
  ]) {
    expect(namesNetworkProduct(prompt)).toBe(true);
  }
  for (const prompt of [
    "add a test for parseConfig", "mistake in the readme", "the centralized logger", "switch to the main branch",
    // Web and code words: loose words count only next to a network word.
    "add central logging to the API", "refactor the central store", "add a mist effect to the hero image", "add a wifi icon to the settings page",
    "move this into a central place", "aruba beach photos for the travel blog",
  ]) {
    expect(namesNetworkProduct(prompt)).toBe(false);
  }
});

test("Not now installs nothing and isn't asked again", async () => {
  const host = await fakeSetupHost({ answers: ["1"] });
  expect(await shouldOfferNetworkSetup(host.homeDir, [])).toBe(true);
  expect(await runNetworkSetup(host, { explicit: false })).toBe("not-now");
  expect(host.installs).toEqual([]);
  expect(host.output).toContain("Not set up. Type /mcp setup network any time.");
  expect(await shouldOfferNetworkSetup(host.homeDir, [])).toBe(false);
  expect(JSON.parse(await readFile(path.join(host.homeDir, ".casper/network-setup.json"), "utf8"))).toMatchObject({ answer: "not-now" });
  expect(await networkSetupLine(host.homeDir, [])).toBe("network: not set up — /mcp setup network");
});

test("Enter (or any other answer) counts as Not now and isn't asked again", async () => {
  // The terminal turns Enter or unknown text into "no"; the offer must not come back every session.
  const host = await fakeSetupHost({ answers: ["no"] });
  expect(await runNetworkSetup(host, { explicit: false })).toBe("not-now");
  expect(host.installs).toEqual([]);
  expect(await shouldOfferNetworkSetup(host.homeDir, [])).toBe(false);

  const update = await fakeSetupHost({ answers: ["no"] });
  await update.installer!(pinned("0.0.9"), { homeDir: update.homeDir, ...update.install });
  await writeMcp(update.homeDir, { network: networkServerEntry(update.homeDir) });
  expect(await runNetworkUpdate(update, { explicit: false })).toBe("not-now");
  expect(await shouldOfferNetworkUpdate(update.homeDir, await update.configured())).toBeUndefined();
});

test("no uv: the setup question says so, shows uv's official installer, and 2 installs uv then sets the server up", async () => {
  const host = await fakeSetupHost({ answers: ["2"], uvMissing: true });
  expect(await runNetworkSetup(host, { explicit: false })).toBe("installed");
  expect(host.asked[0]).toContain("It needs uv, which isn't installed. Casper installs it first with uv's official installer:\n  curl -LsSf https://astral.sh/uv/install.sh | sh\n");
  expect(host.asked[0]).toEndWith("  1 Not now\n  2 Install uv, then set it up\n");
  expect(host.asked).toHaveLength(1);
  expect(host.uvInstalls).toBe(1);
  expect(host.installs).toEqual([NETWORK_SERVER.version]);
  expect(host.connected).toEqual([{ name: "network", writes: "off", remembered: true }]);
  expect(host.output).toContain("Network server ready (read-only).");
});

test("no uv: 1 installs nothing and is kept; a failed uv install says what to do and adds nothing", async () => {
  const no = await fakeSetupHost({ answers: ["1"], uvMissing: true });
  expect(await runNetworkSetup(no, { explicit: false })).toBe("not-now");
  expect(no.uvInstalls).toBe(0);
  expect(await shouldOfferNetworkSetup(no.homeDir, [])).toBe(false);

  const failed = await fakeSetupHost({ answers: ["2"], uvMissing: true, uvInstall: "fail" });
  expect(await runNetworkSetup(failed, { explicit: true })).toBe("failed");
  expect(failed.output).toContain("uv didn't install (curl: (6) Could not resolve host: astral.sh). Install it from docs.astral.sh/uv, then type /mcp setup network.");
  expect(failed.installs).toEqual([]);
  expect(await exists(path.join(failed.homeDir, ".casper/mcp.json"))).toBe(false);
});

test("one-shot never asks or installs", async () => {
  const host = await fakeSetupHost({ canAsk: false });
  expect(await runNetworkSetup(host, { explicit: true })).toBe("cant-ask");
  expect(host.output).toContain("Type /mcp setup network in the terminal");
  expect(host.asked).toEqual([]);
  expect(host.installs).toEqual([]);
  expect(await exists(path.join(host.homeDir, ".casper/mcp.json"))).toBe(false);
});

test("Set it up installs, adds the server and connects it remembered and read-only", async () => {
  const host = await fakeSetupHost({ answers: ["2"] });
  expect(await runNetworkSetup(host, { explicit: true })).toBe("installed");
  expect(host.installs).toEqual([NETWORK_SERVER.version]);
  const file = JSON.parse(await readFile(path.join(host.homeDir, ".casper/mcp.json"), "utf8"));
  expect(file.mcpServers.network).toEqual({ command: networkServerEntry(host.homeDir).command, args: [], env: {} });
  expect(host.connected).toEqual([{ name: "network", writes: "off", remembered: true }]);
  expect(host.output).toContain("Network server ready (read-only). Ask about Mist, Central or ClearPass; Casper asks for each login the first time.");
  expect(await shouldOfferNetworkSetup(host.homeDir, await host.configured())).toBe(false);
  expect(await networkSetupLine(host.homeDir, await host.configured())).toBeUndefined();
});

test("a failed install adds nothing", async () => {
  const host = await fakeSetupHost({ answers: ["2"], pipExit: 1 });
  expect(await runNetworkSetup(host, { explicit: true })).toBe("failed");
  expect(host.output).toContain("casper-network-mcp: the install failed.");
  expect(await exists(path.join(host.homeDir, ".casper/mcp.json"))).toBe(false);
  expect(host.connected).toEqual([]);
});

test("an existing 'network' entry is never overwritten", async () => {
  const home = await temp("casper-network-home-");
  const mine = { network: { command: "/opt/my-network-server", args: ["--site", "Branch-12"], env: {} } };
  await writeMcp(home, mine);
  const before = await readFile(path.join(home, ".casper/mcp.json"), "utf8");
  const host = await fakeSetupHost({ answers: ["2"], homeDir: home });
  expect(await runNetworkSetup(host, { explicit: true })).toBe("exists");
  expect(host.output).toContain("network is already in ~/.casper/mcp.json. Nothing changed.");
  expect(await readFile(path.join(home, ".casper/mcp.json"), "utf8")).toBe(before);
  expect(host.installs).toEqual([]);
  expect(host.connected).toEqual([]);
});

test("a server you added yourself (hpe-networking-mcp, or casper-network-mcp by hand) means no offer", async () => {
  const hpe = { name: "hpe", source: "x", cwd: "/", disabled: false, transport: { type: "stdio", command: "uv", args: ["run", "python", "mcp_servers/tool_router.py"], env: {} } } as MCPServerDefinition;
  const own = { name: "net", source: "x", cwd: "/", disabled: false, transport: { type: "stdio", command: "uvx", args: ["casper-network-mcp==0.1.0"], env: {} } } as MCPServerDefinition;
  const home = await temp("casper-network-home-");
  expect(await shouldOfferNetworkSetup(home, [hpe])).toBe(false);
  expect(await shouldOfferNetworkSetup(home, [own])).toBe(false);
});

test("a server you named 'network' yourself means no offer", async () => {
  const home = await temp("casper-network-home-");
  const mine = { name: "network", source: "x", cwd: "/", disabled: false, transport: { type: "stdio", command: "/opt/x", args: [], env: {} } } as MCPServerDefinition;
  expect(await shouldOfferNetworkSetup(home, [mine])).toBe(false);
  expect(await networkSetupLine(home, [mine])).toBeUndefined();
});

test("Casper's entry with its folder gone: /mcp says not installed, and 2 installs it again without touching mcp.json", async () => {
  const host = await fakeSetupHost({ answers: ["2"] });
  await writeMcp(host.homeDir, { network: networkServerEntry(host.homeDir) });
  const before = await readFile(path.join(host.homeDir, ".casper/mcp.json"), "utf8");
  expect(await networkSetupLine(host.homeDir, await host.configured())).toBe("network: not installed — /mcp setup network");
  expect(await runNetworkSetup(host, { explicit: true })).toBe("installed");
  expect(host.installs).toEqual([NETWORK_SERVER.version]);
  expect(await readFile(path.join(host.homeDir, ".casper/mcp.json"), "utf8")).toBe(before);
  expect(host.connected.map((item) => item.name)).toEqual(["network"]);
  expect(await networkSetupLine(host.homeDir, await host.configured())).toBeUndefined();
  // Set up already: says so and asks nothing.
  const again = await fakeSetupHost({ answers: ["2"], homeDir: host.homeDir });
  expect(await runNetworkSetup(again, { explicit: true })).toBe("exists");
  expect(again.asked).toEqual([]);
  expect(again.output).toContain(`The network server is already set up (casper-network-mcp ${NETWORK_SERVER.version}). /mcp connect network connects it.`);
});

test("nobody answering the setup question installs and remembers nothing", async () => {
  const host = await fakeSetupHost({ answers: [] });
  expect(await runNetworkSetup(host, { explicit: false })).toBe("not-now");
  expect(host.installs).toEqual([]);
  // Nothing is remembered either, so it can be offered again in a later session.
  expect(await exists(path.join(host.homeDir, ".casper/network-setup.json"))).toBe(false);
  expect(await exists(path.join(host.homeDir, ".casper/mcp.json"))).toBe(false);
});

test("a new pinned version asks once, updates in place and restarts; mcp.json unchanged", async () => {
  const host = await fakeSetupHost({ answers: ["2", "2"] });
  // Installed with an older pin, then Casper itself was updated.
  const older = await host.installer!(pinned("0.0.9"), { homeDir: host.homeDir, ...host.install });
  expect(older.ok).toBe(true);
  await writeMcp(host.homeDir, { network: networkServerEntry(host.homeDir) });
  const before = await readFile(path.join(host.homeDir, ".casper/mcp.json"), "utf8");
  const configured = await host.configured();
  expect(await shouldOfferNetworkUpdate(host.homeDir, configured)).toEqual({ from: "0.0.9", to: NETWORK_SERVER.version });
  expect(await networkSetupLine(host.homeDir, configured)).toBe(`network: update ready (0.0.9 → ${NETWORK_SERVER.version}) — /mcp setup network`);
  expect(await runNetworkUpdate(host, { explicit: false })).toBe("updated");
  expect(host.asked.at(-1)).toContain(`Casper's network server has an update (0.0.9 → ${NETWORK_SERVER.version}, about ${NETWORK_SERVER.approxMB} MB from pypi.org).\n  1 Not now\n  2 Update it\n`);
  expect(await installedVersion(host.homeDir, NETWORK_SERVER)).toBe(NETWORK_SERVER.version);
  expect(host.restarts).toEqual(["network"]);
  expect(await readFile(path.join(host.homeDir, ".casper/mcp.json"), "utf8")).toBe(before);
  expect(await shouldOfferNetworkUpdate(host.homeDir, configured)).toBeUndefined();
  expect(await runNetworkUpdate(host, { explicit: false })).toBe("current");
});

test("Not now on an update keeps the old version and doesn't ask again for that version", async () => {
  const host = await fakeSetupHost({ answers: ["1"] });
  await host.installer!(pinned("0.0.9"), { homeDir: host.homeDir, ...host.install });
  await writeMcp(host.homeDir, { network: networkServerEntry(host.homeDir) });
  const configured = await host.configured();
  expect(await runNetworkUpdate(host, { explicit: false })).toBe("not-now");
  expect(host.output).toContain("Not updated. The network server keeps 0.0.9. Type /mcp setup network to update.");
  expect(await installedVersion(host.homeDir, NETWORK_SERVER)).toBe("0.0.9");
  expect(host.restarts).toEqual([]);
  expect(await shouldOfferNetworkUpdate(host.homeDir, configured)).toBeUndefined();
  // /mcp still says it's there, and /mcp setup network still asks.
  expect(await networkSetupLine(host.homeDir, configured)).toBe(`network: update ready (0.0.9 → ${NETWORK_SERVER.version}) — /mcp setup network`);
  const explicit = await fakeSetupHost({ answers: ["2"], homeDir: host.homeDir });
  expect(await runNetworkSetup(explicit, { explicit: true })).toBe("updated");
  expect(await installedVersion(host.homeDir, NETWORK_SERVER)).toBe(NETWORK_SERVER.version);
});

test("a newer version installed by another Casper is kept: no 'update' that is really a downgrade", async () => {
  const host = await fakeSetupHost({ answers: ["2"] });
  await host.installer!(pinned("99.0.0"), { homeDir: host.homeDir, ...host.install });
  await writeMcp(host.homeDir, { network: networkServerEntry(host.homeDir) });
  const configured = await host.configured();
  expect(await shouldOfferNetworkUpdate(host.homeDir, configured)).toBeUndefined();
  expect(await networkSetupLine(host.homeDir, configured)).toBeUndefined();
  expect(await runNetworkUpdate(host, { explicit: false })).toBe("current");
  expect(await runNetworkSetup(host, { explicit: true })).toBe("exists");
  expect(host.asked).toEqual([]);
  expect(await installedVersion(host.homeDir, NETWORK_SERVER)).toBe("99.0.0");
});

test("a hand-added server pointing elsewhere is never updated", async () => {
  const host = await fakeSetupHost({ answers: ["2"] });
  await host.installer!(pinned("0.0.9"), { homeDir: host.homeDir, ...host.install });
  await writeMcp(host.homeDir, { network: { command: "/opt/casper-network-mcp/bin/casper-network-mcp", args: [], env: {} } });
  expect(await shouldOfferNetworkUpdate(host.homeDir, await host.configured())).toBeUndefined();
  expect(await runNetworkUpdate(host, { explicit: false })).toBe("current");
  expect(host.installs).toEqual(["0.0.9"]);
});

test("one-shot never asks about or installs an update", async () => {
  const host = await fakeSetupHost({ canAsk: false });
  await host.installer!(pinned("0.0.9"), { homeDir: host.homeDir, ...host.install });
  await writeMcp(host.homeDir, { network: networkServerEntry(host.homeDir) });
  expect(await runNetworkUpdate(host, { explicit: false })).toBe("cant-ask");
  expect(host.asked).toEqual([]);
  expect(await installedVersion(host.homeDir, NETWORK_SERVER)).toBe("0.0.9");
});

test("review: an update builds the new version while the old one runs and swaps the folders only while the server is stopped", async () => {
  const host = await fakeSetupHost({ answers: ["2"] });
  await host.installer!(pinned("0.0.9"), { homeDir: host.homeDir, ...host.install });
  await writeMcp(host.homeDir, { network: networkServerEntry(host.homeDir) });
  const staging = `${path.dirname(path.dirname(path.dirname(networkServerEntry(host.homeDir).command)))}.new`;
  const seen: string[] = [];
  host.restart = async (_name, whileStopped) => {
    seen.push(`stop: running ${await installedVersion(host.homeDir, NETWORK_SERVER)}, new one built ${await exists(staging)}`);
    await whileStopped?.();
    seen.push(`start: ${await installedVersion(host.homeDir, NETWORK_SERVER)}`);
  };
  expect(await runNetworkUpdate(host, { explicit: false })).toBe("updated");
  expect(seen).toEqual(["stop: running 0.0.9, new one built true", `start: ${NETWORK_SERVER.version}`]);
});

test("review: when the folders can't be swapped, the old version starts again and the person is told what to do", async () => {
  const host = await fakeSetupHost({ answers: ["2"] });
  await host.installer!(pinned("0.0.9"), { homeDir: host.homeDir, ...host.install });
  await writeMcp(host.homeDir, { network: networkServerEntry(host.homeDir) });
  const target = path.dirname(path.dirname(path.dirname(networkServerEntry(host.homeDir).command)));
  const started: string[] = [];
  host.restart = async (_name, whileStopped) => {
    // Something holds the folder (as a running program does on Windows): the first rename fails.
    await mkdir(path.join(`${target}.old`, "busy"), { recursive: true });
    try { await whileStopped?.(); } finally { started.push(String(await installedVersion(host.homeDir, NETWORK_SERVER))); }
  };
  expect(await runNetworkUpdate(host, { explicit: false })).toBe("failed");
  expect(started).toEqual(["0.0.9"]);
  expect(host.output).toContain("Casper couldn't swap in the new version (its files are in use). The network server keeps 0.0.9 and is running again. Close any other Casper window, then type /mcp setup network.");
  expect(await installedVersion(host.homeDir, NETWORK_SERVER)).toBe("0.0.9");
  expect(await exists(`${target}.new`)).toBe(false);
});

test("review: restartAfterCalls runs whileStopped with the server stopped, then starts it again", async () => {
  const { MCPManager } = await import("../src/mcp/manager");
  const home = await temp("casper-network-restart-");
  const entry = path.join(home, "bin/server");
  await mkdir(path.dirname(entry), { recursive: true });
  const calls = path.join(home, "calls.log");
  await writeFile(entry, `#!/bin/sh\nFAKE_CALLS_FILE='${calls}' exec "${process.execPath}" "${path.join(import.meta.dir, "fixtures/fake-network-mcp.ts")}" "$@"\n`);
  await chmod(entry, 0o755);
  const definition: MCPServerDefinition = { name: "network", source: path.join(home, ".casper/mcp.json"), scope: "user", cwd: home, disabled: false,
    transport: { type: "stdio", command: entry, args: [], env: {} } };
  const manager = new MCPManager({ servers: [definition], diagnostics: [] }, { timeoutMs: 15_000, homeDir: home });
  cleanup.push(() => manager.close());
  await manager.connect("network");
  const starts = async () => (await readFile(calls, "utf8")).split("\n").filter((line) => line.startsWith("start ")).length;
  const before = await starts();
  let during: string | undefined;
  await manager.restartAfterCalls("network", { whileStopped: async () => { during = manager.status().find((item) => item.name === "network")?.state; } });
  expect(during).toBe("disconnected");
  expect(await starts()).toBe(before + 1);
  expect(manager.status().find((item) => item.name === "network")?.state).toBe("ready");
  // A failed swap still starts the server again, then says why.
  await expect(manager.restartAfterCalls("network", { whileStopped: async () => { throw new Error("in use"); } })).rejects.toThrow("in use");
  expect(manager.status().find((item) => item.name === "network")?.state).toBe("ready");
});

// --- In the app: the real exact-answer channel ---------------------------------------------------

async function appFixture() {
  const root = await temp("casper-network-app-");
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await mkdir(path.join(home, ".casper"), { recursive: true });
  return { home, project };
}

/** An interactive session: `lines` are typed at each prompt (with any type-ahead), `answers` at each numbered box. */
async function session(home: string, project: string, lines: string[], answers: string[] = [], options: { interactive?: boolean; onApp?: (app: CasperApp) => void } = {}) {
  let turns = 0;
  const runtime: AgentRuntime = {
    async start(start: RuntimeStartOptions) {
      return {
        setTools: () => {}, prompt: async () => { turns++; },
        abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: start.cwd, isStreaming: false }),
      };
    },
    async dispose() {},
  };
  const install = await fakeInstall();
  const input = new PassThrough();
  let output = "";
  const pending = [...lines];
  const app = new CasperApp({
    runtimeFactory: () => runtime, input, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: () => discoverMCPConfiguration({ projectRoot: project, homeDir: home, platform: "linux" }),
    networkSeams: { install: { env: install.env, run: install.run } },
    output: { write: (text) => {
      output += text;
      if (text === "> ") queueMicrotask(() => input.write(`${pending.shift() ?? "/exit"}\n`));
      if (/Type [\d, ]*\d or \d: $/.test(text)) queueMicrotask(() => input.write(`${answers.shift() ?? "1"}\n`));
    } },
  });
  cleanup.push(() => app.close());
  options.onApp?.(app);
  if (options.interactive === false) {
    for (const line of lines) await app.runOnce(line, project);
  } else {
    await app.runInteractive(project);
  }
  return { output, app, turns: () => turns, installs: install.calls };
}

test("app: the first Mist question offers setup once; a 2 typed ahead is discarded; the AI's ask channel is never used; 1 is remembered across sessions", async () => {
  const { home, project } = await appFixture();
  let asks = 0;
  const first = await session(home, project, ["list the Mist APs at Branch-12\n2", "list the Mist APs again"], ["1"], { onApp: (app) => {
    const ask = app.terminal.ask.bind(app.terminal);
    app.terminal.ask = (...args: Parameters<typeof ask>) => { asks++; return ask(...args); };
  } });
  expect(asks).toBe(0);
  expect(first.output).toContain("[input] Discarded 1 line(s) entered before this question appeared.");
  expect(first.output).toContain("Casper can set up its network server (casper-network-mcp");
  expect(first.output).toContain("  1 Not now\n  2 Set it up\nType 1 or 2: ");
  expect(first.output).toContain("Not set up. Type /mcp setup network any time.");
  expect(first.output.split("Casper can set up its network server").length - 1).toBe(1);
  expect(first.installs).toEqual([]);
  expect(first.turns()).toBe(2);
  const second = await session(home, project, ["which ClearPass roles exist?", "/mcp"]);
  expect(second.output).not.toContain("Casper can set up its network server");
  expect(second.output).toContain("network: not set up — /mcp setup network");
});

test("app: /mcp setup network → 2 installs, adds and connects it remembered with writes off", async () => {
  const { home, project } = await appFixture();
  const { output, app, installs } = await session(home, project, ["/mcp setup network"], ["2"]);
  expect(installs.some((args) => args.includes("--require-hashes"))).toBe(true);
  expect(output).toContain("Network server ready (read-only). Ask about Mist, Central or ClearPass; Casper asks for each login the first time.");
  expect(app.mcp!.status().find((status) => status.name === "network")).toMatchObject({ state: "ready", consent: "remembered", writes: "off" });
  const file = JSON.parse(await readFile(path.join(home, ".casper/mcp.json"), "utf8"));
  expect(file.mcpServers.network.command).toBe(networkServerEntry(home).command);
  // The next session connects it on its own and never offers setup again.
  const next = await session(home, project, ["show the Mist sites", "/mcp"]);
  expect(next.output).not.toContain("Casper can set up its network server");
  expect(next.output).toContain("  Remembered: connects on its own, with writes off.");
});

test("app: a one-shot run never asks, installs or offers setup", async () => {
  const { home, project } = await appFixture();
  const { output, installs } = await session(home, project, ["/mcp setup network", "list the Mist APs"], [], { interactive: false });
  expect(output).toContain("Type /mcp setup network in the terminal");
  expect(output).not.toContain("Casper can set up its network server");
  expect(installs).toEqual([]);
  expect(await exists(path.join(home, ".casper/mcp.json"))).toBe(false);
});

test("app: an older installed server is asked about once, before the first request's turn; a one-shot run never asks", async () => {
  const { home, project } = await appFixture();
  const install = await fakeInstall();
  const { installLockedSpec } = await import("../src/security/install");
  expect((await installLockedSpec(pinned("0.0.9"), { homeDir: home, env: install.env, run: install.run })).ok).toBe(true);
  await writeMcp(home, { network: networkServerEntry(home) });
  const question = `Casper's network server has an update (0.0.9 → ${NETWORK_SERVER.version}`;
  const first = await session(home, project, ["add a test for parseConfig", "rename a variable"], ["1"]);
  expect(first.output.split(question).length - 1).toBe(1);
  const prompts = [...first.output.matchAll(/> /g)].map((match) => match.index!);
  // Asked after the first request was typed and before its turn ended (the next prompt).
  expect(first.output.indexOf(question)).toBeGreaterThan(prompts[0]!);
  expect(first.output.indexOf(question)).toBeLessThan(prompts[1]!);
  expect(first.turns()).toBe(2);
  // Not now is kept for that version: a later session doesn't ask.
  const next = await session(home, project, ["add a test"]);
  expect(next.output).not.toContain(question);

  const other = await appFixture();
  await installLockedSpec(pinned("0.0.9"), { homeDir: other.home, env: install.env, run: install.run });
  await writeMcp(other.home, { network: networkServerEntry(other.home) });
  const once = await session(other.home, other.project, ["add a test for parseConfig"], [], { interactive: false });
  expect(once.output).not.toContain(question);
  expect(await installedVersion(other.home, NETWORK_SERVER)).toBe("0.0.9");
});
