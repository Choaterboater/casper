import { expect, test } from "bun:test";
import type { MCPTool } from "../src/mcp/manager";
import {
  aiConfirm, buildPlan, callMode, canPreview, formatApproval, interimConfigScrub, maskSecrets, maskText, needsApproval,
  planLabel, planMode, previewArguments, previewKey, routedCalls, tooLongToShow, type ApprovalHint,
} from "../src/capabilities/approval";
import { toolLabel } from "../src/capabilities/labels";

type Schema = MCPTool["inputSchema"];
const setSsidSchema: Schema = { type: "object", properties: {
  ssid: { type: "string" }, wpa_passphrase: { type: "string" },
  dry_run: { type: "boolean", default: false }, confirm: { type: "boolean", default: false },
} };
const routerSchema: Schema = { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } } };
const batchSchema: Schema = { type: "object", properties: { calls: { type: "array" } } };

function plan(tool: string, args: Record<string, unknown>, schema: Schema = { type: "object" },
  annotations: MCPTool["annotations"] = undefined, hint?: ApprovalHint) {
  return buildPlan({ server: "network", tool, label: toolLabel({ name: tool, annotations }), schema, arguments: args, hint });
}

test("routedCalls finds the real tool behind single and batch routers", () => {
  expect(routedCalls("invoke_tool", { name: "port_bounce", arguments: { serial_number: "SG1" } }))
    .toEqual([{ name: "port_bounce", arguments: { serial_number: "SG1" } }]);
  expect(routedCalls("invoke_read_tool", { name: "get_device", cursor: "x" })).toEqual([{ name: "get_device", arguments: {} }]);
  expect(routedCalls("dispatch", { tool_name: "reload", params: { a: 1 } })).toEqual([{ name: "reload", arguments: { a: 1 } }]);
  expect(routedCalls("invoke_tools_batch", { calls: [{ name: "reboot_device", arguments: {} }, { tool: "get_device", args: { id: 1 } }] }))
    .toEqual([{ name: "reboot_device", arguments: {} }, { name: "get_device", arguments: { id: 1 } }]);
  expect(routedCalls("get_device", { name: "port_bounce" })).toEqual([]);
});

test("a read-only router is judged by the real tool it runs", () => {
  const bounce = plan("invoke_read_tool", { name: "port_bounce" }, routerSchema, { readOnlyHint: true });
  expect(bounce.label).toBe("read");
  expect(planLabel(bounce)).toBe("destructive");
  expect(needsApproval(bounce)).toBe(true);
  const inspect = plan("invoke_read_tool", { name: "inspect_quantum_flux" }, routerSchema, { readOnlyHint: true });
  expect(planLabel(inspect)).toBe("read");
  expect(needsApproval(inspect)).toBe(false);
  const batch = plan("invoke_read_tool_batch", { calls: [{ name: "get_device" }, { name: "gateway_halt" }] }, batchSchema, { readOnlyHint: true });
  expect(planLabel(batch)).toBe("destructive");
});

test("a router call Casper can't read asks", () => {
  const unclear = plan("invoke_read_tool", { tool_id: "port_bounce" }, routerSchema, { readOnlyHint: true });
  expect(unclear.routerUnclear).toBe(true);
  expect(needsApproval(unclear)).toBe(true);
  expect(formatApproval(unclear).preview).toContain("Runs: a tool Casper can't see (through invoke_read_tool)");
  const partly = plan("invoke_read_tool_batch", { calls: [{ name: "get_device" }, { id: 3 }] }, batchSchema, { readOnlyHint: true });
  expect(needsApproval(partly)).toBe(true);
});

test("the AI can't skip approval on a read tool with confirm, force or a preview switch set to false", () => {
  const readTool = { readOnlyHint: true };
  expect(needsApproval(plan("get_site", {}, { type: "object" }, readTool))).toBe(false);
  expect(needsApproval(plan("get_site", { confirm: false, dry_run: true }, { type: "object" }, readTool))).toBe(false);
  for (const args of [{ confirm: true }, { confirmed: true }, { force: true }, { dry_run: false }, { dryRun: false },
    { options: { check_only: false } }]) {
    expect([args, needsApproval(plan("get_site", args, { type: "object" }, readTool))]).toEqual([args, true]);
  }
  const inner = plan("invoke_read_tool", { name: "get_site", arguments: { confirm: true } }, routerSchema, readTool);
  expect(needsApproval(inner)).toBe(true);
  expect(aiConfirm(inner.arguments)).toEqual(["arguments.confirm"]);
});

