// Synthetic native Claude executable for the real SDK transport. No network or credentials.
import { createInterface } from "node:readline";
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
if (process.argv[2] === "auth" && process.argv[3] === "status") {
  send({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
  process.exit(0);
}
const account = { apiProvider: "firstParty", subscriptionType: "max", apiKeySource: "none" };
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: request.request_id,
      response: { ...account, commands: [], agents: [], models: [], account } } });
  } else if (request.type === "user") {
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_BASE_URL) throw new Error("API overrides reached the synthetic CLI");
    const common = { session_id: "fixture", uuid: "00000000-0000-4000-8000-000000000000" };
    send({ ...common, type: "system", subtype: "init", ...account, model: "claude-opus-4-8", tools: [], mcp_servers: [] });
    const raw = (event: unknown) => send({ ...common, type: "stream_event", parent_tool_use_id: null, event });
    const text = JSON.stringify(request.message.content);
    const result = (subtype: string, value: string) => send({ ...common, type: "result", subtype, is_error: subtype !== "success", errors: [], result: value, num_turns: 1,
      total_cost_usd: 0, usage: { input_tokens: 2, output_tokens: 3 }, modelUsage: {}, permission_denials: [] });
    if (text.includes("SUBSCRIPTION_TOOL_FIXTURE") && !text.includes("structured context checkpoint") && !text.includes("PREFIX of a turn")) {
      const proposal = !text.includes("TOOL RESULT") ? { name: "read", id: "read_fixture", args: { path: "fixture.txt" } }
        : !text.includes("TOOL RESULT read (private_fixture)") ? { name: "read", id: "private_fixture", args: { path: "private/token.txt" } }
        : !text.includes("TOOL RESULT write (blocked_fixture)") ? { name: "write", id: "blocked_fixture", args: { path: "marker.txt", content: "native write\n" } }
        : !text.includes("TOOL RESULT write (allowed_fixture)") ? { name: "write", id: "allowed_fixture", args: { path: "marker.txt", content: "native write\n" } }
        : !text.includes("TOOL RESULT bash") ? { name: "bash", id: "bash_fixture", args: { command: "printf synthetic" } } : undefined;
      raw({ type: "message_start", message: { id: "msg_fixture", model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: 0 } } });
      if (proposal) {
        raw({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: proposal.id, name: `mcp__casper__${proposal.name}`, input: {} } });
        raw({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(proposal.args) } });
      } else {
        raw({ type: "content_block_start", index: 0, content_block: { type: "text", text: "fixture complete" } });
      }
      raw({ type: "content_block_stop", index: 0 });
      raw({ type: "message_delta", delta: { stop_reason: proposal ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } });
      raw({ type: "message_stop" }); result(proposal ? "error_max_turns" : "success", "fixture complete"); break;
    }
    raw({ type: "message_start", message: { id: "msg_fixture", model: "claude-opus-4-8", usage: { input_tokens: 2, output_tokens: 0 } } });
    raw({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    raw({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "synthetic SDK transport works" } });
    raw({ type: "content_block_stop", index: 0 });
    raw({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
    raw({ type: "message_stop" });
    send({ ...common, type: "result", subtype: "success", is_error: false, result: "synthetic SDK transport works", num_turns: 1, total_cost_usd: 0,
      usage: { input_tokens: 2, output_tokens: 3 }, modelUsage: {}, permission_denials: [] });
    break;
  }
}
lines.close();
