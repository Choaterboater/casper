import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeEvent } from "../src/runtime/types";
import { startAcp, type AcpClient } from "./support/acp-client";
import { cleanUpAfterEach, fixture, stream } from "./support/phase8-pi";
import { childTestLimit } from "./support/limits";
import { cleanUpAfterEach as cleanUpScripting, fixture as scripted, isChecklist } from "./support/scripting";

// The agents stop (with their session processes) before the fixtures' folders are removed.
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();
cleanUpScripting();

test("real Pi turns a provider's readable reasoning into a status-row headline, and nowhere else", async () => {
  const reasoning = "**Planning the port fix**\n\nI will check which process holds the port. The token is sk-live-abcdef1234567890.";
  const f = await fixture(() => new Response(
    stream({ role: "assistant", reasoning_content: reasoning }, null) + stream({ content: "Done." }, null) + stream({}, "stop") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }));
  const harness = path.join(f.agent, "headline-view.ts");
  await Bun.write(harness, `const { PiRuntime } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/runtime/pi.ts"))});
const runtime = new PiRuntime();
const events = [];
try {
  const session = await runtime.start({ cwd: process.cwd(), localModels: false });
  session.subscribe(event => events.push(event));
  await session.prompt('Fix the port test.');
  console.log('HEADLINE_EVENTS=' + JSON.stringify(events));
} finally { await runtime.dispose(); }
`);
  const run = await f.run([harness]);
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
  const events: RuntimeEvent[] = JSON.parse(run.stdout.split("HEADLINE_EVENTS=")[1]!);
  const headlines = events.flatMap(event => event.type === "assistant_progress" && event.headline ? [event.headline] : []);
  // The summary's title, once it has arrived; never the raw reasoning, never a secret.
  expect(headlines).toContain("Planning the port fix");
  expect(JSON.stringify(headlines)).not.toContain("sk-live");
  // Only progress events carry it: the AI's words are its answer alone.
  const words = events.flatMap(event => event.type === "assistant_text_delta" ? [event.delta] : []).join("");
  expect(words).toBe("Done.");
  expect(JSON.stringify(events.filter(event => event.type !== "assistant_progress"))).not.toContain("Planning the port fix");
}, childTestLimit());

test("The ACP session sends the headline, and sends none with reasoning_headline false or display quiet", async () => {
  const reasoning = "**Planning the port fix**\n\nI will check which process holds the port.";
  const f = await scripted((_request, payload) => isChecklist(payload) ? { text: "[]" } : { text: "Done.", reasoning });
  const client = startAcp(f);
  clients.push(client);
  await client.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } });
  /** One prompt in a new session (which reads the user's config as it opens): its thoughts and its messages. */
  const turn = async () => {
    const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    expect((await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Tell me about this folder" }] })).stopReason).toBe("end_turn");
    const updates = client.updates.filter((update) => update.sessionId === sessionId).map((update) => update.update);
    const of = (kind: string) => updates.filter((update) => update.sessionUpdate === kind).map((update) => String(update.content?.text ?? ""));
    return { thoughts: of("agent_thought_chunk"), messages: of("agent_message_chunk").join("") };
  };
  const shown = await turn();
  expect(shown.thoughts).toEqual(["Planning the port fix\n\n"]);
  // The answer and the receipt carry the model's words, never the headline.
  expect(shown.messages).toContain("Done.");
  expect(shown.messages).not.toContain("Planning the port fix");
  await writeFile(path.join(f.home, ".casper/config.yaml"), "reasoning_headline: false\n");
  expect((await turn()).thoughts).toEqual([]);
  await writeFile(path.join(f.home, ".casper/config.yaml"), "display: quiet\n");
  expect((await turn()).thoughts).toEqual([]);
  // The model got the reasoning back as its own, never as words of the request.
  expect(JSON.stringify(f.payloads.map((payload) => payload.messages.filter((message) => message.role === "user")))).not.toContain("Planning the port fix");
}, childTestLimit(3));
