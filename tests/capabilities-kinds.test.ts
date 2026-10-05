import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPlan, planLabel } from "../src/capabilities/approval";
import { CapabilityBroker } from "../src/capabilities/broker";
import { asksEveryTime, changeKind, hitKindsFrom, MAX_HITS_PER_SERVER, planKinds, RISKY_KINDS, isRiskyKind, withHitKinds } from "../src/capabilities/kinds";
import type { MCPServerDefinition } from "../src/mcp/config";
import { MCPManager } from "../src/mcp/manager";
import { networkServerEntry } from "../src/mcp/network/server";
import { toolLabel } from "../src/capabilities/labels";
import type { MCPTool } from "../src/mcp/manager";

function kind(name: string, meta?: unknown, annotations?: MCPTool["annotations"]) {
  const tool = { name, annotations, ...(meta === undefined ? {} : { _meta: { "casper/change-kind": meta } }) };
  return changeKind(tool, toolLabel(tool));
}

test("risky kinds are firmware, delete and admin", () => {
  expect([...RISKY_KINDS]).toEqual(["firmware", "delete", "admin"]);
  expect(isRiskyKind("config")).toBe(false);
  expect(isRiskyKind("disruptive")).toBe(false);
});

test("each word list gives its kind", () => {
  for (const name of ["trigger_device_upgrade", "set_firmware_compliance", "upload_image"]) expect(kind(name)).toBe("firmware");
  for (const name of ["delete_site", "remove_devices_from_group", "unclaim_device", "erase_config", "zeroize_switch"]) expect(kind(name)).toBe("delete");
  for (const name of ["invite_glp_user", "create_glp_role_assignment", "rotate_api_token", "update_sso_settings", "add_admin"]) expect(kind(name)).toBe("admin");
  for (const name of ["port_bounce", "reboot_device", "restart_ap", "disconnect_client", "deauth_client", "gateway_halt"]) expect(kind(name)).toBe("disruptive");
  for (const name of ["create_vlan", "update_ssid", "set_hostname", "create_role"]) expect(kind(name)).toBe("config");
});

test("read and diagnostic tools are read and troubleshoot", () => {
  expect(kind("list_sites", undefined, { readOnlyHint: true })).toBe("read");
  expect(changeKind({ name: "cx_ping" }, "diagnostic")).toBe("troubleshoot");
  expect(changeKind({ name: "cable_test" }, "external-action")).toBe("troubleshoot");
  expect(changeKind({ name: "ap_traceroute" }, "write")).toBe("troubleshoot");
});

test("a server's change kind is used only when it is a known kind, and never makes a risky name safe", () => {
  expect(kind("update_device_settings", "firmware")).toBe("firmware");
  expect(kind("create_vlan", "admin")).toBe("admin");
  expect(kind("create_vlan", "everything")).toBe("config");
  expect(kind("create_vlan", 7)).toBe("config");
  expect(kind("delete_site", "config")).toBe("delete");
  expect(kind("trigger_device_upgrade", "read")).toBe("firmware");
  expect(kind("create_vlan", "read")).toBe("config");
});

test("a router call takes the kind of the real tool it runs", () => {
  const router = { type: "object" as const, properties: { name: { type: "string" }, arguments: { type: "object" } } };
  const single = buildPlan({ server: "net", tool: "invoke_tool", label: "destructive", schema: router,
    arguments: { name: "trigger_device_upgrade", arguments: { serial: "X" } } });
  expect(planKinds(single)).toEqual(["firmware"]);
  const batch = buildPlan({ server: "net", tool: "invoke_tools_batch", label: "destructive",
    schema: { type: "object", properties: { calls: { type: "array" } } },
    arguments: { calls: [{ name: "create_vlan", arguments: {} }, { name: "delete_site", arguments: {} }] } });
  expect(planKinds(batch)).toEqual(["config", "delete"]);
  const direct = buildPlan({ server: "net", tool: "invite_glp_user", label: "write", schema: { type: "object" }, arguments: {} });
  expect(planKinds(direct)).toEqual(["admin"]);
});

