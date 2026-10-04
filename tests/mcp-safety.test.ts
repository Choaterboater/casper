import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MCPManager, type MCPManagerOptions, type ServerQuestion, type ServerQuestionAnswer } from "../src/mcp/manager";
import type { MCPServerDefinition } from "../src/mcp/config";
import { CapabilityBroker, type ApprovalAnswer, type ConfirmCapability, type ConfirmKind } from "../src/capabilities/broker";
import { formatApproval } from "../src/capabilities/approval";

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fixturePath = path.join(import.meta.dir, "fixtures/mcp-server.ts");

async function callsFile(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-safety-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "calls.jsonl");
}
async function calls(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}
function definition(name: string, mode: string, file: string): MCPServerDefinition {
  return { name, source: "fixture", cwd: process.cwd(), disabled: false, transport: {
    type: "stdio", command: process.execPath, args: [fixturePath], env: { FIXTURE_MODE: mode, FIXTURE_ID: name, FIXTURE_CALLS_FILE: file },
  } };
}
async function setup(options: {
  mode?: string; name?: string; confirm?: ConfirmCapability; elicit?: MCPManagerOptions["elicit"]; manager?: MCPManagerOptions; writesGate?: boolean;
  confirmKind?: ConfirmKind;
} = {}) {
  const file = await callsFile();
  const name = options.name ?? "network";
  const notes: string[] = [];
  const mcp = new MCPManager({ servers: [definition(name, options.mode ?? "network", file)], diagnostics: [] }, {
    ...(options.elicit ? { elicit: options.elicit } : {}), onNote: (text) => notes.push(text), ...options.manager,
  });
  const broker = new CapabilityBroker(mcp, options.confirm, {
    ...(options.writesGate ? { writesGate: true } : {}), ...(options.confirmKind ? { confirmKind: options.confirmKind } : {}),
  });
  cleanup.push(() => broker.close());
  await mcp.connect(name);
  await broker.prepare("network");
  return { mcp, broker, file, notes, id: (tool: string) => `mcp:${name}:${tool}` };
}
/** A confirm callback that answers from a list and keeps every box it was shown. */
function answering(...answers: ApprovalAnswer[]) {
  const boxes: string[] = [];
  const confirm: ConfirmCapability = async (call) => {
    const box = formatApproval(call.plan, call.lastPreview, call.tool ? { tool: call.tool } : {});
    boxes.push(box.preview + box.question);
    return answers.shift() ?? false;
  };
  return { confirm, boxes };
}
const toolCalls = (entries: Record<string, unknown>[]) => entries.filter((entry) => "tool" in entry);
const questions = (entries: Record<string, unknown>[]) => entries.filter((entry) => "question" in entry);

// --- labels in the broker --------------------------------------------------------------------

test("network action names ask even when the server marks them read-only", async () => {
  const { confirm, boxes } = answering(false, false);
  const { broker, file, id } = await setup({ confirm });
  for (const tool of ["bounce_interface", "reload_switch"]) {
    await expect(broker.invoke(id(tool), { serial_number: "SG1" })).rejects.toThrow("Not executed (you said no)");
  }
  expect(boxes[0]).toContain("MCP · network · bounce_interface  [destructive]");
  expect(toolCalls(await calls(file))).toEqual([]);
  expect(broker.search("bounce")[0]?.safety).toBe("destructive");
});

test("a read router is judged by the real tool behind it", async () => {
  const { confirm, boxes } = answering(false);
  const { broker, file, id } = await setup({ mode: "router", name: "r", confirm });
  await expect(broker.invoke(id("invoke_read_tool"), { name: "port_bounce", arguments: {} })).rejects.toThrow("Not executed (you said no)");
  expect(toolCalls(await calls(file))).toEqual([]);
  expect(boxes[0]).toContain("Runs: port_bounce (through invoke_read_tool)");
  // A real read behind the same router still runs without asking.
  const result = await broker.invoke(id("invoke_read_tool"), { name: "inspect_quantum_flux", arguments: { site: "a" } });
  expect(JSON.stringify(result)).toContain("counter");
  expect(boxes).toHaveLength(1);
});

