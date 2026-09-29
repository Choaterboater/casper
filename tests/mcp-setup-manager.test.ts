import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityBroker, type ConfirmCapability } from "../src/capabilities/broker";
import type { MCPServerDefinition } from "../src/mcp/config";
import { ConsentStore } from "../src/mcp/consent";
import { MCPManager, type MCPManagerOptions } from "../src/mcp/manager";

const network = path.join(import.meta.dir, "fixtures/mcp-network-server.ts");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-setup-manager-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function server(name: string, env: Record<string, string>, args: string[] = [], scope: MCPServerDefinition["scope"] = "user"): MCPServerDefinition {
  return { name, source: "/home/u/.claude.json", scope, cwd: process.cwd(), disabled: false,
    transport: { type: "stdio", command: process.execPath, args: [network, ...args], env } };
}
function manager(servers: MCPServerDefinition[], options: MCPManagerOptions = {}) {
  const created = new MCPManager({ servers, diagnostics: [] }, { timeoutMs: 5000, ...options });
  cleanup.push(() => created.close());
  return created;
}
async function envOf(mcp: MCPManager, name: string) {
  const raw = await mcp.call(name, "get_env", {}) as { content: { text: string }[] };
  return JSON.parse(raw.content[0]!.text) as { argv: string[]; env: Record<string, string> };
}
const statusOf = (mcp: MCPManager, name: string) => mcp.status().find((status) => status.name === name)!;
const ids = (broker: CapabilityBroker, query: string) => broker.search(query, 10).map((capability) => capability.name);

test("a remembered server connects on the next start without asking, with writes off and its write tools hidden", async () => {
  const home = await tempDir();
  const definition = server("lab", { FIXTURE_MODE: "access-bad" });
  const store = new ConsentStore(home);
  await store.load();
  const first = manager([definition], { consent: store });
  expect(statusOf(first, "lab")).toMatchObject({ approved: false, consent: "none" });
  await first.connect("lab");
  expect(await first.remember("lab")).toEqual({ remembered: true });
  expect(statusOf(first, "lab").consent).toBe("remembered");
  expect((await stat(store.file)).mode & 0o777).toBe(0o600);
  await first.close();

  const again = new ConsentStore(home);
  await again.load();
  const second = manager([definition], { consent: again });
  expect(statusOf(second, "lab")).toMatchObject({ approved: true, consent: "remembered", writes: "off", state: "disconnected" });
  const broker = new CapabilityBroker(second, undefined, { writesGate: true });
  await broker.prepare("status");
  expect(statusOf(second, "lab").state).toBe("ready");
  expect(ids(broker, "status")).toEqual(["get_status"]);
  expect(ids(broker, "config")).toEqual([]);
  await expect(broker.invoke("mcp:lab:set_config", {})).rejects.toThrow("Not executed (lab writes are off. Only the user can turn them on with /mcp writes lab.)");
  // /mcp forget drops the record: the next start asks again.
  expect(await second.forget("lab")).toBe(true);
  const third = new ConsentStore(home);
  await third.load();
  expect(statusOf(manager([definition], { consent: third }), "lab")).toMatchObject({ approved: false, consent: "none" });
});

test("a changed definition is not approved and says so; a project server is never approved from a record", async () => {
  const home = await tempDir();
  const store = new ConsentStore(home);
  await store.load();
  await store.remember(server("lab", { FIXTURE_MODE: "access-bad", SITE: "one" }));
  const changed = manager([server("lab", { FIXTURE_MODE: "access-bad", SITE: "two" })], { consent: store });
  expect(statusOf(changed, "lab")).toMatchObject({ approved: false, consent: "changed" });
  const project = manager([server("lab", { FIXTURE_MODE: "access-bad", SITE: "one" }, [], "project")], { consent: store });
  expect(statusOf(project, "lab")).toMatchObject({ approved: false, consent: "none" });
  expect(project.rememberBlock("lab")).toBe("Not remembered: lab comes from the project, so Casper asks each time.");
});

