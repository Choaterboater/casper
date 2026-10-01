import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import type { CapabilitySafety } from "../src/capabilities/broker";
import type { MCPServerDefinition } from "../src/mcp/config";
import { MCPManager, type MCPTool } from "../src/mcp/manager";
import { gatesConfirmedOff, parseAccessCheck } from "../src/mcp/access";
import { toolLabel } from "../src/capabilities/labels";
import {
  PRESETS, SAFETY_ORDER, approvalNotes, guardArguments, hasNoPreview, isHidden, isPlainJunosShow, matchPreset, ownSettingsNote,
  planPins, presetById, presetLine, rememberBlock, runnerPin, safetyRank, tightenSafety, writesTitle, type PresetMatch,
} from "../src/mcp/presets";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const envDump = path.join(import.meta.dir, "fixtures/env-dump.ts");
const networkFixture = path.join(import.meta.dir, "fixtures/mcp-network-server.ts");

function stdio(name: string, command: string, args: string[], env: Record<string, string> = {}): MCPServerDefinition {
  return { name, source: "/home/u/.claude.json", scope: "user", cwd: "/home/u", disabled: false, transport: { type: "stdio", command, args, env } };
}
function http(name: string, url: string): MCPServerDefinition {
  return { name, source: "/home/u/.claude.json", scope: "user", cwd: "/home/u", disabled: false, transport: { type: "http", url, headers: {} } };
}
const hpeRouterArgs = ["/srv/hpe-networking-mcp/src/hpe_networking_mcp/mcp_servers/tool_router.py"];
const tool = (name: string, annotations?: MCPTool["annotations"]): MCPTool => ({ name, inputSchema: { type: "object" }, ...(annotations ? { annotations } : {}) });

/** Start the planned transport and read what it actually got. */
async function spawnPlanned(transport: { command: string; args: string[]; env: Record<string, string> }) {
  const child = Bun.spawn([transport.command, ...transport.args], { env: { ...transport.env }, stdout: "pipe", stderr: "pipe" });
  const text = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return JSON.parse(text) as { argv: string[]; env: Record<string, string> };
}

/** The fixture's tools with the labels Casper gives them today, read through the real broker. */
async function fixtureTools(mode: string): Promise<{ tools: MCPTool[]; labels: Map<string, CapabilitySafety> }> {
  const manager = new MCPManager({ servers: [{
    name: "net", source: "fixture", cwd: process.cwd(), disabled: false,
    transport: { type: "stdio", command: process.execPath, args: [networkFixture], env: { FIXTURE_MODE: mode } },
  }], diagnostics: [] }, { timeoutMs: 5000 });
  cleanup.push(() => manager.close());
  await manager.connect("net");
  const tools = manager.catalog()[0]!.tools;
  // The label before any preset: what the broker's label pipeline gives each tool. (Search can't be
  // used here: a read-only login from access_check hides the non-read tools.)
  const labels = new Map<string, CapabilitySafety>(tools.map((item) => [item.name, toolLabel(item)]));
  return { tools, labels };
}