test("the kind box: plain words, the real tool, 1 No · 2 Yes, this once · 3 Yes, for this session", async () => {
  const { kindBox } = await import("../src/capabilities/approval");
  const box = kindBox("firmware", "Mist", "trigger_device_upgrade");
  expect(box.preview).toBe("Firmware changes are off by default on Mist.\n  Runs: trigger device upgrade\n");
  expect(box.question).toBe("Allow firmware changes on Mist?");
  expect(box.labels).toEqual(["No", "Yes, this once", "Yes, for this session"]);
});

test("review: a router call to a tool whose name reads as a read still gets its risky kind", () => {
  const router = { type: "object" as const, properties: { name: { type: "string" }, arguments: { type: "object" } } };
  const call = buildPlan({ server: "net", tool: "invoke_tool", label: "destructive", schema: router,
    arguments: { name: "invite_glp_user", arguments: {} } });
  expect(planKinds(call)).toEqual(["admin"]);
});

test("review: a server's own firmware or delete tag asks every time on a direct call; a router call goes by the words", () => {
  const direct = buildPlan({ server: "net", tool: "update_device_settings", label: "write", schema: { type: "object" }, arguments: {} });
  const tagged = { _meta: { "casper/change-kind": "firmware" } };
  expect(asksEveryTime(direct)).toBe(false);
  expect(asksEveryTime(direct, tagged)).toBe(true);
  expect(asksEveryTime(direct, { _meta: { "casper/change-kind": "delete" } })).toBe(true);
  expect(asksEveryTime(direct, { _meta: { "casper/change-kind": "config" } })).toBe(false);
  const router = { type: "object" as const, properties: { name: { type: "string" }, arguments: { type: "object" } } };
  const routed = buildPlan({ server: "net", tool: "invoke_tool", label: "write", schema: router,
    arguments: { name: "update_device_settings", arguments: {} } });
  expect(asksEveryTime(routed, tagged)).toBe(false);
});

// --- Kinds from the server's find_tool hits (Plan D Task 6) ----------------------------------------------------

const routerSchema = { type: "object" as const, properties: { name: { type: "string" }, arguments: { type: "object" } } };
function routedPlan(tool: string, name: string) {
  return buildPlan({ server: "network", tool, label: tool === "invoke_tool" ? "write" : "read", schema: routerSchema, arguments: { name, arguments: {} } });
}

test("a find_tool kind can raise a routed call's kind", () => {
  const plan = routedPlan("invoke_tool", "update_device");
  expect(planKinds(plan, undefined, new Map([["update_device", "firmware"]]))).toEqual(["firmware"]);
  expect(asksEveryTime(plan, undefined, new Map([["update_device", "firmware"]]))).toBe(true);
});

test("a find_tool kind can never lower it", () => {
  const plan = routedPlan("invoke_tool", "delete_site");
  expect(planKinds(plan, undefined, new Map([["delete_site", "config"]]))).toEqual(["delete"]);
  expect(planKinds(routedPlan("invoke_tool", "port_bounce"), undefined, new Map([["port_bounce", "troubleshoot"]]))).toEqual(["disruptive"]);
});

test("a declared read never makes invoke_tool a read", () => {
  const plan = routedPlan("invoke_tool", "set_port_vlan");
  expect(planKinds(plan, undefined, new Map([["set_port_vlan", "read"]]))).toEqual(["config"]);
});

test("hit kinds that aren't Casper's kinds are ignored", () => {
  const hits = hitKindsFrom({ content: [], structuredContent: { result: [
    { name: "set_port_vlan", kind: "superuser" }, { name: "update_device", kind: "firmware" }, { name: 7, kind: "admin" }, { kind: "delete" },
  ] } });
  expect([...hits.keys()]).toEqual(["update_device"]);
  expect(hits.get("update_device")).toEqual({ kind: "firmware" });
});