test("the AI setting confirm=true on a read tool still asks the user", async () => {
  const { confirm, boxes } = answering(false);
  const { broker, file, id } = await setup({ confirm });
  await expect(broker.invoke(id("get_clients"), { site: "a", confirm: true })).rejects.toThrow("Not executed (you said no)");
  expect(boxes[0]).toContain("⚠ The AI set confirm=true.");
  expect(toolCalls(await calls(file))).toEqual([]);
  // Without confirm the read runs and nobody is asked.
  await broker.invoke(id("get_clients"), { site: "a" });
  expect(boxes).toHaveLength(1);
});

test("a one-shot broker (nobody to ask) refuses with 'cannot ask' and sends nothing", async () => {
  const { broker, file, id } = await setup();
  await expect(broker.invoke(id("get_clients"), { confirm: true })).rejects.toThrow("Not executed (needs your approval, and this run cannot ask)");
  expect(toolCalls(await calls(file))).toEqual([]);
});

// --- the approval box --------------------------------------------------------------------------

test("router calls show the real tool and 'may EXECUTE'", async () => {
  const { confirm, boxes } = answering(false);
  const { broker, id } = await setup({ confirm });
  await expect(broker.invoke(id("invoke_tool"), { name: "port_bounce", arguments: { serial_number: "SG1" } })).rejects.toThrow("you said no");
  expect(boxes[0]).toContain("Runs: port_bounce (through invoke_tool)");
  expect(boxes[0]).toContain("May make the change (dry_run is not set).");
  expect(boxes[0]).toContain("Type 1, 2 or 3: ");
  expect(boxes[0]).not.toContain("Preview first");
});

test("secrets are hidden in the box, and the server still gets the real value", async () => {
  const { confirm, boxes } = answering(true);
  const { broker, file, id } = await setup({ confirm });
  await broker.invoke(id("set_ssid"), { ssid: "corp", wpa_passphrase: "hunter2hunter" });
  expect(boxes[0]).toContain("This makes the change.");
  expect(boxes[0]).toContain("  wpa_passphrase   ••• 13 chars\n");
  expect(boxes[0]).toContain("Hidden: wpa_passphrase. The server still gets the real value.");
  expect(boxes[0]).not.toContain("hunter2hunter");
  expect(toolCalls(await calls(file))).toEqual([{ tool: "set_ssid", arguments: { ssid: "corp", wpa_passphrase: "hunter2hunter" } }]);
});

test("the last preview of the same call is shown, masked, until the connection changes", async () => {
  const { confirm, boxes } = answering(true, false, false);
  const { mcp, broker, id } = await setup({ confirm });
  await broker.invoke(id("set_ssid"), { ssid: "corp", wpa_passphrase: "hunter2hunter", dry_run: true });
  expect(boxes[0]).toContain("Preview only: nothing changes (dry_run=true).");
  await expect(broker.invoke(id("set_ssid"), { ssid: "corp", wpa_passphrase: "hunter2hunter", dry_run: false })).rejects.toThrow("you said no");
  expect(boxes[1]).toContain("Last preview (just now):");
  expect(boxes[1]).toContain("would_set");
  expect(boxes[1]).toContain("  wpa_passphrase   ••• 13 chars\n");
  expect(boxes[1]).not.toContain("hunter2hunter");
  await mcp.disconnect("network");
  await mcp.connect("network");
  await expect(broker.invoke(id("set_ssid"), { ssid: "corp", wpa_passphrase: "hunter2hunter", dry_run: false })).rejects.toThrow("you said no");
  expect(boxes[2]).not.toContain("Last preview");
  expect(boxes[2]).toContain("No preview yet.");
});

test("p runs the preview first, then asks again with its result", async () => {
  const { confirm, boxes } = answering("preview", "yes");
  const { broker, file, id } = await setup({ confirm });
  const result = await broker.invoke(id("set_ssid"), { ssid: "corp", wpa_passphrase: "hunter2hunter" });
  expect(JSON.stringify(result)).toContain("applied");
  const sent = toolCalls(await calls(file)).map((entry) => (entry.arguments as Record<string, unknown>).dry_run);
  expect(sent).toEqual([true, undefined]);
  expect(boxes[0]).toContain("  2 Preview first\n");
  expect(boxes[0]).toContain("No preview yet.");
  expect(boxes[1]).toContain("Last preview (just now):");
  expect(boxes[1]).not.toContain("hunter2hunter");
});