test("hpe-networking-mcp starts read-only even when the user turned a write gate on", async () => {
  const definition = stdio("hpe-networking-mcp", process.execPath, [envDump, ...hpeRouterArgs], {
    HPE_MCP_CENTRAL_WRITES: "1", HPE_MCP_ACCESS_PROFILE: "full-read-write", HPE_MCP_TOOLSETS: "central,glp",
  });
  const match = matchPreset(definition)!;
  expect(match.preset.id).toBe("hpe-networking-mcp");
  const plan = planPins(definition, match.preset);
  if (plan.kind !== "pinned") throw new Error("expected pins");
  const seen = await spawnPlanned(plan.transport);
  expect(seen.env).toEqual({
    HPE_MCP_ACCESS_PROFILE: "safe-read-only", HPE_MCP_READONLY: "1", HPE_MCP_PRODUCT_ACCESS: "read-only", HPE_MCP_TOOLSETS: "central,glp",
    HPE_MCP_CENTRAL_WRITES: "0", HPE_MCP_GLP_V2BETA1_WRITES: "0", HPE_MCP_AOS8_WRITES: "0", HPE_MCP_EDGECONNECT_WRITES: "0",
    HPE_MCP_APSTRA_WRITES: "0", HPE_MCP_MIST_WRITES: "0", HPE_MCP_CLEARPASS_WRITES: "0", HPE_MCP_UXI_WRITES: "0",
    HPE_MCP_AXIS_WRITES: "0", HPE_MCP_AOS8_ROLLBACK_WRITES: "0",
  });
  expect(seen.argv).toEqual(hpeRouterArgs);
  // The user's definition is not changed.
  expect(definition.transport.type === "stdio" && definition.transport.env.HPE_MCP_CENTRAL_WRITES).toBe("1");
});

test("hpe-networking-mcp is recognised by what it runs, never by its name", () => {
  expect(matchPreset(stdio("hpe-networking-mcp", "/usr/bin/node", ["/opt/other/index.js"]))).toBeUndefined();
  expect(matchPreset(stdio("anything", "/venv/bin/hpe-mcp-router", []))?.preset.id).toBe("hpe-networking-mcp");
  expect(matchPreset(stdio("anything", "python", ["-m", "hpe_networking_mcp.mcp_servers.tool_router"]))?.preset.id).toBe("hpe-networking-mcp");
  expect(matchPreset(stdio("anything", "python", ["x.py"], { HPE_MCP_READONLY: "1" }))?.preset.id).toBe("hpe-networking-mcp");
});

test("centralmcp gets CENTRALMCP_READONLY=1 and ClearPass MCP gets CLEARPASS_READ_ONLY=true", async () => {
  const central = stdio("aruba-central", process.execPath, [envDump, "centralmcp"], { CENTRALMCP_READONLY: "0" });
  expect(matchPreset(central)?.preset.id).toBe("centralmcp");
  const centralPlan = planPins(central, matchPreset(central)!.preset);
  if (centralPlan.kind !== "pinned") throw new Error("expected pins");
  expect((await spawnPlanned(centralPlan.transport)).env).toEqual({ CENTRALMCP_READONLY: "1" });

  const clearpass = stdio("clearpass", process.execPath, [envDump, "clearpass-mcp"], { CLEARPASS_HOST: "cppm.example.net" });
  expect(matchPreset(clearpass)?.preset.id).toBe("clearpass-mcp");
  const clearpassPlan = planPins(clearpass, matchPreset(clearpass)!.preset);
  if (clearpassPlan.kind !== "pinned") throw new Error("expected pins");
  expect((await spawnPlanned(clearpassPlan.transport)).env).toEqual({ CLEARPASS_HOST: "cppm.example.net", CLEARPASS_READ_ONLY: "true" });
});

test("grafana gets --disable-write exactly once, also when planned again", async () => {
  const grafana = stdio("grafana", process.execPath, [envDump, "mcp-grafana", "-t", "stdio"]);
  const preset = matchPreset(grafana)!.preset;
  expect(preset.id).toBe("grafana");
  const plan = planPins(grafana, preset);
  if (plan.kind !== "pinned") throw new Error("expected pins");
  expect((await spawnPlanned(plan.transport)).argv).toEqual(["mcp-grafana", "-t", "stdio", "--disable-write"]);
  const again = planPins({ ...grafana, transport: plan.transport }, preset);
  if (again.kind !== "pinned") throw new Error("expected pins");
  expect(again.transport.args.filter((arg) => arg === "--disable-write")).toEqual(["--disable-write"]);
  const already = planPins(stdio("grafana", "mcp-grafana", ["--disable-write"]), preset);
  expect(already.kind === "pinned" && already.transport.args).toEqual(["--disable-write"]);
});