test("hpe-networking-mcp starts with every read-only pin even when the user turned a gate on; writes on drops them, off puts them back", async () => {
  const mcp = manager([server("hpe", { FIXTURE_MODE: "hpe-router", FIXTURE_ENV_DUMP: "1", HPE_MCP_CENTRAL_WRITES: "1" })]);
  await mcp.connect("hpe");
  const pinned = await envOf(mcp, "hpe");
  expect(pinned.env).toMatchObject({
    HPE_MCP_ACCESS_PROFILE: "safe-read-only", HPE_MCP_READONLY: "1", HPE_MCP_PRODUCT_ACCESS: "read-only",
    HPE_MCP_CENTRAL_WRITES: "0", HPE_MCP_MIST_WRITES: "0", HPE_MCP_AOS8_WRITES: "0",
  });
  // Nothing from the server confirmed the pins yet.
  expect(statusOf(mcp, "hpe").preset?.lines[0]).toStartWith("preset: hpe-networking-mcp (read-only pins sent, not confirmed: HPE_MCP_ACCESS_PROFILE=safe-read-only");
  await mcp.setWrites("hpe", true);
  expect(statusOf(mcp, "hpe")).toMatchObject({ writes: "on", state: "ready" });
  expect(mcp.writesOn()).toEqual(["hpe"]);
  expect((await envOf(mcp, "hpe")).env).toEqual({ HPE_MCP_CENTRAL_WRITES: "1" });
  await mcp.setWrites("hpe", false);
  expect(mcp.writesOn()).toEqual([]);
  expect((await envOf(mcp, "hpe")).env.HPE_MCP_CENTRAL_WRITES).toBe("0");
});

test("centralmcp and ClearPass get their read-only settings; grafana gets --disable-write once, also after a reconnect", async () => {
  const mcp = manager([
    server("aruba-central", { FIXTURE_MODE: "access-bad", FIXTURE_ENV_DUMP: "1", CENTRALMCP_READONLY: "0" }),
    server("clearpass", { FIXTURE_MODE: "access-bad", FIXTURE_ENV_DUMP: "1", CLEARPASS_HOST: "cppm.example.net" }),
    server("grafana", { FIXTURE_MODE: "access-bad", FIXTURE_ENV_DUMP: "1" }, ["mcp-grafana"]),
  ]);
  for (const name of ["aruba-central", "clearpass", "grafana"]) await mcp.connect(name);
  expect((await envOf(mcp, "aruba-central")).env.CENTRALMCP_READONLY).toBe("1");
  expect((await envOf(mcp, "clearpass")).env.CLEARPASS_READ_ONLY).toBe("true");
  expect((await envOf(mcp, "grafana")).argv).toEqual(["mcp-grafana", "--disable-write"]);
  await mcp.disconnect("grafana");
  await mcp.connect("grafana");
  expect((await envOf(mcp, "grafana")).argv).toEqual(["mcp-grafana", "--disable-write"]);
});

test("a server recognised only by its tool list is started once more with the preset's pins", async () => {
  const log = path.join(await tempDir(), "calls.log");
  const mcp = manager([server("router", { FIXTURE_MODE: "hpe-router", FIXTURE_ENV_DUMP: "1", FIXTURE_CALLS_FILE: log })]);
  await mcp.connect("router");
  expect(statusOf(mcp, "router")).toMatchObject({ state: "ready", preset: { id: "hpe-networking-mcp" } });
  expect((await envOf(mcp, "router")).env).toMatchObject({ HPE_MCP_ACCESS_PROFILE: "safe-read-only", HPE_MCP_READONLY: "1" });
  // The restart is Casper's own: it never counts as a failed start.
  expect(statusOf(mcp, "router").error).toBeUndefined();
});

test("a read-only login (access_check) hides every non-read tool, refuses them, tells the model, and can't turn writes on", async () => {
  const mcp = manager([server("aruba", { FIXTURE_MODE: "access-ro" })]);
  const confirmed: string[] = [];
  const broker = new CapabilityBroker(mcp, async (call) => { confirmed.push(call.capability.id); return true; });
  await mcp.connect("aruba");
  expect(statusOf(mcp, "aruba").access).toBe("login: read-only (checked)");
  expect(ids(broker, "config")).toEqual([]);
  expect(ids(broker, "status")).toEqual(["get_status"]);
  const tools = await broker.prepare("set config");
  expect(tools.map((tool) => tool.description).join("\n")).not.toContain("set_config");
  expect(tools.find((tool) => tool.name === "find_capability")!.description).toContain("aruba: login is read-only. Write tools are hidden. Don't plan changes on it.");
  expect(JSON.stringify(broker.list())).not.toContain("set_config");
  await expect(broker.invoke("mcp:aruba:set_config", {})).rejects.toThrow("Not executed (aruba login is read-only.)");
  expect(confirmed).toEqual([]);
  await expect(mcp.setWrites("aruba", true)).rejects.toThrow("This login is read-only (access_check). Writes can't be turned on here.");
});