test("p is not offered without the switch, and answering it sends nothing", async () => {
  const { confirm, boxes } = answering("preview", "preview");
  const { broker, file, id } = await setup({ confirm });
  await expect(broker.invoke(id("port_bounce"), { serial_number: "SG1" })).rejects.toThrow("Not executed (you said no)");
  await expect(broker.invoke(id("invoke_tool"), { name: "set_ssid", arguments: { ssid: "x" } })).rejects.toThrow("Not executed (you said no)");
  for (const box of boxes) expect(box).not.toContain("p to preview first");
  expect(toolCalls(await calls(file))).toEqual([]);
});

test("the user can ask for a preview at most three times, and sees the third one", async () => {
  const { confirm, boxes } = answering("preview", "preview", "preview", "yes");
  const { broker, file, id } = await setup({ confirm });
  expect(JSON.stringify(await broker.invoke(id("set_ssid"), { ssid: "corp" }))).toContain("applied");
  expect(boxes).toHaveLength(4);
  // The fourth box shows the third preview and no longer offers p.
  expect(boxes[3]).toContain("Last preview (just now):");
  expect(boxes[3]).toContain("Type 1, 2, 3 or 4: ");
  expect(boxes[3]).not.toContain("Preview first");
  expect(toolCalls(await calls(file)).map((entry) => (entry.arguments as Record<string, unknown>).dry_run)).toEqual([true, true, true, undefined]);
});

test("a fourth p is a no, and no preview is sent that the user would never see", async () => {
  const { confirm, boxes } = answering("preview", "preview", "preview", "preview");
  const { broker, file, id } = await setup({ confirm });
  await expect(broker.invoke(id("set_ssid"), { ssid: "corp" })).rejects.toThrow("Not executed (you said no)");
  expect(boxes).toHaveLength(4);
  expect(toolCalls(await calls(file))).toHaveLength(3);
});

test("the AI can't slip a yes past the user as text: confirm \"true\" through a read router asks", async () => {
  const { confirm, boxes } = answering(false, false);
  const { broker, file, id } = await setup({ confirm });
  await expect(broker.invoke(id("invoke_read_tool"), { name: "get_clients", arguments: { site: "a", confirm: "true" } }))
    .rejects.toThrow("Not executed (you said no)");
  expect(boxes[0]).toContain("⚠ The AI set confirm=true.");
  await expect(broker.invoke(id("invoke_read_tool"), { name: "get_clients", arguments: { site: "a", dry_run: "false" } }))
    .rejects.toThrow("Not executed (you said no)");
  expect(boxes[1]).toContain("May make the change (dry_run is not a plain true or false).");
  expect(toolCalls(await calls(file))).toEqual([]);
});

// --- server questions (MCP elicitation) --------------------------------------------------------

function elicitor(answer: (question: ServerQuestion) => ServerQuestionAnswer | Promise<ServerQuestionAnswer>) {
  const asked: ServerQuestion[] = [];
  return { asked, elicit: async (question: ServerQuestion) => { asked.push(question); return answer(question); } };
}

test("an approved call's server question reaches the user, and yes lets it run", async () => {
  const { asked, elicit } = elicitor(() => ({ action: "accept", value: true }));
  const { broker, file, id } = await setup({ confirm: async () => true, elicit });
  const result = await broker.invoke(id("port_bounce"), { serial_number: "SG1" });
  expect(JSON.stringify(result)).toContain("bounced");
  expect(asked).toEqual([{ server: "network", tool: "port_bounce", realTool: "port_bounce", message: "Confirm PORT BOUNCE on SG1 ports [1/1/1]?", field: "confirm", kind: "boolean" }]);
  expect(questions(await calls(file))).toEqual([{ question: "port_bounce", action: "accept", content: { confirm: true } }]);
});

test("a no to the server question gives CANCELLED", async () => {
  const { elicit } = elicitor(() => ({ action: "decline" }));
  const { broker, id } = await setup({ confirm: async () => true, elicit });
  expect(JSON.stringify(await broker.invoke(id("port_bounce"), { serial_number: "SG1" }))).toContain("CANCELLED");
});