test("hits are read the way the server's SDK sends a list: one text block per hit, or structuredContent.result", () => {
  const hit = { name: "cx_show", product: "central", summary: "Run a show command.", kind: "troubleshoot", label: "diagnostic" };
  expect(hitKindsFrom({ content: [{ type: "text", text: JSON.stringify(hit) }] }).get("cx_show")).toEqual({ kind: "troubleshoot", product: "central" });
  expect(hitKindsFrom({ content: [{ type: "text", text: JSON.stringify([hit]) }] }).get("cx_show")?.kind).toBe("troubleshoot");
  expect(hitKindsFrom({ content: [{ type: "text", text: "not json" }] }).size).toBe(0);
  expect(hitKindsFrom({ content: [], structuredContent: { result: [{ ...hit, product: "elsewhere" }] } }).get("cx_show")).toEqual({ kind: "troubleshoot" });
});

test("a troubleshoot kind from find_tool makes a routed read call ask (diagnostic); a read kind changes nothing", async () => {
  const { planLabel } = await import("../src/capabilities/approval");
  expect(planLabel(withHitKinds(routedPlan("invoke_read_tool", "cx_show"), new Map([["cx_show", "troubleshoot"]])))).toBe("diagnostic");
  expect(planLabel(withHitKinds(routedPlan("invoke_read_tool", "mist_list_sites"), new Map([["mist_list_sites", "read"]])))).toBe("read");
  expect(planLabel(withHitKinds(routedPlan("invoke_read_tool", "mist_site_settings"), new Map([["mist_site_settings", "config"]])))).toBe("write");
});

test("a routed check named for a link test (cable, ping, iperf) asks even before find_tool named it; plain reads don't", async () => {
  const { planLabel } = await import("../src/capabilities/approval");
  for (const name of ["cable_test", "mist_cable_test_from_switch", "central_initiate_cx_cable_test_v1", "cx_ping", "gateway_iperf"]) {
    expect([name, planLabel(routedPlan("invoke_read_tool", name))]).toEqual([name, "diagnostic"]);
  }
  for (const name of ["mist_list_sites", "list_test_results", "cx_show_vlans"]) {
    expect([name, planLabel(routedPlan("invoke_read_tool", name))]).toEqual([name, "read"]);
  }
});

// --- In the broker, with the network server's stand-in ---------------------------------------------------------

const fakeServer = path.join(import.meta.dir, "fixtures/fake-network-mcp.ts");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function troubleshootRun(preset: "network" | "hpe", tool = "cx_show", options: { destructive?: boolean } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-hit-kinds-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const calls = path.join(home, "calls.log");
  // The same stand-in, installed where Casper installs its network server, or under hpe-networking-mcp's program name.
  const entry = preset === "network" ? networkServerEntry(home).command : path.join(home, "bin/hpe-mcp-router");
  await mkdir(path.dirname(entry), { recursive: true });
  const hits = [{ name: tool, product: "central", summary: "Run a check.", kind: "troubleshoot", label: "diagnostic" }];
  const destructive = options.destructive ? "FAKE_INVOKE_DESTRUCTIVE=1 " : "";
  await writeFile(entry, `#!/bin/sh\n${destructive}FAKE_CALLS_FILE='${calls}' FAKE_HITS='${JSON.stringify(hits)}' exec "${process.execPath}" "${fakeServer}" "$@"\n`);
  await chmod(entry, 0o755);
  const definition: MCPServerDefinition = { name: "network", source: path.join(home, ".casper/mcp.json"), scope: "user", cwd: home, disabled: false,
    transport: { type: "stdio", command: entry, args: [], env: preset === "hpe" ? { HPE_MCP_EXAMPLE: "1" } : {} } };
  const manager = new MCPManager({ servers: [definition], diagnostics: [] }, { timeoutMs: 15_000, homeDir: home });
  cleanup.push(() => manager.close());
  await manager.connect("network");
  const setWrites: boolean[] = [];
  const real = manager.setWrites.bind(manager);
  manager.setWrites = async (name, on, options) => { setWrites.push(on); return real(name, on, options); };
  const boxes: string[] = [];
  const broker = new CapabilityBroker(manager, async (call) => { boxes.push(planLabel(call.plan)); return "yes"; }, { writesGate: true });
  await broker.invoke("mcp:network:find_tool", { query: "show interfaces on the closet switch" });
  const via = options.destructive ? "invoke_tool" : "invoke_read_tool";
  const result = await broker.invoke(`mcp:network:${via}`, { name: tool, arguments: { command: "show interfaces" } });
  const lines = (await readFile(calls, "utf8")).split("\n");
  return { preset: manager.policy("network").match?.preset.id, result, boxes, setWrites, starts: lines.filter((line) => line.startsWith("start ")), ran: lines.some((line) => line.startsWith(`call ${via}`)) };
}

