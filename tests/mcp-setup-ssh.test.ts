import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverMCPConfiguration, type MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import {
  defaultServerName, isSshHost, parseSshSetup, runSshSetup, sshConfigHosts, sshEntry, type SshSetupHost,
} from "../src/mcp/ssh/setup";
import { removeTempDir } from "./support/temp-dir";

/**
 * /mcp setup ssh. Nothing here runs ssh or reaches another machine: when a test connects, the written entry's `ssh`
 * is swapped for Bun running tests/fixtures/fake-ssh-mcp.ts with the same words, a fake MCP server over stdio.
 */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const fixture = path.join(import.meta.dir, "fixtures/fake-ssh-mcp.ts");
const exists = (file: string) => stat(file).then(() => true, () => false);
const COMMAND = "python3 -m lab_server mcp";
const SSH_CONFIG = "Host *\n  ServerAliveInterval 30\nHost lab-box lab-two # the lab\n  HostName 192.0.2.5\nHost=bastion\nHost !nope web-?\n";

interface FakeHost extends SshSetupHost { output: string; asked: string[]; connected: string[]; manager?: MCPManager; calls: string }

/** The setup's host, as a fake: `answers` are typed digits. `connect: "record"` only records the name (or fails with
 * `connectError`); `connect: "fake-server"` connects the written entry for real, with the fake server in place of ssh. */
async function setupHost(options: {
  answers?: string[]; sshConfig?: string; canAsk?: boolean; connectError?: string; mcp?: Record<string, unknown>;
  connect?: "record" | "fake-server"; env?: Record<string, string>;
} = {}): Promise<FakeHost> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "casper-ssh-home-"));
  cleanup.push(() => removeTempDir(homeDir));
  if (options.sshConfig !== undefined) {
    await mkdir(path.join(homeDir, ".ssh"), { recursive: true });
    await writeFile(path.join(homeDir, ".ssh/config"), options.sshConfig);
  }
  if (options.mcp) {
    await mkdir(path.join(homeDir, ".casper"), { recursive: true });
    await writeFile(path.join(homeDir, ".casper/mcp.json"), JSON.stringify({ mcpServers: options.mcp }));
  }
  const answers = [...options.answers ?? []];
  const configured = async () => (await discoverMCPConfiguration({ projectRoot: homeDir, homeDir, platform: "linux" })).servers;
  const host: FakeHost = {
    homeDir, output: "", asked: [], connected: [], calls: path.join(homeDir, "calls.log"),
    canAsk: () => options.canAsk ?? true,
    write: (text) => { host.output += text; },
    chooseAnswer: async (preview, _question, choices) => {
      host.asked.push(preview);
      const answer = answers.shift();
      return answer === undefined ? undefined : choices.includes(answer) ? answer : "no";
    },
    configured,
    connect: async (name) => {
      host.connected.push(name);
      if (options.connect !== "fake-server") return options.connectError ? { ok: false, message: options.connectError } : { ok: true };
      const written = (await configured()).find((definition) => definition.name === name)!;
      if (written.transport.type !== "stdio" || written.transport.command !== "ssh") throw new Error("not an ssh entry");
      const swapped: MCPServerDefinition = { ...written, transport: { ...written.transport, command: process.execPath,
        args: [fixture, ...written.transport.args], env: { ...written.transport.env, FAKE_CALLS_FILE: host.calls, ...options.env } } };
      const manager = new MCPManager({ servers: [swapped], diagnostics: [] }, { timeoutMs: 15_000, homeDir });
      cleanup.push(() => manager.close());
      host.manager = manager;
      await manager.connect(name);
      const status = manager.status().find((entry) => entry.name === name);
      return status?.state === "ready" ? { ok: true } : { ok: false, ...(status?.error ? { message: status.error } : {}) };
    },
    access: (name) => host.manager?.policy(name).access,
  };
  return host;
}
const mcpFile = async (home: string) => JSON.parse(await readFile(path.join(home, ".casper/mcp.json"), "utf8")).mcpServers;

test("hosts come from ~/.ssh/config without patterns; a host ssh would read as an option is never one", async () => {
  expect(await sshConfigHosts((await setupHost({ sshConfig: SSH_CONFIG })).homeDir)).toEqual(["lab-box", "lab-two", "bastion"]);
  expect(await sshConfigHosts((await setupHost()).homeDir)).toEqual([]);
  for (const good of ["lab-box", "admin@192.0.2.10", "192.0.2.10", "bad"]) expect(isSshHost(good)).toBe(true);
  for (const bad of ["-oProxyCommand=touch /tmp/x", "-v", "lab;rm", "lab|x", "", "lab box"]) expect(isSshHost(bad)).toBe(false);
});