test("a login the server reports as read-write loosens nothing, and bad or slow answers are 'access not checked'", async () => {
  const dir = await tempDir();
  const log = (name: string) => path.join(dir, `${name}.log`);
  const mcp = manager([
    server("rw", { FIXTURE_MODE: "access-rw" }),
    server("bad", { FIXTURE_MODE: "access-bad", FIXTURE_CALLS_FILE: log("bad") }),
    server("slow", { FIXTURE_MODE: "access-slow" }),
  ], { connectTimeoutMs: 5000, callTimeoutMs: 800 });
  const confirmed: string[] = [];
  const broker = new CapabilityBroker(mcp, async (call) => { confirmed.push(call.capability.id); return true; });
  for (const name of ["rw", "bad", "slow"]) await mcp.connect(name);
  expect(statusOf(mcp, "rw").access).toBe("login: can make changes (checked)");
  expect(statusOf(mcp, "bad").access).toBe("access not checked");
  expect(statusOf(mcp, "slow")).toMatchObject({ access: "access not checked", state: "ready" });
  await broker.invoke("mcp:rw:set_config", {});
  expect(confirmed).toEqual(["mcp:rw:set_config"]);
  expect(ids(broker, "config").sort()).toEqual(["set_config", "set_config", "set_config"]);
  // Once per connection, however many tasks run.
  for (let task = 0; task < 3; task++) await broker.prepare("status");
  const calls = (await readFile(log("bad"), "utf8")).trim().split("\n").filter((line) => line.startsWith("access_check"));
  expect(calls).toHaveLength(1);
});

test("the server's own gate report turns 'pins sent, not confirmed' into 'pinned'", async () => {
  const mcp = manager([server("hpe", { FIXTURE_MODE: "access-ro", HPE_MCP_CENTRAL_WRITES: "1" })]);
  await mcp.connect("hpe");
  const lines = statusOf(mcp, "hpe").preset!.lines;
  expect(lines[0]).toStartWith("preset: hpe-networking-mcp (read-only pinned: ");
  expect(lines).toContain("Looks different from the hpe-networking-mcp preset. Pins kept, and its extra checks still apply.");
});

test("junos: commits are hidden while writes are off, only show commands run, and the show opt-in skips the question", async () => {
  const log = path.join(await tempDir(), "calls.log");
  const mcp = manager([server("junos", { FIXTURE_MODE: "junos", FIXTURE_CALLS_FILE: log }, ["jmcp.py"])]);
  const boxes: { id: string; note?: string; noPreview?: boolean }[] = [];
  const confirm: ConfirmCapability = async (call) => {
    boxes.push({ id: call.capability.id, note: call.plan.hint?.executeNote, noPreview: call.plan.hint?.noPreview });
    return true;
  };
  const broker = new CapabilityBroker(mcp, confirm, { writesGate: true });
  await mcp.connect("junos");
  expect(statusOf(mcp, "junos").preset?.lines).toContain("Can't pin read-only for this server (it has no read-only setting). Write tools are hidden in Casper only.");
  expect(ids(broker, "load commit config")).not.toContain("load_and_commit_config");
  await expect(broker.invoke("mcp:junos:load_and_commit_config", {})).rejects.toThrow("Not executed (junos writes are off.");
  await expect(broker.invoke("mcp:junos:execute_junos_command", { router_name: "r1", command: "request system reboot" }))
    .rejects.toThrow("Not executed (Junos writes are off; only show commands run.)");
  await broker.invoke("mcp:junos:execute_junos_command", { router_name: "r1", command: "show interfaces terse" });
  expect(boxes.map((box) => box.id)).toEqual(["mcp:junos:execute_junos_command"]);
  mcp.setShowOptIn("junos", true);
  await broker.invoke("mcp:junos:execute_junos_command", { router_name: "r1", command: "show interfaces terse" });
  expect(boxes).toHaveLength(1);
  for (const command of ["sh ver", "show configuration | save /var/tmp/x", "show version; request system reboot", "show version\nrequest system reboot"]) {
    await expect(broker.invoke("mcp:junos:execute_junos_command", { router_name: "r1", command })).rejects.toThrow("Not executed (Junos writes are off; only show commands run.)");
  }
  await mcp.setWrites("junos", true);
  await broker.invoke("mcp:junos:execute_junos_command", { router_name: "r1", command: "sh ver" });
  await broker.invoke("mcp:junos:load_and_commit_config", {});
  expect(boxes.slice(1)).toEqual([
    { id: "mcp:junos:execute_junos_command", note: undefined, noPreview: undefined },
    { id: "mcp:junos:load_and_commit_config", note: "load_and_commit_config commits right away. No preview and no auto-rollback.", noPreview: true },
  ]);
  const sent = (await readFile(log, "utf8")).trim().split("\n").map((line) => line.split(" ")[0]);
  expect(sent).toEqual(["execute_junos_command", "execute_junos_command", "execute_junos_command", "load_and_commit_config"]);
  expect(() => mcp.setShowOptIn("missing", true)).toThrow();
});