test("an approved troubleshoot call on the network preset runs pinned, with no restart", async () => {
  const run = await troubleshootRun("network");
  expect(run.preset).toBe("casper-network-mcp");
  expect(run.boxes).toEqual(["diagnostic"]);
  expect(run.setWrites).toEqual([]);
  expect(run.starts).toEqual(['start ["--read-only"]']);
  expect(run.ran).toBe(true);
  expect(run.result.isError).toBeFalsy();
});

test("a troubleshoot call on a preset without troubleshootRunsPinned still turns writes on as today", async () => {
  const run = await troubleshootRun("hpe");
  expect(run.preset).toBe("hpe-networking-mcp");
  expect(run.boxes).toEqual(["diagnostic"]);
  expect(run.setWrites).toEqual([true, false]);
  expect(run.ran).toBe(true);
});

test("review: a troubleshoot hit on a name that reads as a read is a troubleshooting check, not a config change", () => {
  const hits = (name: string) => new Map([[name, "troubleshoot" as const]]);
  for (const name of ["get_lldp_neighbors", "get_cx_mac_table", "find_mac_on_switch", "aos_s_arp", "ap_https", "mist_arp_from_device", "central_initiate_cx_http_v1"]) {
    expect(planKinds(routedPlan("invoke_read_tool", name), undefined, hits(name))).toEqual(["troubleshoot"]);
  }
  // Without the hit a routed read name is still judged a change; a hit never lowers a name that reads as a change or runs commands.
  expect(planKinds(routedPlan("invoke_read_tool", "get_lldp_neighbors"))).toEqual(["config"]);
  expect(planKinds(routedPlan("invoke_tool", "set_port_vlan"), undefined, hits("set_port_vlan"))).toEqual(["config"]);
  expect(planKinds(routedPlan("invoke_read_tool", "run_troubleshooting_bundle"), undefined, hits("run_troubleshooting_bundle"))).toEqual(["config"]);
});

test("review: an approved LLDP check on the network preset runs pinned, with no restart", async () => {
  const run = await troubleshootRun("network", "get_lldp_neighbors");
  expect(run.boxes).toEqual(["diagnostic"]);
  expect(run.setWrites).toEqual([]);
  expect(run.starts).toEqual(['start ["--read-only"]']);
  expect(run.ran).toBe(true);
});