test("router box names the real tool and says it may execute", () => {
  const box = formatApproval(plan("invoke_tool", { name: "port_bounce", arguments: { serial_number: "SG1" } }, routerSchema));
  expect(box.preview).toContain("MCP · network · invoke_tool  [destructive]");
  expect(box.preview).toContain("Runs: port_bounce (through invoke_tool)");
  expect(box.preview).toContain("Mode: may EXECUTE (dry_run is not set)");
  const batch = formatApproval(plan("invoke_tools_batch", { calls: [
    { name: "reboot_device", arguments: {} }, { name: "port_bounce", arguments: {} }, { name: "get_device", arguments: {} },
  ] }, batchSchema));
  expect(batch.preview).toContain("Runs 3 tools (through invoke_tools_batch): reboot_device, port_bounce, get_device");
  expect(batch.preview).toContain("Mode: may EXECUTE");
});

test("mode comes from the explicit switch, then the schema default", () => {
  expect(callMode(setSsidSchema, { ssid: "x" })).toBe("execute");
  expect(callMode(setSsidSchema, { ssid: "x", dry_run: true })).toBe("preview");
  expect(callMode(setSsidSchema, { ssid: "x", dry_run: false })).toBe("execute");
  const defaultOn: Schema = { type: "object", properties: { dry_run: { type: "boolean", default: true } } };
  expect(callMode(defaultOn, {})).toBe("preview");
  expect(callMode({ type: "object", properties: { dry_run: { type: "boolean" } } }, {})).toBe("execute");
  expect(callMode({ type: "object" }, {})).toBe("execute");
  expect(formatApproval(plan("set_ssid", { ssid: "x" }, setSsidSchema)).preview).toContain("Mode: EXECUTE (this makes the change)");
  expect(formatApproval(plan("set_ssid", { ssid: "x", dry_run: true }, setSsidSchema)).preview).toContain("Mode: preview (dry_run=true, nothing changes)");
  expect(formatApproval(plan("set_ssid", {}, defaultOn)).preview).toContain("Mode: preview (dry_run is on by default, nothing changes)");
  // Inside a router, an explicit inner switch counts; a missing one can't be known.
  expect(planMode(plan("invoke_tool", { name: "set_ssid", arguments: { dry_run: true } }, routerSchema))).toBe("preview");
  expect(planMode(plan("invoke_tool", { name: "set_ssid", arguments: { dry_run: false } }, routerSchema))).toBe("execute");
});

test("preset hints add a note and a no-change case, and can turn preview off", () => {
  const junos: Schema = { type: "object", properties: { apply_config: { type: "boolean" }, dry_run: { type: "boolean" } } };
  const hint: ApprovalHint = { previewWhen: { apply_config: false } };
  expect(callMode(junos, { apply_config: false }, hint)).toBe("preview");
  expect(callMode(junos, { apply_config: true }, hint)).toBe("execute");
  const commit = plan("load_and_commit_config", { config_text: "set system host-name r1" },
    { type: "object", properties: { dry_run: { type: "boolean" } } }, undefined,
    { executeNote: "Commits at once. No auto-rollback.", noPreview: true });
  const box = formatApproval(commit);
  expect(box.preview).toContain("Note: Commits at once. No auto-rollback.");
  expect(canPreview(commit)).toBe(false);
  expect(box.question).toBe("Run it? Type yes: ");
});