test("a question through a router names the real tool", async () => {
  const { asked, elicit } = elicitor(() => ({ action: "accept", value: true }));
  const { broker, id } = await setup({ confirm: async () => true, elicit });
  expect(JSON.stringify(await broker.invoke(id("invoke_tool"), { name: "port_bounce", arguments: { serial_number: "SG1" } }))).toContain("bounced");
  expect(asked[0]?.tool).toBe("invoke_tool");
  expect(asked[0]?.realTool).toBe("port_bounce");
});

test("a read that asks a question is declined without asking", async () => {
  const { asked, elicit } = elicitor(() => ({ action: "accept", value: true }));
  const { broker, file, id, notes } = await setup({ confirm: async () => true, elicit });
  expect(JSON.stringify(await broker.invoke(id("sneaky_read"), { serial_number: "SG1" }))).toContain("CANCELLED");
  expect(asked).toEqual([]);
  expect(questions(await calls(file))).toEqual([{ question: "sneaky_read", action: "decline", content: null }]);
  expect(notes).toEqual(["[mcp] network asked a question outside a call you approved; declined."]);
});

test("a question after the approved call finished is declined without asking", async () => {
  const { asked, elicit } = elicitor(() => ({ action: "accept", value: true }));
  const { broker, file, id } = await setup({ confirm: async () => true, elicit });
  await broker.invoke(id("late_question"), { serial_number: "SG1" });
  for (let i = 0; i < 40 && !questions(await calls(file)).length; i++) await Bun.sleep(25);
  expect(asked).toEqual([]);
  expect(questions(await calls(file))).toEqual([{ question: "late_question", action: "decline", content: null }]);
});

test("a form with two text fields is declined with a plain note", async () => {
  const { asked, elicit } = elicitor(() => ({ action: "accept", value: true }));
  const { broker, id, notes } = await setup({ confirm: async () => true, elicit });
  expect(JSON.stringify(await broker.invoke(id("multi_question"), {}))).toContain("decline");
  expect(asked).toEqual([]);
  expect(notes).toEqual(["[mcp] network asked a question Casper can only answer yes/no; declined."]);
});

test("a pick-one question offers the server's options", async () => {
  const { asked, elicit } = elicitor(() => ({ action: "accept", value: "1/1/2" }));
  const { broker, id } = await setup({ confirm: async () => true, elicit });
  expect(JSON.stringify(await broker.invoke(id("pick_question"), {}))).toContain("1/1/2");
  expect(asked[0]).toMatchObject({ kind: "choice", field: "ports", options: ["1/1/1", "1/1/2"] });
});

test("at most three questions are answered in one call", async () => {
  const { asked, elicit } = elicitor(() => ({ action: "accept", value: true }));
  const { broker, id, notes } = await setup({ confirm: async () => true, elicit });
  expect(JSON.stringify(await broker.invoke(id("many_questions"), {}))).toContain('"answers":["accept","accept","accept","decline"]');
  expect(asked).toHaveLength(3);
  expect(notes).toEqual(["[mcp] network asked more than 3 questions in one call; declined."]);
});

test("without a question handler (one-shot) the server never gets a yes", async () => {
  const { broker, file, id } = await setup({ confirm: async () => true });
  expect(JSON.stringify(await broker.invoke(id("port_bounce"), { serial_number: "SG1" }))).toContain("CONFIRMATION_UNAVAILABLE");
  expect(questions(await calls(file)).some((entry) => entry.action === "accept")).toBe(false);
});

test("the call clock is paused while the user reads a server question", async () => {
  const { elicit } = elicitor(async () => { await Bun.sleep(600); return { action: "accept", value: true }; });
  const { broker, id } = await setup({ confirm: async () => true, elicit, manager: { callTimeoutMs: 300 } });
  expect(JSON.stringify(await broker.invoke(id("port_bounce"), { serial_number: "SG1" }))).toContain("bounced");
});

// --- "Yes, for this session" ---------------------------------------------------------------------

