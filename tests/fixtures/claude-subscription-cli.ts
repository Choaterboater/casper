// Synthetic native Claude executable for the real SDK transport. No network or credentials.
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const loginState = process.env.CASPER_TEST_CLAUDE_LOGIN_STATE;
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
if (process.argv[2] === "auth" && process.argv[3] === "status") {
  const loggedIn = !loginState || existsSync(loginState);
  send({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", subscriptionType: loggedIn ? "max" : undefined });
  process.exit(loggedIn ? 0 : 1);
}
if (process.argv[2] === "auth" && process.argv[3] === "login") {
  if (!loginState || process.argv[4] !== "--claudeai") process.exit(1);
  console.log("https://claude.ai/oauth/authorize?fixture=1");
  const input = createInterface({ input: process.stdin });
  for await (const code of input) {
    if (code !== "fixture-code") process.exit(1);
    writeFileSync(loginState, "synthetic signed-in state");
    process.exit(0);
  }
  process.exit(1);
}
// Match native SDK accountInfo, which differs from the public auth-status response above.
const account = { apiProvider: "firstParty", subscriptionType: "Claude Max" };
const common = { session_id: "fixture", uuid: "00000000-0000-4000-8000-000000000000" };
const raw = (event: unknown) => send({ ...common, type: "stream_event", parent_tool_use_id: null, event });
const result = (value: string) => send({ ...common, type: "result", subtype: "success", is_error: false, errors: [], result: value, num_turns: 1,
  total_cost_usd: 0, usage: { input_tokens: 2, output_tokens: 3 }, modelUsage: {}, permission_denials: [] });
/** What this process did, for the test: each user message it read and each tool it called (CASPER_TEST_CLAUDE_LOG). */
const log = (entry: object) => { if (process.env.CASPER_TEST_CLAUDE_LOG) appendFileSync(process.env.CASPER_TEST_CLAUDE_LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n"); };
// As live Claude Code does: it asks the SDK whether it may use a tool, then calls it on the SDK's MCP server and waits.
let nextRequest = 0;
const pending = new Map<string, (response: { subtype: string; response?: any; error?: string }) => void>();
const ask = (request: object) => new Promise<any>((resolve, reject) => {
  const request_id = `fixture_${++nextRequest}`;
  pending.set(request_id, response => response.subtype === "success" ? resolve(response.response) : reject(new Error(response.error)));
  send({ type: "control_request", request_id, request });
});
async function callTool(name: string, id: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const permission = await ask({ subtype: "can_use_tool", tool_name: `mcp__casper__${name}`, input: args, tool_use_id: id, permission_suggestions: [] });
  if (permission.behavior !== "allow") throw new Error(`fixture tool refused: ${name}`);
  const reply = await ask({ subtype: "mcp_message", server_name: "casper", message: { jsonrpc: "2.0", id: nextRequest, method: "tools/call", params: { name, arguments: permission.updatedInput, _meta: { "claudecode/toolUseId": id } } } });
  const called = reply.mcp_response.result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  log({ tool: name, id });
  return { text: called.content.map(block => block.text ?? "").join(""), isError: Boolean(called.isError) };
}
function turn(proposal?: { name: string; id: string; json: string }, text = "fixture complete") {
  raw({ type: "message_start", message: { id: `msg_${proposal?.id ?? "answer"}_${nextRequest}`, model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: 0 } } });
  if (proposal) {
    raw({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: proposal.id, name: `mcp__casper__${proposal.name}`, input: {} } });
    raw({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: proposal.json } });
  } else {
    raw({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    raw({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  }
  raw({ type: "content_block_stop", index: 0 });
  raw({ type: "message_delta", delta: { stop_reason: proposal ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } });
  raw({ type: "message_stop" });
}
// The tool fixture's calls in order. The first one's JSON Claude wrote wrong: it must come back refused, and the task go on.
const PROPOSALS = [
  { name: "read", id: "malformed_fixture", json: '{"path" "fixture.txt"}', args: {} },
  { name: "read", id: "read_fixture", args: { path: "fixture.txt" } },
  { name: "read", id: "private_fixture", args: { path: "private/token.txt" } },
  { name: "write", id: "blocked_fixture", args: { path: "marker.txt", content: "native write\n" } },
  { name: "write", id: "allowed_fixture", args: { path: "marker.txt", content: "native write\n" } },
  { name: "bash", id: "bash_fixture", args: { command: "printf synthetic" } },
];
let initialized = false;
async function userMessage(request: { message: { content: unknown } }) {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_BASE_URL) throw new Error("API overrides reached the synthetic CLI");
  const text = JSON.stringify(request.message.content);
  log({ user: text.slice(0, 80) });
  if (!initialized) { initialized = true; send({ ...common, type: "system", subtype: "init", ...account, apiKeySource: "none", model: "claude-opus-4-8", tools: [], mcp_servers: [] }); }
  if (text.includes("SUBSCRIPTION_TOOL_FIXTURE") && !text.includes("structured context checkpoint") && !text.includes("PREFIX of a turn")) {
    // A seeded session (after compaction or a restart) goes on after the results its transcript already has.
    for (const proposal of PROPOSALS) {
      if (text.includes(`(${proposal.id})`)) continue;
      turn({ name: proposal.name, id: proposal.id, json: proposal.json ?? JSON.stringify(proposal.args) });
      await callTool(proposal.name, proposal.id, proposal.args);
    }
    turn(undefined, "fixture complete"); result("fixture complete");
    return;
  }
  turn(undefined, "synthetic SDK transport works"); result("synthetic SDK transport works");
}
let work = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "control_response") { const resolve = pending.get(message.response.request_id); pending.delete(message.response.request_id); resolve?.(message.response); }
  else if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { ...account, commands: [], agents: [], models: [], account } } });
  } else if (message.type === "user") work = work.then(() => userMessage(message)).catch(error => { console.error(String(error)); process.exit(1); });
});
lines.on("close", () => { void work.then(() => process.exit(0)); });