test("writes turned off while an approval box is open: the yes no longer runs the change", async () => {
  const log = path.join(await tempDir(), "calls.log");
  const mcp = manager([server("lab", { FIXTURE_MODE: "access-bad", FIXTURE_CALLS_FILE: log })]);
  const broker = new CapabilityBroker(mcp, async () => { await mcp.setWrites("lab", false); return true; }, { writesGate: true });
  await mcp.connect("lab");
  await mcp.setWrites("lab", true);
  await expect(broker.invoke("mcp:lab:set_config", {})).rejects.toThrow("Not executed (lab writes are off.");
  expect(await readFile(log, "utf8")).not.toContain("set_config");
});

test("/mcp reload with a changed definition turns writes off and drops the approval", async () => {
  const home = await tempDir();
  const store = new ConsentStore(home);
  await store.load();
  const mcp = manager([server("lab", { FIXTURE_MODE: "access-bad", SITE: "one" })], { consent: store });
  await mcp.connect("lab");
  await mcp.remember("lab");
  await mcp.setWrites("lab", true);
  const diff = await mcp.reload({ servers: [server("lab", { FIXTURE_MODE: "access-bad", SITE: "two" })], diagnostics: [] });
  expect(diff.revoked).toEqual(["lab"]);
  expect(statusOf(mcp, "lab")).toMatchObject({ writes: "off", approved: false, consent: "changed", state: "disconnected" });
  expect(mcp.writesOn()).toEqual([]);
});

test("the consent file keeps no definition values", async () => {
  const home = await tempDir();
  const store = new ConsentStore(home);
  await store.load();
  const mcp = manager([server("lab", { FIXTURE_MODE: "access-bad", TOKEN: "SECRET-token-value" })], { consent: store });
  await mcp.connect("lab");
  await mcp.remember("lab");
  const text = await readFile(store.file, "utf8");
  expect(text).not.toContain("SECRET");
  expect(text).not.toContain(process.execPath);
  await writeFile(store.file, "{ damaged");
  const damaged = new ConsentStore(home);
  await damaged.load();
  const again = manager([server("lab", { FIXTURE_MODE: "access-bad", TOKEN: "SECRET-token-value" })], { consent: damaged });
  expect(statusOf(again, "lab").approved).toBe(false);
  expect(again.diagnostics).toContain("~/.casper/mcp-consent.json is damaged. Casper will ask again for each server.");
});