test("yes for this session covers later non-destructive changes on that server; destructive and AI-set confirm still ask; ending it asks again", async () => {
  const { confirm, boxes } = answering("yes-session", "no", "no");
  const { broker, file, id } = await setup({ confirm });
  await broker.invoke(id("set_ssid"), { ssid: "corp" });
  expect(boxes).toHaveLength(1);
  expect(broker.sessionGrant("network")).toBe(true);
  // A later change on the same server runs without a box.
  await broker.invoke(id("set_ssid"), { ssid: "guest" });
  expect(boxes).toHaveLength(1);
  expect(toolCalls(await calls(file))).toHaveLength(2);
  // Destructive still asks, and offers no session answer.
  await expect(broker.invoke(id("port_bounce"), { serial_number: "SG1" })).rejects.toThrow("you said no");
  expect(boxes).toHaveLength(2);
  expect(boxes[1]).not.toContain("for this session");
  // Ending the grant (ctrl+o, writes off, reconnect) makes the next change ask again.
  broker.endSessionGrants("network");
  expect(broker.sessionGrant("network")).toBe(false);
  await expect(broker.invoke(id("set_ssid"), { ssid: "x" })).rejects.toThrow("you said no");
  expect(boxes).toHaveLength(3);
});

test("review: a tool the server tags as firmware asks every time: no session answer in its box, and a session grant never covers it", async () => {
  const { confirm, boxes } = answering("yes-session", "yes-session", "no");
  const { confirmKind } = kindAnswers(true);
  const { broker, id } = await setup({ confirm, confirmKind, writesGate: true });
  await broker.invoke(id("set_ssid"), { ssid: "corp" });
  expect(broker.sessionGrant("network")).toBe(true);
  await broker.invoke(id("update_device_settings"), { serial_number: "SG1" });
  expect(boxes).toHaveLength(2);
  expect(boxes[1]).toContain("Yes, this once");
  expect(boxes[1]).not.toContain("for this session");
  // A 3 typed there counted once: the next call shows the box again.
  await expect(broker.invoke(id("update_device_settings"), { serial_number: "SG2" })).rejects.toThrow("you said no");
  expect(boxes).toHaveLength(3);
});

test("an AI-set confirm=true asks even under a session grant", async () => {
  const { confirm, boxes } = answering("yes-session", "no");
  const { broker, id } = await setup({ confirm });
  await broker.invoke(id("set_ssid"), { ssid: "corp" });
  await expect(broker.invoke(id("set_ssid"), { ssid: "corp", confirm: true })).rejects.toThrow("you said no");
  expect(boxes).toHaveLength(2);
});


// --- Writes turned on from the box ---------------------------------------------------------------

test("writes off: change tools are offered, the box asks, and yes this once turns writes on for that change only", async () => {
  const { confirm, boxes } = answering("yes");
  const { broker, mcp, file, id } = await setup({ confirm, writesGate: true });
  expect(mcp.writesOn()).toEqual([]);
  expect(broker.search("ssid").map((match) => match.id)).toContain(id("set_ssid"));
  expect(JSON.stringify(await broker.invoke(id("set_ssid"), { ssid: "corp" }))).toContain("applied");
  expect(boxes).toHaveLength(1);
  expect(toolCalls(await calls(file))).toHaveLength(1);
  // Off again afterwards: the next change asks again.
  expect(mcp.writesOn()).toEqual([]);
});

test("writes off: yes for this session leaves writes on until they are turned off", async () => {
  const { confirm } = answering("yes-session");
  const { broker, mcp, id } = await setup({ confirm, writesGate: true });
  await broker.invoke(id("set_ssid"), { ssid: "corp" });
  expect(mcp.writesOn()).toEqual(["network"]);
  await broker.invoke(id("set_ssid"), { ssid: "guest" });
  await mcp.setWrites("network", false);
  // The grant ends the moment writes go off: the next change asks (and answering no keeps writes off).
  expect(broker.sessionGrant("network")).toBe(false);
  await expect(broker.invoke(id("set_ssid"), { ssid: "x" })).rejects.toThrow("you said no");
  expect(broker.sessionGrant("network")).toBe(false);
  expect(mcp.writesOn()).toEqual([]);
});

test("writes off and nobody to ask (one-shot): the change is not executed and writes stay off", async () => {
  const { broker, mcp, id } = await setup({ writesGate: true });
  await expect(broker.invoke(id("set_ssid"), { ssid: "corp" })).rejects.toThrow("needs your approval, and this run cannot ask");
  expect(mcp.writesOn()).toEqual([]);
});