test("docker and podman get env pins as -e before the image, after the user's own -e", () => {
  const docker = stdio("aruba-central", "docker", ["run", "-i", "--rm", "-e", "CENTRALMCP_READONLY=0", "--env-file", "/x.env", "ghcr.io/acme/centralmcp:1.2", "serve"]);
  const plan = planPins(docker, presetById("centralmcp")!);
  expect(plan).toEqual({ kind: "pinned", shown: ["CENTRALMCP_READONLY=1"], transport: {
    type: "stdio", command: "docker",
    args: ["run", "-i", "--rm", "-e", "CENTRALMCP_READONLY=0", "--env-file", "/x.env", "-e", "CENTRALMCP_READONLY=1", "ghcr.io/acme/centralmcp:1.2", "serve"],
    env: {},
  } });
  const podman = stdio("grafana", "/usr/bin/podman", ["container", "run", "--name=g", "-i", "docker.io/mcp/grafana:1.0", "-t", "stdio"]);
  expect(planPins(podman, presetById("grafana")!)).toMatchObject({ transport: { args: ["container", "run", "--name=g", "-i", "docker.io/mcp/grafana:1.0", "-t", "stdio", "--disable-write"] } });
  // An option Casper doesn't know could swallow the next word, so it won't claim a pin.
  const unknown = stdio("aruba-central", "docker", ["run", "--some-new-flag", "value", "ghcr.io/acme/centralmcp:1.2"]);
  const refused = planPins(unknown, presetById("centralmcp")!);
  expect(refused).toEqual({ kind: "cannot-pin", reason: "Casper can't tell which part of the docker command is the image" });
  expect(presetLine({ preset: presetById("centralmcp")!, by: "definition", mismatch: false }, refused)).toEqual([
    "preset: centralmcp",
    "Can't pin read-only for this server (Casper can't tell which part of the docker command is the image). Every change asks you in Casper.",
  ]);
});

test("args can't be pinned through a shell wrapper or after --", () => {
  expect(planPins(stdio("grafana", "sh", ["-c", "mcp-grafana -t stdio"]), presetById("grafana")!).kind).toBe("cannot-pin");
  expect(planPins(stdio("grafana", "uv", ["run", "--", "mcp-grafana"]), presetById("grafana")!).kind).toBe("cannot-pin");
  // Env still reaches a shell's children.
  expect(planPins(stdio("aruba-central", "sh", ["-c", "centralmcp"]), presetById("centralmcp")!).kind).toBe("pinned");
});

test("pins are 'sent, not confirmed' until the server reports its gates off", () => {
  const definition = stdio("hpe", "python", hpeRouterArgs);
  const match = matchPreset(definition)!;
  const plan = planPins(definition, match.preset);
  const unconfirmed = presetLine(match, plan, gatesConfirmedOff(undefined))[0]!;
  expect(unconfirmed).toStartWith("preset: hpe-networking-mcp (read-only pins sent, not confirmed: HPE_MCP_ACCESS_PROFILE=safe-read-only, HPE_MCP_READONLY=1,");
  const check = parseAccessCheck({ content: [{ type: "text", text: JSON.stringify({ contract: "casper/access-check v1", products: [
    { product: "central", access: "read-write", server_gate: { env_var: "HPE_MCP_CENTRAL_WRITES", state: "disabled" } },
  ] }) }] });
  expect(presetLine(match, plan, gatesConfirmedOff(check))[0]).toStartWith("preset: hpe-networking-mcp (read-only pinned: HPE_MCP_ACCESS_PROFILE=safe-read-only");
  const enabled = parseAccessCheck({ content: [{ type: "text", text: JSON.stringify({ contract: "casper/access-check v1", products: [
    { product: "central", access: "read-only", server_gate: { env_var: "HPE_MCP_CENTRAL_WRITES", state: "enabled" } },
  ] }) }] });
  expect(gatesConfirmedOff(enabled)).toBe(false);
});