test("with writes off, a write behind a read router is refused like the write tool itself, also after a yes", async () => {
  const log = path.join(await tempDir(), "calls.log");
  const mcp = manager([server("hpe", { FIXTURE_MODE: "hpe-router", FIXTURE_CALLS_FILE: log })]);
  const boxes: string[] = [];
  let answer: () => Promise<boolean> = async () => true;
  const broker = new CapabilityBroker(mcp, async (call) => { boxes.push(call.plan.routed.map((routed) => routed.name).join(",")); return answer(); }, { writesGate: true });
  await mcp.connect("hpe");
  await expect(broker.invoke("mcp:hpe:invoke_read_tool", { name: "central_delete_site", arguments: { site: "lab" } }))
    .rejects.toThrow("Not executed (hpe writes are off. Only the user can turn them on with /mcp writes hpe.)");
  await expect(broker.invoke("mcp:hpe:invoke_read_tool", { name: "central_update_wlan", arguments: {} })).rejects.toThrow("Not executed (hpe writes are off.");
  expect(boxes).toEqual([]);
  await broker.invoke("mcp:hpe:invoke_read_tool", { name: "central_get_sites", arguments: {} });
  await mcp.setWrites("hpe", true);
  await broker.invoke("mcp:hpe:invoke_read_tool", { name: "central_delete_site", arguments: { site: "lab" } });
  expect(boxes).toEqual(["central_delete_site"]);
  const sent = (await readFile(log, "utf8")).trim().split("\n").filter((line) => line.startsWith("invoke_read_tool"));
  expect(sent.map((line) => JSON.parse(line.slice("invoke_read_tool ".length)).name)).toEqual(["central_get_sites", "central_delete_site"]);
});

test("writes turned off while the box for a write behind a router is open: the yes no longer runs it", async () => {
  const log = path.join(await tempDir(), "calls.log");
  // A router on a server with no pins (so turning writes off does not restart it).
  const mcp = manager([server("lab", { FIXTURE_MODE: "hpe-router", FIXTURE_CALLS_FILE: log }, ["jmcp.py"])]);
  const broker = new CapabilityBroker(mcp, async () => { await mcp.setWrites("lab", false); return true; }, { writesGate: true });
  await mcp.connect("lab");
  await mcp.setWrites("lab", true);
  await expect(broker.invoke("mcp:lab:invoke_read_tool", { name: "central_delete_site", arguments: {} }))
    .rejects.toThrow("Not executed (lab writes are off. Only the user can turn them on with /mcp writes lab.)");
  expect(await readFile(log, "utf8").catch(() => "")).not.toContain("central_delete_site");
});

test("/mcp reload back to a remembered definition connects on its own again, and says remembered only when approved", async () => {
  const home = await tempDir();
  const store = new ConsentStore(home);
  await store.load();
  const one = server("lab", { FIXTURE_MODE: "access-bad", SITE: "one" });
  await store.remember(one);
  const mcp = manager([server("lab", { FIXTURE_MODE: "access-bad", SITE: "two" })], { consent: store });
  expect(statusOf(mcp, "lab")).toMatchObject({ approved: false, consent: "changed" });
  const diff = await mcp.reload({ servers: [one], diagnostics: [] });
  expect(diff.revoked).toEqual([]);
  expect(statusOf(mcp, "lab")).toMatchObject({ approved: true, consent: "remembered", writes: "off" });
});

test("/mcp forget works for a remembered server that is no longer in any file", async () => {
  const home = await tempDir();
  const store = new ConsentStore(home);
  await store.load();
  const old = server("old", { FIXTURE_MODE: "access-bad" });
  await store.remember(old);
  const mcp = manager([], { consent: store });
  expect(await mcp.forget("old")).toBe(true);
  await expect(mcp.forget("old")).rejects.toThrow("Unknown MCP server");
  const again = new ConsentStore(home);
  await again.load();
  expect(statusOf(manager([old], { consent: again }), "old")).toMatchObject({ approved: false, consent: "none" });
});

test("a remembered server that moves into a project file needs the project review again", async () => {
  const home = await tempDir();
  const store = new ConsentStore(home);
  await store.load();
  const mine = server("lab", { FIXTURE_MODE: "access-bad" });
  await store.remember(mine);
  const mcp = manager([mine], { consent: store });
  const broker = new CapabilityBroker(mcp, undefined, { writesGate: true });
  await broker.prepare("status");
  expect(statusOf(mcp, "lab")).toMatchObject({ approved: true, state: "ready" });
  // The same program, now from the opened repository.
  const diff = await mcp.reload({ servers: [{ ...mine, source: "/repo/.mcp.json", scope: "project" }], diagnostics: [] });
  expect(diff.revoked).toEqual(["lab"]);
  expect(statusOf(mcp, "lab")).toMatchObject({ approved: false, consent: "none", state: "disconnected", scope: "project" });
  expect(mcp.review("lab")?.preview).toContain("(project file)");
});