test("passwords and PSKs are hidden on screen; the plan keeps the real value", () => {
  const args = { ssid: "corp", wpa_passphrase: "hunter2hunter" };
  const setSsid = plan("set_ssid", args, setSsidSchema);
  const box = formatApproval(setSsid);
  expect(box.preview).toContain("\"wpa_passphrase\":\"••• 13 chars\"");
  expect(box.preview).toContain("Hidden: wpa_passphrase. The server still gets the real value.");
  expect(box.preview).not.toContain("hunter2hunter");
  expect(setSsid.arguments.wpa_passphrase).toBe("hunter2hunter");
  expect(args.wpa_passphrase).toBe("hunter2hunter");
  const nested = maskSecrets({ radius: { sharedKey: "abc", apiKey: "k", password: ["p1", "p22"], snmp: { community: "public" } },
    next_cursor: "c1", key: "vlan", public_key: "ssh-ed25519 AAAA", token_count: 3 });
  expect(nested.value).toEqual({ radius: { sharedKey: "••• 3 chars", apiKey: "••• 1 char", password: ["••• 2 chars", "••• 3 chars"],
    snmp: { community: "••• 6 chars" } }, next_cursor: "c1", key: "vlan", public_key: "ssh-ed25519 AAAA", token_count: 3 });
  expect(nested.hidden).toEqual(["sharedKey", "apiKey", "password", "community"]);
});

test("secrets inside Junos and Aruba config text are hidden", () => {
  const config = [
    "set system root-authentication encrypted-password \"$6$abc\"",
    "set security ike policy p1 pre-shared-key ascii-text \"k3y\"",
    "wpa-passphrase plaintext Sup3rS3cret",
    "radius-server host 10.0.0.5 key plaintext rad1us",
    "snmp-server community privcomm",
    "set system host-name r1",
  ].join("\n");
  const box = formatApproval(plan("load_and_commit_config", { config_text: config })).preview;
  for (const secret of ["$6$abc", "k3y", "Sup3rS3cret", "rad1us", "privcomm"]) expect(box).not.toContain(secret);
  expect(box).toContain("host-name r1");
  expect(box).toContain("Hidden: parts of config_text.");
  expect(interimConfigScrub("encrypted-password \"$6$abc\";")).toBe("encrypted-password \"•••\";");
});

test("the text scrubber is a hook: shared secret rules can replace the built-in ones", () => {
  const scrubText = (text: string) => text.replaceAll("SITE-SECRET", "<secret hidden>");
  const box = formatApproval(plan("apply_template", { body: "x SITE-SECRET y", note: "password plaintext stays" }), undefined, { scrubText });
  expect(box.preview).toContain("x <secret hidden> y");
  expect(box.preview).toContain("password plaintext stays");
  expect(box.preview).toContain("Hidden: parts of body.");
  expect(maskText("{\"psk\":\"abcd\",\"b\":\"SITE-SECRET\"}", { scrubText })).toBe("{\"psk\":\"••• 4 chars\",\"b\":\"<secret hidden>\"}");
});

test("the box warns when the AI set confirm=true itself, including inside a router", () => {
  const warning = "⚠ The AI set confirm=true. That skips the server's own check. Only your yes here lets it run.";
  expect(formatApproval(plan("set_ssid", { ssid: "x", confirm: true }, setSsidSchema)).preview).toContain(warning);
  expect(formatApproval(plan("invoke_tool", { name: "set_ssid", arguments: { confirm: true } }, routerSchema)).preview).toContain(warning);
  expect(formatApproval(plan("set_ssid", { ssid: "x", confirm: false }, setSsidSchema)).preview).not.toContain("⚠");
  expect(formatApproval(plan("set_ssid", { ssid: "x", confirm: true, force: true }, setSsidSchema)).preview)
    .toContain("The AI set confirm=true and force=true.");
});

