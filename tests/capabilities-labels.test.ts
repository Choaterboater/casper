import { expect, test } from "bun:test";
import type { MCPTool } from "../src/mcp/manager";
import {
  type CapabilitySafety, legacyLabel, nameLabel, SAFETY_RANK, strictest, toolLabel, toolWords, wordLabel,
} from "../src/capabilities/labels";

type Tool = Pick<MCPTool, "name" | "annotations" | "_meta">;
const readOnly = (name: string, extra: Partial<Tool> = {}): Tool => ({ name, annotations: { readOnlyHint: true }, ...extra });

/** broker.ts safety() as shipped in Casper 0.2.14, frozen here so later edits can't move the bar. */
function safety0214(tool: Tool): CapabilitySafety {
  if (tool.name === "invoke_tool" || tool.name === "invoke_tools_batch" || tool.annotations?.destructiveHint === true) return "destructive";
  if (/\b(delete|destroy|remove|reset|reboot|wipe)\b/.test(tool.name.replaceAll("_", " "))) return "destructive";
  if (/\b(exec|execute|shell|run)\b/.test(tool.name.replaceAll("_", " "))) return "exec";
  if (/\b(create|update|set|write|deploy)\b/.test(tool.name.replaceAll("_", " "))) return "write";
  const declared = tool._meta?.["casper/safety"];
  if (typeof declared === "string" && ["diagnostic", "write", "destructive", "exec", "external-action"].includes(declared)) return declared as CapabilitySafety;
  return tool.annotations?.readOnlyHint === true ? "read" : "external-action";
}
const atLeast = (label: CapabilitySafety, floor: CapabilitySafety) => SAFETY_RANK[label] >= SAFETY_RANK[floor];

test("strictest picks the highest rank, and read when given nothing", () => {
  expect(strictest()).toBe("read");
  expect(strictest("read", "diagnostic")).toBe("diagnostic");
  expect(strictest("write", "external-action", "exec")).toBe("exec");
  expect(strictest("destructive", "read")).toBe("destructive");
});

test("toolWords splits snake, kebab, dots and camelCase into whole lowercase words", () => {
  expect(toolWords("rebootDevice")).toEqual(["reboot", "device"]);
  expect(toolWords("clearpass-disconnect-session")).toEqual(["clearpass", "disconnect", "session"]);
  expect(toolWords("device.reload_now")).toEqual(["device", "reload", "now"]);
  expect(toolWords("getHTTPStatus")).toEqual(["get", "http", "status"]);
  expect(toolWords("aos8_show_command")).toEqual(["aos8", "show", "command"]);
});

test("network action names always ask, even when the server says read-only", () => {
  const names = ["bounce_interface", "reload_switch", "restart_ap", "gateway_halt", "disconnect_client", "deauth_client",
    "rollback_config", "rebootDevice", "clearpass-disconnect-session", "poe_bounce", "port_bounce", "zeroize_device"];
  for (const name of names) {
    expect(safety0214(readOnly(name))).toBe("read"); // 0.2.14 let these run with no question.
    expect(toolLabel(readOnly(name))).toBe("destructive");
  }
});

test("change words tighten read-only tools that 0.2.14 let through", () => {
  for (const name of ["load_and_commit_config", "apply_template"]) {
    expect(toolLabel(readOnly(name))).toBe("write");
    expect(toolLabel({ name })).toBe("write");
  }
  expect(safety0214(readOnly("load_and_commit_config"))).toBe("read");
  expect(safety0214({ name: "apply_template" })).toBe("external-action");
});

test("destructive and run words anywhere tighten, even after a read word", () => {
  for (const name of ["get_and_delete_site", "show_then_reboot", "list_wipe_candidates", "get_bounce_ports", "show_and_reload"]) {
    expect(toolLabel(readOnly(name))).toBe("destructive");
  }
  expect(toolLabel(readOnly("show_then_run_script"))).toBe("exec");
  expect(toolLabel(readOnly("cx_run_cli"))).toBe("exec");
});

test("the owner's read-only tools stay read, and the honest name reading of the rest is read", () => {
  for (const name of ["aos8_plan_migration_rollback", "get_config_rollback_status", "get_glp_block_storage_volume",
    "get_glp_block_storage_volumes", "get_glp_service_provision", "cx_show", "load_skill", "get_device", "list_sites"]) {
    expect(toolLabel(readOnly(name))).toBe("read");
  }
  // The word lists read these as reads (for label checks), but Casper still asks, as 0.2.14 did.
  for (const [name, today] of [["glp_write_status", "write"], ["aos8_get_migration_run", "exec"], ["aos8_verify_migration_run", "exec"]] as const) {
    expect(wordLabel(name)).toBe("read");
    expect(toolLabel(readOnly(name))).toBe(today);
    expect(safety0214(readOnly(name))).toBe(today);
  }
});