test("presets only restrict: labels never go down, nothing becomes read, hiding and blocks only add", async () => {
  const fixtures = await Promise.all(["hpe-router", "junos", "karthik-like", "access-ro"].map(fixtureTools));
  const synthetic = ["get_status", "show_interfaces", "list_sites", "set_vlan", "delete_site", "execute_command", "run_report", "send_config_set",
    "send_command", "invoke_tool", "invoke_tools_batch", "load_and_commit_config", "render_and_apply_j2_template", "get_and_delete_site", "config_backup"]
    .flatMap((name) => [tool(name), tool(name, { readOnlyHint: true }), tool(name, { readOnlyHint: false, destructiveHint: true })]);
  const all: { tool: MCPTool; bases: CapabilitySafety[] }[] = [
    ...fixtures.flatMap(({ tools, labels }) => tools.map((item) => ({ tool: item, bases: [labels.get(item.name)!, ...SAFETY_ORDER] }))),
    ...synthetic.map((item) => ({ tool: item, bases: SAFETY_ORDER })),
  ];
  expect(fixtures.find((fixture) => fixture.tools.some((item) => item.name === "find_tool"))!.labels.get("find_tool")).toBe("read");
  const definitions = [stdio("x", "python", hpeRouterArgs), stdio("x", "npx", ["-y", "central-mcp-server"]), stdio("x", "uv", ["run", "/opt/jmcp.py"])];
  let checks = 0;
  for (const preset of PRESETS) {
    const match: PresetMatch = { preset, by: "definition", mismatch: false };
    for (const { tool: item, bases } of all) {
      for (const base of bases) {
        const raw = preset.tighten?.(item, base) ?? base;
        expect(safetyRank(raw)).toBeGreaterThanOrEqual(safetyRank(base));
        const tightened = tightenSafety(match, item, base);
        expect(safetyRank(tightened)).toBeGreaterThanOrEqual(safetyRank(base));
        if (base !== "read") expect(tightened).not.toBe("read");
        for (const writes of ["off", "on"] as const) {
          for (const access of ["read-only", "read-write", "unknown"] as const) {
            if (isHidden(undefined, item, tightened, { writes, access })) expect(isHidden(match, item, tightened, { writes, access })).toBe(true);
          }
          for (const args of [{ command: "show version" }, { command: "request system reboot" }, { commands: ["show version"] }, {}]) {
            expect(guardArguments(match, item, args, { writes, showOptIn: false })).not.toBe("allow");
          }
        }
        checks += 1;
      }
    }
    for (const definition of definitions) {
      if (rememberBlock(definition)) expect(rememberBlock(definition, match)).toBeDefined();
    }
  }
  expect(checks).toBeGreaterThan(1000);
});

test("Karthik's server: unpinned gets the exact refusal, a version pin can be remembered, write tools hide while writes are off", async () => {
  const unpinned = stdio("central-mcp-server", "uvx", ["central-mcp-server"]);
  const match = matchPreset(unpinned)!;
  expect(match.preset.id).toBe("central-mcp-server");
  expect(rememberBlock(unpinned, match)).toBe(
    "Not remembered: central-mcp-server is not pinned to a version. An update could add write tools. Pin it (for example ==1.4.2 or a commit) and connect again.");
  // Not only through a runner: a plain installed command is also refused.
  expect(rememberBlock(stdio("central-mcp-server", "central-mcp-server", []), match)).toContain("is not pinned");
  expect(rememberBlock(stdio("central-mcp-server", "uvx", ["central-mcp-server==1.4.2"]), match)).toBeUndefined();
  expect(rememberBlock(stdio("central-mcp-server", "uvx", ["--from", "git+https://github.com/k/central-mcp-server@0123abcd", "central-mcp-server"]), match)).toBeUndefined();
  expect(rememberBlock(stdio("central-mcp-server", "uvx", ["--from", "git+https://github.com/k/central-mcp-server@main", "central-mcp-server"]), match)).toContain("is not pinned");
  const { tools, labels } = await fixtureTools("karthik-like");
  const hidden = tools.filter((item) => isHidden(match, item, tightenSafety(match, item, labels.get(item.name)!), { writes: "off", access: "unknown" })).map((item) => item.name);
  expect(hidden.sort()).toEqual(["assign_device_group", "update_site_name"]);
  expect(tools.filter((item) => isHidden(match, item, labels.get(item.name)!, { writes: "on", access: "unknown" }))).toEqual([]);
});

