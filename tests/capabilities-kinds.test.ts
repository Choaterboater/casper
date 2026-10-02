import { expect, test } from "bun:test";
import { buildPlan } from "../src/capabilities/approval";
import { changeKind, planKinds, RISKY_KINDS, isRiskyKind } from "../src/capabilities/kinds";
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

test("the kind box: plain words, the real tool, 1 No and 2 Allow for this session", async () => {
  const { kindBox } = await import("../src/capabilities/approval");
  const box = kindBox("firmware", "Mist", "trigger_device_upgrade");
  expect(box.preview).toBe("Firmware changes are off by default on Mist.\n  Runs: trigger device upgrade\n  1 No\n  2 Allow firmware changes for this session\n");
  expect(box.question).toBe("Type 1 or 2: ");
  expect(box.choices).toEqual(["1", "2"]);
});

test("review: a router call to a tool whose name reads as a read still gets its risky kind", () => {
  const router = { type: "object" as const, properties: { name: { type: "string" }, arguments: { type: "object" } } };
  const call = buildPlan({ server: "net", tool: "invoke_tool", label: "destructive", schema: router,
    arguments: { name: "invite_glp_user", arguments: {} } });
  expect(planKinds(call)).toEqual(["admin"]);
});