test("a change word just before a read noun names what is read; elsewhere it still tightens", () => {
  expect(wordLabel("glp_write_status")).toBe("read");
  expect(wordLabel("port_commit_history")).toBe("read");
  expect(wordLabel("edgeconnect_enable_zone_firewall_status")).toBe("write");
  expect(wordLabel("enable_status")).toBe("write");
  expect(toolLabel(readOnly("device_push_state"))).toBe("read");
  expect(toolLabel(readOnly("push_device_state"))).toBe("write");
  // Destructive words ignore the ending: a reboot_status tool still asks.
  expect(toolLabel(readOnly("ap_reboot_status"))).toBe("destructive");
});

test("the noun allowlist is keyed by exact name only", () => {
  expect(toolLabel(readOnly("get_config_rollback_status"))).toBe("read");
  expect(toolLabel(readOnly("get_config_rollback_status_now"))).toBe("destructive");
  expect(toolLabel(readOnly("do_config_rollback"))).toBe("destructive");
});

test("_meta casper/safety only tightens, and may relax only an unannotated tool to diagnostic", () => {
  expect(toolLabel({ name: "reboot_x", _meta: { "casper/safety": "diagnostic" } })).toBe("destructive");
  expect(toolLabel(readOnly("reboot_x", { _meta: { "casper/safety": "diagnostic" } }))).toBe("destructive");
  expect(toolLabel({ name: "ap_ping", _meta: { "casper/safety": "diagnostic" } })).toBe("diagnostic");
  expect(toolLabel(readOnly("get_site", { _meta: { "casper/safety": "destructive" } }))).toBe("destructive");
  expect(toolLabel(readOnly("get_site", { _meta: { "casper/safety": "write" } }))).toBe("write");
  expect(toolLabel(readOnly("get_site", { _meta: { "casper/safety": "read" } }))).toBe("read");
  expect(toolLabel({ name: "get_site", _meta: { "casper/safety": "read" } })).toBe("external-action");
  expect(toolLabel({ name: "wipe_x", annotations: { destructiveHint: true }, _meta: { "casper/safety": "diagnostic" } })).toBe("destructive");
});

test("only readOnlyHint true can give read; generic dispatchers stay destructive", () => {
  expect(toolLabel({ name: "get_site" })).toBe("external-action");
  expect(toolLabel({ name: "get_site", annotations: { readOnlyHint: false } })).toBe("external-action");
  expect(toolLabel(readOnly("get_site"))).toBe("read");
  expect(toolLabel(readOnly("get_site", { annotations: { readOnlyHint: true, destructiveHint: true } }))).toBe("destructive");
  expect(toolLabel(readOnly("invoke_tool"))).toBe("destructive");
  expect(toolLabel(readOnly("invoke_tools_batch"))).toBe("destructive");
  expect(nameLabel("invoke_read_tool")).toBe("read");
});

test("every name 0.2.14 labelled destructive, exec or write keeps at least that label at readOnlyHint true", () => {
  const verbs = ["delete", "destroy", "remove", "reset", "reboot", "wipe", "exec", "execute", "shell", "run",
    "create", "update", "set", "write", "deploy"];
  const shapes = (verb: string) => [verb, `${verb}_site`, `site_${verb}`, `get_${verb}`, `get_and_${verb}_site`,
    `show_then_${verb}`, `list_${verb}_candidates`, `${verb}-device`, `device.${verb}`, `get_${verb}_status`,
    `glp_${verb}_status`, `${verb}_config_state`, `aos8_get_migration_${verb}`];
  let checked = 0;
  for (const verb of verbs) for (const name of shapes(verb)) for (const tool of [readOnly(name), { name },
    readOnly(name, { _meta: { "casper/safety": "diagnostic" } })]) {
    const today = safety0214(tool);
    if (today === "read") continue;
    checked++;
    expect([name, atLeast(toolLabel(tool), today)]).toEqual([name, true]);
    expect([name, atLeast(nameLabel(name), today === "external-action" || today === "diagnostic" ? "read" : today)]).toEqual([name, true]);
  }
  expect(checked).toBeGreaterThan(300);
});

test("random names, annotations and _meta never get a looser label than 0.2.14", () => {
  const pool = ["get", "list", "show", "status", "delete", "reboot", "run", "set", "write", "bounce", "commit", "apply",
    "device", "site", "config", "rollback", "migration", "block", "provision", "state", "history", "invoke", "tool",
    "count", "diff", "exec", "wipe", "and", "then", "clear", "sync"];
  const metas = [undefined, "read", "diagnostic", "write", "destructive", "exec", "external-action", "bogus"];
  let seed = 7;
  const next = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let i = 0; i < 5000; i++) {
    const words = Array.from({ length: 1 + next(4) }, () => pool[next(pool.length)]!);
    const name = words.join(["_", "-", "."][next(3)]!);
    const meta = metas[next(metas.length)];
    const tool: Tool = {
      name,
      annotations: next(3) === 0 ? undefined : { readOnlyHint: next(2) === 0, destructiveHint: next(4) === 0 },
      _meta: meta ? { "casper/safety": meta } : undefined,
    };
    expect([name, meta, atLeast(toolLabel(tool), safety0214(tool))]).toEqual([name, meta, true]);
    expect(legacyLabel(tool)).toBe(safety0214(tool));
  }
});