test("runner pins: npx, bunx, pnpm dlx, uvx, uv tool run, pipx, docker", () => {
  const pinned = (command: string, args: string[]) => runnerPin(stdio("s", command, args))?.pinned;
  expect(pinned("npx", ["-y", "pkg"])).toBe(false);
  expect(pinned("npx", ["-y", "pkg@latest"])).toBe(false);
  expect(pinned("npx", ["-y", "pkg@^1.2.0"])).toBe(false);
  expect(pinned("npx", ["--yes", "@scope/pkg@1.2.3", "--flag"])).toBe(true);
  expect(pinned("npx", ["-y", "@scope/pkg"])).toBe(false);
  expect(pinned("bunx", ["pkg@1.0.0"])).toBe(true);
  expect(pinned("pnpm", ["dlx", "pkg"])).toBe(false);
  expect(pinned("uvx", ["pkg"])).toBe(false);
  expect(pinned("uvx", ["pkg>=1.0"])).toBe(false);
  expect(pinned("uvx", ["pkg==1.0.2"])).toBe(true);
  expect(pinned("uvx", ["--python", "3.12", "pkg==1.0.2"])).toBe(true);
  expect(pinned("uv", ["tool", "run", "pkg"])).toBe(false);
  expect(pinned("pipx", ["run", "pkg==2.0"])).toBe(true);
  expect(pinned("docker", ["run", "-i", "img"])).toBe(false);
  expect(pinned("docker", ["run", "-i", "img:latest"])).toBe(false);
  expect(pinned("docker", ["run", "-i", "localhost:5000/img"])).toBe(false);
  expect(pinned("docker", ["run", "-i", `img@sha256:${"a".repeat(64)}`])).toBe(true);
  expect(pinned("docker", ["run", "-i", "img:1.2"])).toBe(true);
  expect(runnerPin(stdio("s", "/usr/bin/python3", ["server.py"]))).toBeUndefined();
  expect(runnerPin(http("s", "https://example.net/mcp"))).toBeUndefined();
});

test("junos: labels, notes, hidden commits and the writes-off refusal", async () => {
  const definition = stdio("junos", "uv", ["run", "/opt/junos-mcp-server/jmcp.py", "-t", "stdio"]);
  const match = matchPreset(definition)!;
  expect(match.preset.id).toBe("junos-mcp-server");
  expect(match.preset.limits).toEqual({ callMs: 400_000 });
  const { tools, labels } = await fixtureTools("junos");
  const byName = (name: string) => tools.find((item) => item.name === name)!;
  const label = (name: string) => tightenSafety(match, byName(name), labels.get(name)!);
  expect(label("execute_junos_command")).toBe("exec");
  expect(label("execute_junos_command_batch")).toBe("exec");
  expect(label("execute_junos_pfe_command")).toBe("exec");
  expect(label("load_and_commit_config")).toBe("destructive");
  expect(label("render_and_apply_j2_template")).toBe("destructive");
  expect(label("get_junos_config")).not.toBe("read");
  expect(approvalNotes(match, byName("load_and_commit_config")).join(" ")).toContain("no auto-rollback");
  expect(approvalNotes(match, byName("load_and_commit_config"))).toEqual(["load_and_commit_config commits right away. No preview and no auto-rollback."]);
  expect(hasNoPreview(match, byName("load_and_commit_config"))).toBe(true);
  const off = { writes: "off" as const, access: "unknown" as const };
  const hidden = tools.filter((item) => isHidden(match, item, tightenSafety(match, item, labels.get(item.name)!), off)).map((item) => item.name).sort();
  expect(hidden).toEqual(["load_and_commit_config", "render_and_apply_j2_template"]);
  expect(guardArguments(match, byName("execute_junos_command"), { router_name: "r1", command: "request system reboot" }, { writes: "off", showOptIn: false }))
    .toEqual({ refuse: "Junos writes are off; only show commands run." });
  expect(guardArguments(match, byName("load_and_commit_config"), { router_name: "r1", config_text: "x" }, { writes: "off", showOptIn: true }))
    .toEqual({ refuse: "Junos writes are off; only show commands run." });
  expect(guardArguments(match, byName("execute_junos_command"), { router_name: "r1", command: "request system reboot" }, { writes: "on", showOptIn: true })).toBe("ask");
  expect(writesTitle("junos", match)).toBe("Junos writes are off.");
});

