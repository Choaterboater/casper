import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkLabels, routerContract, type CheckTool } from "../src/mcp/check/labels";
import { repoUsesElicitation } from "../src/mcp/check/server";
import { fixtureTools } from "./fixtures/mcp-check-server";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

const RO = { readOnlyHint: true };
const tool = (name: string, annotations?: CheckTool["annotations"], properties: Record<string, unknown> = {}, extra: Partial<CheckTool> = {}): CheckTool =>
  ({ name, inputSchema: { type: "object", properties }, ...(annotations ? { annotations } : {}), ...extra });
const texts = (findings: { status: string; text: string }[]) => findings.map((finding) => `${finding.status} ${finding.text}`);
const limits = { callMs: 90_000 };

test("an unlabeled tool is a problem, with a hint from its name", () => {
  expect(texts(checkLabels([tool("get_router_list")], limits))).toEqual([
    "fail get_router_list has no label. Casper will ask before every call. Add readOnlyHint or destructiveHint.",
    "note get_router_list looks read-only: add readOnlyHint: true. (Casper's label now: unknown.)",
  ]);
});

test("more than 5 unlabeled tools are grouped into one problem", () => {
  const findings = checkLabels(fixtureTools("unlabeled"), limits);
  expect(findings.filter((finding) => finding.status === "fail").map((finding) => finding.text))
    .toEqual(["9 of 9 tools have no label. Casper will ask before every call. Add readOnlyHint or destructiveHint."]);
  expect(texts(findings)).toContain("note execute_junos_command runs any CLI command: mark destructiveHint: true. (Casper's label now: exec.)");
  expect(texts(findings)).toContain("note render_and_apply_j2_template: dry_run has no default in the schema. Make preview the default.");
});

test("labels that don't fit the name are problems", () => {
  const findings = texts(checkLabels(fixtureTools("lying"), limits));
  expect(findings).toContain("fail delete_site is labeled read-only, but the name says it changes things.");
  expect(findings).toContain("fail port_bounce is labeled write, but the name says it can cut service. Mark it destructiveHint: true.");
  expect(findings).toContain("fail wipe_and_show says both read-only and destructive.");
  expect(findings).toContain('warn show_config is labeled read-only but has a "dry_run" field.');
  expect(texts(checkLabels([tool("execute_command", RO)], limits))).toEqual(["fail execute_command is labeled read-only, but the name says it runs commands."]);
});

test("status readers with change words in their names pass (glp_write_status reads a status)", () => {
  const tools = ["glp_write_status", "get_config_rollback_status", "junos_config_diff", "get_router_list", "show_version"].map((name) => tool(name, RO));
  expect(checkLabels(tools, limits)).toEqual([]);
  expect(checkLabels(fixtureTools("good"), limits)).toEqual([]);
});

test("a default timeout longer than Casper's call limit gets a note", () => {
  const long = tool("run_long", { readOnlyHint: false, destructiveHint: true }, { timeout: { type: "integer", default: 360 } });
  expect(texts(checkLabels([long], limits))).toEqual(["note run_long: default timeout 360 s is longer than Casper's 90 s call limit."]);
  expect(checkLabels([long], { callMs: 400_000 })).toEqual([]);
});

test("a tool that tells the AI to confirm by itself is a problem", () => {
  const selfConfirm = tool("delete_vlan", { destructiveHint: true }, { confirm: { type: "boolean", default: false } },
    { description: "Deletes a VLAN. If this returns a confirmation request, retry with confirm=true." });
  expect(texts(checkLabels([selfConfirm], limits))).toContain("fail delete_vlan tells the AI to call again with confirm=true. Only the user may confirm: ask the user through MCP elicitation instead.");
  const field = tool("delete_vlan", { destructiveHint: true }, { confirmed: { type: "boolean", default: false, description: "Set confirmed: true to proceed" } });
  expect(texts(checkLabels([field], limits)).some((line) => line.startsWith("fail delete_vlan tells the AI"))).toBe(true);
  const honest = tool("delete_vlan", { destructiveHint: true }, { confirm: { type: "boolean", default: false, description: "Only the user can confirm." } });
  expect(checkLabels([honest], limits)).toEqual([]);
});

test("a change tool with a confirm field warns when the server never asks the user", async () => {
  const confirm = tool("delete_vlan", { destructiveHint: true }, { confirm: { type: "boolean", default: false } });
  expect(texts(checkLabels([confirm], { callMs: 90_000, elicits: false }))).toEqual([
    'warn delete_vlan takes a "confirm" field, but the server never asks the user (no elicitation in the repo). The AI can set it by itself; Casper still asks you, other clients may not.',
  ]);
  expect(checkLabels([confirm], { callMs: 90_000, elicits: true })).toEqual([]);
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-check-elicit-"));
  temps.push(root);
  await mkdir(path.join(root, "src/server"), { recursive: true });
  await writeFile(path.join(root, "src/server/tools.py"), "def delete_vlan(confirm: bool = False):\n    pass\n");
  expect(await repoUsesElicitation(root)).toBe(false);
  await writeFile(path.join(root, "src/server/ask.py"), "result = await ctx.elicit('Delete it?', response_type=bool)\n");
  expect(await repoUsesElicitation(root)).toBe(true);
});

test("the router contract: dispatchers that reach write tools must be labeled destructive", () => {
  const bad = texts(routerContract(fixtureTools("router-bad"), new Map()));
  expect(bad).toContain("fail invoke_tool can reach write tools but is not labeled destructive.");
  expect(bad).toContain("fail invoke_tools_batch can reach write tools but is not labeled destructive.");
  expect(bad).toContain("warn No test shows invoke_read_tool refuses write tools.");
  const good = texts(routerContract(fixtureTools("router-good"), new Map([
    ["tests/unit/test_helpers.py", "def test_nothing(): pass"],
    ["tests/unit/test_router_readonly_and_rate.py", "def test_dispatch_blocks_write():\n    result = invoke_read_tool(name='delete_site')\n    assert 'refused' in result"],
  ])));
  expect(good).toContain("ok find_tool read · invoke_read_tool read · invoke_tool destructive · invoke_tools_batch destructive");
  expect(good).toContain("ok Refusal is tested: tests/unit/test_router_readonly_and_rate.py");
  expect(good.some((line) => line.startsWith("fail"))).toBe(false);
  // Not a router: no router findings at all.
  expect(routerContract(fixtureTools("good"), new Map())).toEqual([]);
});