test("the entry is ssh with no prompts, -- before the host, the command as one word, and the ssh agent passed on", () => {
  expect(sshEntry("lab-box", COMMAND)).toEqual({
    command: "ssh", args: ["-T", "-o", "BatchMode=yes", "--", "lab-box", COMMAND], env: { SSH_AUTH_SOCK: "${SSH_AUTH_SOCK:-}" },
  });
  expect(defaultServerName("lab-box")).toBe("lab-box");
  expect(defaultServerName("admin@192.0.2.10")).toBe("192.0.2.10");
  expect(defaultServerName("admin@[2001:db8::1]")).toBe("2001-db8--1");
});

test("the typed line: [--name <name>] [host] [command …], the command kept as typed", () => {
  expect(parseSshSetup("")).toEqual({});
  expect(parseSshSetup("  lab-box ")).toEqual({ sshHost: "lab-box" });
  expect(parseSshSetup("lab-box cd /opt/lab &&  python3 -m lab_server mcp")).toEqual({ sshHost: "lab-box", command: "cd /opt/lab &&  python3 -m lab_server mcp" });
  expect(parseSshSetup("--name lab lab-box python3 x")).toEqual({ name: "lab", sshHost: "lab-box", command: "python3 x" });
  expect(parseSshSetup("--name")).toEqual({ error: "usage" });
  // A dash after the host belongs to the remote command.
  expect(parseSshSetup("lab-box --read-only")).toEqual({ sshHost: "lab-box", command: "--read-only" });
});

test("pick a host, then Casper says the one line to type for the command (it has no text box)", async () => {
  const host = await setupHost({ sshConfig: SSH_CONFIG, answers: ["2"] });
  expect(await runSshSetup(host)).toBe("needs-command");
  expect(host.asked).toHaveLength(1);
  expect(host.asked[0]).toBe("Casper can add an MCP server that runs on another machine. It starts the server there over ssh, with writes off.\n"
    + "Which ssh host?\n  1 Not now\n  2 lab-box\n  3 lab-two\n  4 bastion\n  5 Type a host\n");
  expect(host.output).toBe("Now type the command that starts the MCP server on lab-box: /mcp setup ssh lab-box <command>, "
    + "such as /mcp setup ssh lab-box python3 -m my_server mcp\n");
  expect(await exists(path.join(host.homeDir, ".casper/mcp.json"))).toBe(false);
});

test("host and command typed: the name question shows what is written, 2 writes it and connects with writes off", async () => {
  const host = await setupHost({ answers: ["2"], connect: "fake-server" });
  expect(await runSshSetup(host, { sshHost: "lab-box", command: COMMAND })).toBe("added");
  expect(host.asked).toEqual(["Casper adds this to ~/.casper/mcp.json and connects it with writes off:\n"
    + `  ssh lab-box ${COMMAND}\nName it?\n  1 Not now\n  2 lab-box\n  3 Type a name\n`]);
  expect((await mcpFile(host.homeDir))["lab-box"]).toEqual(sshEntry("lab-box", COMMAND));
  expect(host.connected).toEqual(["lab-box"]);
  // The fake server got exactly ssh's words, its access_check ran, and writes are off.
  const log = (await readFile(host.calls, "utf8")).split("\n").filter(Boolean);
  expect(log[0]).toBe(`start ${JSON.stringify(["-T", "-o", "BatchMode=yes", "--", "lab-box", COMMAND])}`);
  expect(log).toContain("call access_check {}");
  expect(host.manager!.status().find((entry) => entry.name === "lab-box")?.writes).toBe("off");
  expect(host.output).toBe("lab-box ready (writes off, ssh lab-box, login: read-only (checked)). /mcp writes lab-box lets changes through.\n");
});

