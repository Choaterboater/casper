import { afterEach, expect, test } from "bun:test";
import { complete } from "@earendil-works/pi-ai/compat";

/** Pi (patched, see patches/) names a Claude Code version for a Claude plan sign-in; Anthropic refuses newer models
 * to an older one ("Claude Code 2.1.251 does not support this model; version 2.1.280 or newer is required"). */
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! > y![i]!;
  return true;
};

test("a Claude plan sign-in names Claude Code 2.1.280 or newer", async () => {
  let agent = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    agent = request.headers.get("user-agent") ?? "";
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "fixture" } }, { status: 400 });
  } });
  servers.push(server);
  const model = { id: "fixture", name: "fixture", api: "anthropic-messages", provider: "anthropic", baseUrl: `http://127.0.0.1:${server.port}`,
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
  await complete(model as never, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { apiKey: "sk-ant-oat-local-fixture-not-a-secret" });
  const version = /^claude-cli\/(\d+\.\d+\.\d+)/.exec(agent)?.[1];
  expect(version).toBeDefined();
  expect(newer(version!, "2.1.280")).toBe(true);
});