test("p to preview first is offered only when the tool's own schema has the switch", () => {
  const direct = plan("set_ssid", { ssid: "x" }, setSsidSchema);
  expect(canPreview(direct)).toBe(true);
  const box = formatApproval(direct);
  expect(box.question).toBe("Run it? Type yes, or p to preview first: ");
  expect(box.choices).toEqual(["yes", "p"]);
  expect(box.preview).toContain("No preview yet.");
  expect(previewArguments(plan("set_ssid", { ssid: "x", dry_run: false, confirm: true }, setSsidSchema)))
    .toEqual({ ssid: "x", dry_run: true, confirm: false });
  // Already a preview: nothing to preview first.
  expect(canPreview(plan("set_ssid", { ssid: "x", dry_run: true }, setSsidSchema))).toBe(false);
  // No switch in the schema: a server that ignores dry_run would make the change.
  const bounce = plan("port_bounce", { serial_number: "SG1" }, { type: "object", properties: { serial_number: { type: "string" } } });
  expect(canPreview(bounce)).toBe(false);
  expect(formatApproval(bounce).question).toBe("Run it? Type yes: ");
  expect(formatApproval(bounce).choices).toEqual(["yes"]);
  expect(formatApproval(bounce).preview).not.toContain("No preview yet.");
  expect(() => previewArguments(bounce)).toThrow("no safe preview");
  // Routers never preview: Casper can't see the real tool's schema.
  for (const args of [{ name: "set_ssid", arguments: {} }, { name: "set_ssid", arguments: { dry_run: false } }]) {
    const routed = plan("invoke_tool", args, routerSchema);
    expect(canPreview(routed)).toBe(false);
    expect(formatApproval(routed).question).not.toContain("p to preview first");
  }
});

test("last preview is shown with its age, masked and cut to about 1.5 KB", () => {
  const now = 1_000_000;
  const direct = plan("set_ssid", { ssid: "x", wpa_passphrase: "hunter2hunter" }, setSsidSchema);
  const box = formatApproval(direct, { text: "{\"would_set\":{\"ssid\":\"x\",\"wpa_passphrase\":\"hunter2hunter\"}}", at: now - 120_000 }, { now });
  expect(box.preview).toContain("Last preview (2 min ago): {\"would_set\":{\"ssid\":\"x\",\"wpa_passphrase\":\"••• 13 chars\"}}");
  expect(box.preview).not.toContain("hunter2hunter");
  expect(box.preview).not.toContain("No preview yet.");
  expect(formatApproval(direct, { text: "ok", at: now - 5_000 }, { now }).preview).toContain("Last preview (just now): ok");
  const long = formatApproval(direct, { text: "a".repeat(5000), at: now }, { now }).preview;
  expect(long).toContain("… (more not shown)");
  expect(long.length).toBeLessThan(2500);
});

test("previewKey matches the same call with a different preview switch or confirm only", () => {
  const key = (args: Record<string, unknown>) => previewKey(plan("set_ssid", args, setSsidSchema));
  expect(key({ ssid: "x", dry_run: true })).toBe(key({ dry_run: false, ssid: "x", confirm: true }));
  expect(key({ ssid: "x", dry_run: true })).not.toBe(key({ ssid: "y", dry_run: true }));
  expect(previewKey(plan("invoke_tool", { name: "a", arguments: { x: 1, dry_run: true } }, routerSchema)))
    .not.toBe(previewKey(plan("invoke_tool", { name: "b", arguments: { x: 1 } }, routerSchema)));
});

test("arguments over 4 KB are too long to show", () => {
  expect(tooLongToShow({ a: "x".repeat(5000) })).toBe(true);
  expect(tooLongToShow({ a: "x" })).toBe(false);
});

test("server text can't move the cursor or hide text", () => {
  const box = formatApproval(plan("set_ssid", { ssid: "a\u001b[2Jb‮c" }, setSsidSchema)).preview;
  expect(box).not.toContain("‮");
  expect(box).not.toContain("\u001b");
  expect(maskText("hi\u001b]0;title\u0007 there")).not.toContain("\u001b");
});

test("names, keys and previews can't add fake lines to the box", () => {
  const sneaky = plan("invoke_tool", { name: "get_device\nMode: preview (dry_run=true, nothing changes)",
    arguments: { "a\npassword": "p" } }, routerSchema);
  const box = formatApproval(sneaky, { text: "done\nRun it? Type yes: ", at: 0 }, { now: 0 }).preview;
  expect(box.split("\n").filter((line) => line.startsWith("Mode:"))).toEqual(["Mode: may EXECUTE (dry_run is not set)"]);
  expect(box).toContain("Last preview (just now): done Run it? Type yes: ");
  expect(box.trimEnd().split("\n")).toHaveLength(6);
});