test("a tool that runs commands never gets a session answer: each command asks (a 3 there counts only once)", async () => {
  const { confirm, boxes } = answering("yes-session", "no");
  const { broker, id } = await setup({ mode: "network-names", confirm });
  await broker.invoke(id("execute_junos_command"), { router_name: "r1", command: "clear arp" });
  expect(boxes[0]).not.toContain("for this session");
  expect(broker.sessionGrant("network")).toBe(false);
  await expect(broker.invoke(id("execute_junos_command"), { router_name: "r1", command: "request system zeroize" })).rejects.toThrow("you said no");
  expect(boxes).toHaveLength(2);
});

test("writes the user turned on while the box was open stay on after a yes this once", async () => {
  let mcpRef: MCPManager | undefined;
  const confirm: ConfirmCapability = async () => { await mcpRef!.setWrites("network", true); return "yes"; };
  const { broker, mcp, id } = await setup({ confirm, writesGate: true });
  mcpRef = mcp;
  await broker.invoke(id("set_ssid"), { ssid: "corp" });
  expect(mcp.writesOn()).toEqual(["network"]);
});

test("ctrl+o ends a session answer for good: turning writes back on doesn't bring it back", async () => {
  const { confirm, boxes } = answering("yes-session", "no");
  const { broker, mcp, id } = await setup({ confirm, writesGate: true });
  await broker.invoke(id("set_ssid"), { ssid: "corp" });
  expect(broker.sessionGrant("network")).toBe(true);
  await mcp.setWrites("network", false); // ctrl+o
  await mcp.setWrites("network", true);  // /mcp writes network, then 2
  await expect(broker.invoke(id("set_ssid"), { ssid: "x" })).rejects.toThrow("you said no");
  expect(boxes).toHaveLength(2);
});

// --- Risky change kinds (firmware, delete, admin): off by default --------------------------------

/** A kind box that answers from a list and keeps the kinds it was asked about. */
function kindAnswers(...answers: boolean[]) {
  const asked: string[] = [];
  const confirmKind: ConfirmKind = async (ask) => { asked.push(`${ask.server}:${ask.kind}:${ask.realTool}`); return answers.shift() ?? false; };
  return { confirmKind, asked };
}

test("a risky kind asks to allow the kind first; no there means the change box never shows and nothing runs", async () => {
  const { confirm, boxes } = answering("yes");
  const { confirmKind, asked } = kindAnswers(false);
  const { broker, file, id } = await setup({ confirm, confirmKind, writesGate: true });
  await expect(broker.invoke(id("invite_user"), { email: "a@example.com" })).rejects.toThrow("you said no");
  expect(asked).toEqual(["network:admin:invite_user"]);
  expect(boxes).toHaveLength(0);
  expect(toolCalls(await calls(file))).toEqual([]);
});

test("allowing the kind shows the change box next; the same kind later skips the kind box; ctrl+o ends it", async () => {
  const { confirm, boxes } = answering("yes", "yes", "no");
  const { confirmKind, asked } = kindAnswers(true, false);
  const { broker, mcp, file, id } = await setup({ confirm, confirmKind, writesGate: true });
  await broker.invoke(id("invite_user"), { email: "a@example.com" });
  expect(asked).toHaveLength(1);
  expect(boxes).toHaveLength(1);
  expect(broker.kindAllowed("network", "admin")).toBe(true);
  // "Yes, this once" turned writes off again; the kind stays allowed.
  expect(mcp.writesOn()).toEqual([]);
  await broker.invoke(id("invite_user"), { email: "b@example.com" });
  expect(asked).toHaveLength(1);
  expect(boxes).toHaveLength(2);
  expect(toolCalls(await calls(file))).toHaveLength(2);
  // ctrl+o (and /mcp writes off, a disconnect) ends every allowance.
  broker.endAllowances();
  expect(broker.kindAllowed("network", "admin")).toBe(false);
  await expect(broker.invoke(id("invite_user"), { email: "c@example.com" })).rejects.toThrow("you said no");
  expect(asked).toHaveLength(2);
});

test("an allowed kind ends when the person turns writes off or the server disconnects", async () => {
  const { confirm } = answering("yes");
  const { confirmKind } = kindAnswers(true);
  const { broker, mcp, id } = await setup({ confirm, confirmKind, writesGate: true });
  await mcp.setWrites("network", true);
  await broker.invoke(id("invite_user"), { email: "a@example.com" });
  expect(broker.kindAllowed("network", "admin")).toBe(true);
  await mcp.setWrites("network", false);
  expect(broker.kindAllowed("network", "admin")).toBe(false);
});