test("review: a later find_tool that names a lower kind never lowers the kept one", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-hit-kinds-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const entry = networkServerEntry(home).command;
  await mkdir(path.dirname(entry), { recursive: true });
  const hit = (kind: string) => [{ name: "mist_update_device", product: "mist", summary: "Update a device.", kind, label: "write" }];
  await writeFile(entry, `#!/bin/sh\nFAKE_HITS='${JSON.stringify(hit("firmware"))}' FAKE_HITS_LATER='${JSON.stringify(hit("config"))}' exec "${process.execPath}" "${fakeServer}" "$@"\n`);
  await chmod(entry, 0o755);
  const definition: MCPServerDefinition = { name: "network", source: path.join(home, ".casper/mcp.json"), scope: "user", cwd: home, disabled: false,
    transport: { type: "stdio", ...networkServerEntry(home) } };
  const manager = new MCPManager({ servers: [definition], diagnostics: [] }, { timeoutMs: 15_000, homeDir: home });
  cleanup.push(() => manager.close());
  await manager.connect("network");
  const kinds: string[] = [];
  const broker = new CapabilityBroker(manager, async () => "no", { writesGate: true, confirmKind: async (ask) => { kinds.push(ask.kind); return false; } });
  await broker.invoke("mcp:network:find_tool", { query: "upgrade the switch" });
  await broker.invoke("mcp:network:find_tool", { query: "update the switch" });
  expect(broker.hitKinds("network").get("mist_update_device")).toBe("firmware");
  await expect(broker.invoke("mcp:network:invoke_tool", { name: "mist_update_device", arguments: {} })).rejects.toThrow("you said no");
  expect(kinds).toEqual(["firmware"]);
});

test("review: a troubleshoot hit through a tool the server marks destructive never runs pinned: writes are turned on for it", async () => {
  const run = await troubleshootRun("network", "cx_show", { destructive: true });
  expect(run.boxes).toEqual(["destructive"]);
  expect(run.setWrites).toEqual([true, false]);
  expect(run.ran).toBe(true);
});

async function hitServer(hits: unknown[], later?: unknown[]) {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-hit-kinds-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const entry = networkServerEntry(home).command;
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(path.join(home, "hits.json"), JSON.stringify(hits));
  await writeFile(path.join(home, "later.json"), JSON.stringify(later ?? hits));
  await writeFile(entry, `#!/bin/sh\nFAKE_HITS="$(cat '${path.join(home, "hits.json")}')" FAKE_HITS_LATER="$(cat '${path.join(home, "later.json")}')" exec "${process.execPath}" "${fakeServer}" "$@"\n`);
  await chmod(entry, 0o755);
  const definition: MCPServerDefinition = { name: "network", source: path.join(home, ".casper/mcp.json"), scope: "user", cwd: home, disabled: false,
    transport: { type: "stdio", ...networkServerEntry(home) } };
  const manager = new MCPManager({ servers: [definition], diagnostics: [] }, { timeoutMs: 15_000, homeDir: home });
  cleanup.push(() => manager.close());
  await manager.connect("network");
  return { manager, broker: new CapabilityBroker(manager, async () => "no", { writesGate: true }) };
}

test("review: find_tool hits are forgotten when the server's definition changes", async () => {
  const { manager, broker } = await hitServer([{ name: "mist_update_device", product: "mist", summary: "x", kind: "firmware", label: "write" }]);
  await broker.invoke("mcp:network:find_tool", { query: "upgrade" });
  expect(broker.hitKinds("network").get("mist_update_device")).toBe("firmware");
  const real = manager.definition.bind(manager);
  manager.definition = (name) => ({ ...real(name), cwd: path.join(real(name).cwd, "elsewhere") });
  expect(broker.hitKinds("network").size).toBe(0);
});

test("review: past the limit of hits kept per server, the oldest is dropped", async () => {
  const hit = (index: number) => ({ name: `mist_tool_${index}`, product: "mist", summary: "x", kind: "config", label: "write" });
  // One find_tool fills the cache; the next one names one more tool.
  const { broker } = await hitServer(Array.from({ length: MAX_HITS_PER_SERVER }, (_value, index) => hit(index)), [hit(MAX_HITS_PER_SERVER)]);
  await broker.invoke("mcp:network:find_tool", { query: "everything" });
  expect(broker.hitKinds("network").size).toBe(MAX_HITS_PER_SERVER);
  await broker.invoke("mcp:network:find_tool", { query: "one more" });
  const kept = broker.hitKinds("network");
  expect(kept.size).toBe(MAX_HITS_PER_SERVER);
  expect(kept.has("mist_tool_0")).toBe(false);
  expect(kept.has(`mist_tool_${MAX_HITS_PER_SERVER}`)).toBe(true);
});