test("junos show opt-in: only plain show commands skip the question", async () => {
  const match = matchPreset(stdio("junos", "python3", ["/opt/jmcp.py"]))!;
  const { tools } = await fixtureTools("junos");
  const byName = (name: string) => tools.find((item) => item.name === name)!;
  const run = (name: string, args: Record<string, unknown>, showOptIn = true) => guardArguments(match, byName(name), args, { writes: "off", showOptIn });
  expect(run("execute_junos_command", { router_name: "r1", command: "show interfaces terse" })).toBe("allow");
  expect(run("execute_junos_command", { router_name: "r1", command: "show interfaces terse | match ge- | count" })).toBe("allow");
  expect(run("execute_junos_command", { router_name: "r1", command: "show interfaces terse" }, false)).toBe("ask");
  expect(run("execute_junos_command_batch", { router_names: ["r1", "r2"], command: "show version" })).toBe("allow");
  // These are not plain shows. With writes off they are refused, never allowed.
  for (const command of ["sh ver", "show configuration | save /var/tmp/x", "show version; request system reboot", "show version\nrequest system reboot",
    "show version | compare rollback 1", "SHOW version", "show", "request system reboot", "show version > /tmp/x"]) {
    expect(isPlainJunosShow(command)).toBe(false);
    expect(run("execute_junos_command", { router_name: "r1", command })).toEqual({ refuse: "Junos writes are off; only show commands run." });
  }
  expect(run("execute_junos_command_batch", { router_names: ["r1"], commands: ["show version", "request system reboot"] })).not.toBe("allow");
  expect(run("execute_junos_command", { router_name: "r1", command: 42 })).not.toBe("allow");
  // PFE commands always ask.
  expect(run("execute_junos_pfe_command", { router_name: "r1", command: "show jnh 0 pool summary", target: "fpc0" })).toBe("ask");
  // With writes on, anything else asks instead of being refused.
  expect(guardArguments(match, byName("execute_junos_command"), { router_name: "r1", command: "sh ver" }, { writes: "on", showOptIn: true })).toBe("ask");
});

test("an HTTP server with the junos tool names gets junos rules without a definition match, and the can't-pin line", async () => {
  const definition = http("junos", "http://127.0.0.1:30030/mcp");
  expect(matchPreset(definition)).toBeUndefined();
  const { tools, labels } = await fixtureTools("junos");
  const match = matchPreset(definition, tools)!;
  expect(match).toMatchObject({ by: "tools", mismatch: false });
  expect(match.preset.id).toBe("junos-mcp-server");
  const commit = tools.find((item) => item.name === "load_and_commit_config")!;
  expect(tightenSafety(match, commit, labels.get(commit.name)!)).toBe("destructive");
  expect(presetLine(match, planPins(definition, match.preset))).toEqual([
    "preset: junos-mcp-server",
    "Can't pin read-only for this server (it runs elsewhere). Every change asks you in Casper.",
  ]);
});