test("a server with no access_check connects too; --name skips the name question", async () => {
  const host = await setupHost({ connect: "fake-server", env: { FAKE_NO_ACCESS: "1" } });
  expect(await runSshSetup(host, { name: "lab", sshHost: "admin@192.0.2.10", command: COMMAND })).toBe("added");
  expect(host.asked).toEqual([]);
  expect((await mcpFile(host.homeDir)).lab.args).toEqual(["-T", "-o", "BatchMode=yes", "--", "admin@192.0.2.10", COMMAND]);
  expect((await readFile(host.calls, "utf8"))).not.toContain("call access_check");
  expect(host.output).toBe("lab ready (writes off, ssh admin@192.0.2.10, access not checked). /mcp writes lab lets changes through.\n");
});

test("1 (or nobody answering) adds nothing; Type a host and Type a name say the line to type", async () => {
  for (const answers of [["1"], ["no"], []]) {
    const host = await setupHost({ sshConfig: SSH_CONFIG, answers });
    expect(await runSshSetup(host)).toBe("not-now");
    expect(host.output).toBe("Nothing added. Type /mcp setup ssh any time.\n");
    const named = await setupHost({ answers });
    expect(await runSshSetup(named, { sshHost: "lab-box", command: COMMAND })).toBe("not-now");
    expect(await exists(path.join(named.homeDir, ".casper/mcp.json"))).toBe(false);
  }
  const typeHost = await setupHost({ answers: ["2"] });
  expect(await runSshSetup(typeHost)).toBe("not-now");
  expect(typeHost.asked[0]).toEndWith("Which ssh host?\n  1 Not now\n  2 Type a host\n");
  expect(typeHost.output).toBe("Type /mcp setup ssh <host> <command>, such as /mcp setup ssh admin@192.0.2.10 python3 -m my_server mcp\n");
  const typeName = await setupHost({ answers: ["3"] });
  expect(await runSshSetup(typeName, { sshHost: "lab-box", command: COMMAND })).toBe("not-now");
  expect(typeName.output).toBe(`Type /mcp setup ssh --name <name> lab-box ${COMMAND}\n`);
  expect(await exists(path.join(typeName.homeDir, ".casper/mcp.json"))).toBe(false);
});

test("/mcp setup ssh <host> skips the host question", async () => {
  const host = await setupHost({ sshConfig: SSH_CONFIG });
  expect(await runSshSetup(host, { sshHost: "lab-two" })).toBe("needs-command");
  expect(host.asked).toEqual([]);
  expect(host.output).toContain("/mcp setup ssh lab-two <command>");
});

test("one-shot runs say what to type; a bad host or name changes nothing", async () => {
  const oneShot = await setupHost({ canAsk: false });
  expect(await runSshSetup(oneShot, { sshHost: "lab-box", command: COMMAND })).toBe("cant-ask");
  expect(oneShot.asked).toEqual([]);
  expect(oneShot.output).toBe("This run can't ask you. Run casper and type /mcp setup ssh to add a server that runs over ssh.\n");
  for (const sshHost of ["-oProxyCommand=touch /tmp/x", "lab;rm"]) {
    const bad = await setupHost();
    expect(await runSshSetup(bad, { sshHost, command: COMMAND })).toBe("failed");
    expect(bad.output).toBe("That isn't an ssh host name (one that starts with - is never used). Nothing changed.\n");
    expect(await exists(path.join(bad.homeDir, ".casper/mcp.json"))).toBe(false);
  }
  const badName = await setupHost();
  expect(await runSshSetup(badName, { name: "../x", sshHost: "lab-box", command: COMMAND })).toBe("failed");
  expect(badName.output).toBe("A name is letters, digits, dot, dash or underscore, up to 64. Nothing changed.\n");
});

test("a name already in ~/.casper/mcp.json is kept; one that didn't start says what to check", async () => {
  const taken = await setupHost({ answers: ["2"], mcp: { "lab-box": { command: "/opt/other/server", args: [] } } });
  expect(await runSshSetup(taken, { sshHost: "lab-box", command: COMMAND })).toBe("exists");
  expect(taken.output).toBe("lab-box is already in ~/.casper/mcp.json. Nothing changed.\n");
  expect((await mcpFile(taken.homeDir))["lab-box"].command).toBe("/opt/other/server");
  const down = await setupHost({ answers: ["2"], connectError: "Permission denied (publickey)" });
  expect(await runSshSetup(down, { sshHost: "lab-box", command: COMMAND })).toBe("failed");
  expect(down.output).toBe("lab-box is added (ssh lab-box) but didn't start: Permission denied (publickey).\n"
    + "Check that `ssh lab-box` logs in with no password prompt and that the command starts the server there, then type /mcp connect lab-box.\n");
});
