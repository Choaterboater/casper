import { expect, test } from "bun:test";
import path from "node:path";
import type { RuntimeEvent } from "../src/runtime/types";
import { cleanUpAfterEach, fixture, stream } from "./support/phase8-pi";
import { childTestLimit } from "./support/limits";

cleanUpAfterEach();

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