test("an hpe definition whose tools look different keeps its pins and says so", async () => {
  const definition = stdio("hpe", "python", hpeRouterArgs);
  const { tools } = await fixtureTools("karthik-like");
  const match = matchPreset(definition, tools)!;
  expect(match).toMatchObject({ by: "definition", mismatch: true });
  const plan = planPins(definition, match.preset);
  expect(plan.kind).toBe("pinned");
  expect(presetLine(match, plan)).toContain("Looks different from the hpe-networking-mcp preset. Pins kept, and its extra checks still apply.");
  const fitting = matchPreset(definition, (await fixtureTools("hpe-router")).tools)!;
  expect(fitting.mismatch).toBe(false);
});

test("hpe hides invoke_tool while writes are off, and a read-only login hides every non-read tool", async () => {
  const definition = stdio("hpe", "python", hpeRouterArgs);
  const { tools, labels } = await fixtureTools("hpe-router");
  const match = matchPreset(definition, tools)!;
  const hidden = (writes: "off" | "on", access: "read-only" | "unknown") => tools
    .filter((item) => isHidden(match, item, tightenSafety(match, item, labels.get(item.name)!), { writes, access })).map((item) => item.name).sort();
  expect(hidden("off", "unknown")).toEqual(["invoke_tool", "invoke_tools_batch"]);
  expect(hidden("on", "unknown")).toEqual([]);
  expect(hidden("on", "read-only")).toEqual(["invoke_tool", "invoke_tools_batch"]);
  // Without a preset a read-only login still hides tools that are not read.
  expect(isHidden(undefined, tool("mystery"), "external-action", { writes: "on", access: "read-only" })).toBe(true);
  expect(isHidden(undefined, tool("set_x"), "write", { writes: "off", access: "unknown" })).toBe(true);
  expect(isHidden(undefined, tool("mystery"), "external-action", { writes: "off", access: "unknown" })).toBe(false);
});

test("advice and notes for servers Casper can't pin", () => {
  const mist = matchPreset(http("mist", "https://mcp.mist.com/mcp"))!;
  expect(mist.preset.id).toBe("mist-hosted");
  expect(presetLine(mist, planPins(http("mist", "https://mcp.mist.com/mcp"), mist.preset))).toEqual([
    "preset: mist-hosted",
    "Can't pin read-only for this server (it runs elsewhere). Every change asks you in Casper.",
    "Access not checked. Use a read-only (Observer) org token for this server.",
  ]);
  expect(matchPreset(http("x", "https://notmist.com.example.net/mcp"))).toBeUndefined();
  const netmiko = stdio("netmiko", "python", ["/opt/netmiko_mcp/server.py"]);
  expect(rememberBlock(netmiko, matchPreset(netmiko))).toBe("Not remembered: netmiko can send config to devices, and Casper can't check its allowlist. Connect it each time.");
  const oxidized = matchPreset(stdio("oxidized", "/opt/oxidized-mcp", []))!;
  expect(oxidized.preset.advice).toContain("passwords");
});

test("the enable text notices when the user's own settings still keep writes off", () => {
  const own = stdio("hpe", "python", hpeRouterArgs, { HPE_MCP_ACCESS_PROFILE: "safe-read-only" });
  own.source = path.join(process.env.HOME ?? "/home/u", ".claude.json");
  expect(ownSettingsNote(own, matchPreset(own))).toBe(
    "Casper removed its read-only pins, but your own settings still keep writes off (HPE_MCP_ACCESS_PROFILE=safe-read-only in ~/.claude.json).");
  expect(ownSettingsNote(stdio("hpe", "python", hpeRouterArgs, { HPE_MCP_CENTRAL_WRITES: "1" }), matchPreset(own))).toBeUndefined();
  expect(writesTitle("aruba-central", matchPreset(stdio("aruba-central", "centralmcp", [])))).toBe("Central writes are off.");
  expect(writesTitle("my-server")).toBe("my-server writes are off.");
});
