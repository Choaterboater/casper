import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MCPManager, type MCPManagerOptions, type ServerQuestion, type ServerQuestionAnswer } from "../src/mcp/manager";
import type { MCPServerDefinition } from "../src/mcp/config";
import { CapabilityBroker, type ApprovalAnswer, type ConfirmCapability } from "../src/capabilities/broker";
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
  mode?: string; name?: string; confirm?: ConfirmCapability; elicit?: MCPManagerOptions["elicit"]; manager?: MCPManagerOptions;
} = {}) {
  const file = await callsFile();
  const name = options.name ?? "network";
  const notes: string[] = [];
  const mcp = new MCPManager({ servers: [definition(name, options.mode ?? "network", file)], diagnostics: [] }, {
    ...(options.elicit ? { elicit: options.elicit } : {}), onNote: (text) => notes.push(text), ...options.manager,
  });
  const broker = new CapabilityBroker(mcp, options.confirm);
  cleanup.push(() => broker.close());
  await mcp.connect(name);
  await broker.prepare("network");
  return { mcp, broker, file, notes, id: (tool: string) => `mcp:${name}:${tool}` };
}
/** A confirm callback that answers from a list and keeps every box it was shown. */
function answering(...answers: ApprovalAnswer[]) {
  const boxes: string[] = [];
  const confirm: ConfirmCapability = async (call) => {
    boxes.push(formatApproval(call.plan, call.lastPreview).preview + formatApproval(call.plan, call.lastPreview).question);
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
  expect(boxes[0]).toContain("Mode: may EXECUTE (dry_run is not set)");
  expect(boxes[0]).toContain("Run it? Type yes: ");
  expect(boxes[0]).not.toContain("p to preview first");
});

test("secrets are hidden in the box, and the server still gets the real value", async () => {
  const { confirm, boxes } = answering(true);
  const { broker, file, id } = await setup({ confirm });
  await broker.invoke(id("set_ssid"), { ssid: "corp", wpa_passphrase: "hunter2hunter" });
  expect(boxes[0]).toContain("Mode: EXECUTE (this makes the change)");
  expect(boxes[0]).toContain("\"wpa_passphrase\":\"••• 13 chars\"");
  expect(boxes[0]).toContain("Hidden: wpa_passphrase. The server still gets the real value.");
  expect(boxes[0]).not.toContain("hunter2hunter");
  expect(toolCalls(await calls(file))).toEqual([{ tool: "set_ssid", arguments: { ssid: "corp", wpa_passphrase: "hunter2hunter" } }]);
});

test("the last preview of the same call is shown, masked, until the connection changes", async () => {
  const { confirm, boxes } = answering(true, false, false);
  const { mcp, broker, id } = await setup({ confirm });
  await broker.invoke(id("set_ssid"), { ssid: "corp", wpa_passphrase: "hunter2hunter", dry_run: true });
  expect(boxes[0]).toContain("Mode: preview (dry_run=true, nothing changes)");
  await expect(broker.invoke(id("set_ssid"), { ssid: "corp", wpa_passphrase: "hunter2hunter", dry_run: false })).rejects.toThrow("you said no");
  expect(boxes[1]).toContain("Last preview (just now):");
  expect(boxes[1]).toContain("would_set");
  expect(boxes[1]).toContain("\"wpa_passphrase\":\"••• 13 chars\"");
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
  expect(boxes[0]).toContain("Run it? Type yes, or p to preview first: ");
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

test("the user can ask for a preview at most three times", async () => {
  const { confirm, boxes } = answering("preview", "preview", "preview", "yes");
  const { broker, file, id } = await setup({ confirm });
  await expect(broker.invoke(id("set_ssid"), { ssid: "corp" })).rejects.toThrow("Not executed (you said no)");
  expect(boxes).toHaveLength(3);
  expect(toolCalls(await calls(file)).every((entry) => (entry.arguments as Record<string, unknown>).dry_run === true)).toBe(true);
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