test("a risky kind with nobody to ask is not executed", async () => {
  const { broker, file, id } = await setup({ confirm: async () => "yes", writesGate: true });
  await expect(broker.invoke(id("invite_user"), { email: "a@example.com" })).rejects.toThrow("Admin and account changes are off by default on network");
  expect(toolCalls(await calls(file))).toEqual([]);
});

test("a risky kind behind a router is judged by the real tool", async () => {
  const { confirm } = answering("yes");
  const { confirmKind, asked } = kindAnswers(false);
  const { broker, id } = await setup({ confirm, confirmKind, writesGate: true });
  await expect(broker.invoke(id("invoke_tool"), { name: "trigger_device_upgrade", arguments: {} })).rejects.toThrow("you said no");
  expect(asked).toEqual(["network:firmware:trigger_device_upgrade"]);
});

// --- "Yes to everything on <product> this session" ----------------------------------------------

test("allow all: later changes on that server run without any box, even reboots, risky kinds and an AI-set confirm; another server still asks; ctrl+o ends it", async () => {
  const file = await callsFile();
  const mcp = new MCPManager({ servers: [definition("network", "network", file), definition("other", "network", file)], diagnostics: [] }, {});
  const { confirm, boxes } = answering("allow-all", "no", "no");
  const { confirmKind, asked } = kindAnswers(false);
  const covered: string[] = [];
  const broker = new CapabilityBroker(mcp, confirm, { writesGate: true, confirmKind, onAllowAll: (server, tool) => covered.push(`${server}:${tool}`) });
  cleanup.push(() => broker.close());
  await mcp.connect("network");
  await mcp.connect("other");
  await broker.prepare("network");
  await broker.invoke("mcp:network:set_ssid", { ssid: "corp" });
  expect(boxes).toHaveLength(1);
  expect(broker.allowAllServers()).toEqual(["network"]);
  expect(mcp.writesOn()).toEqual(["network"]);
  // No more boxes on network: destructive, a risky kind (no kind box either), and the AI setting confirm=true.
  // port_bounce still sends its own question to the person (nobody answers it here); the call itself was sent.
  expect(JSON.stringify(await broker.invoke("mcp:network:port_bounce", { serial_number: "SG1" }))).toContain('"executed":true');
  await broker.invoke("mcp:network:invite_user", { email: "a@example.com" });
  await broker.invoke("mcp:network:set_ssid", { ssid: "corp", confirm: true });
  expect(boxes).toHaveLength(1);
  expect(asked).toEqual([]);
  expect(covered).toEqual(["network:port_bounce", "network:invite_user", "network:set_ssid"]);
  // The other server still asks.
  await expect(broker.invoke("mcp:other:set_ssid", { ssid: "corp" })).rejects.toThrow("you said no");
  expect(boxes).toHaveLength(2);
  // ctrl+o ends it at once.
  expect(broker.endAllowances()).toBe(true);
  expect(broker.allowAllServers()).toEqual([]);
  await expect(broker.invoke("mcp:network:set_ssid", { ssid: "x" })).rejects.toThrow("you said no");
  expect(boxes).toHaveLength(3);
});

test("allow all ends when the person turns that server's writes off", async () => {
  const { confirm } = answering("allow-all");
  const { broker, mcp, id } = await setup({ confirm, writesGate: true });
  await broker.invoke(id("set_ssid"), { ssid: "corp" });
  expect(broker.allowAllServers()).toEqual(["network"]);
  await mcp.setWrites("network", false);
  expect(broker.allowAllServers()).toEqual([]);
});

test("review: a session answer never covers a risky kind; each one still shows the change box", async () => {
  const { confirm, boxes } = answering("yes-session", "yes", "no");
  const { confirmKind } = kindAnswers(true);
  const { broker, id } = await setup({ confirm, confirmKind, writesGate: true });
  await broker.invoke(id("set_ssid"), { ssid: "corp" });
  await broker.invoke(id("invite_user"), { email: "a@example.com" });
  await expect(broker.invoke(id("invite_user"), { email: "b@example.com" })).rejects.toThrow("you said no");
  expect(boxes).toHaveLength(3);
});
