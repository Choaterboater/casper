import { expect } from "bun:test";
import path from "node:path";
import { cleanUpAfterEach, answer, fixture, stream } from "./support/phase8-pi";
import { posixOnly } from "./support/platform";

cleanUpAfterEach();

posixOnly("interleaved streamed reasons title their own commands, not the response's final line", async () => {
  let step = 0;
  const call = (index: number, name: string, command: string) => ({ tool_calls: [
    { index, id: `call_${index}`, type: "function", function: { name, arguments: JSON.stringify({ command }) } },
  ] });
  const setup = await fixture(() => {
    if (step++ === 0) return new Response(
      stream({ role: "assistant", content: "Earlier context.\nReason A.\n" }, null)
      + stream(call(0, "bash", "custom-tool first"), null)
      + stream({ content: "\nReason B.\n" }, null)
      + stream(call(1, "bash", "custom-tool second"), null)
      + stream({ content: "\nReason C.\n" }, null)
      + stream(call(2, "approval_probe", "custom-tool third"), null)
      + stream({ content: "\nThis later line belongs to no command." }, null)
      + stream({}, "tool_calls") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
    if (step === 2) return new Response(
      stream({ role: "assistant", ...call(0, "bash", "custom-tool no-reason") }, null)
      + stream({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } },
    );
    return answer("done");
  });
  const { stdout, stderr, exit } = await setup.run([path.join(import.meta.dir, "fixtures/pi-approval-reasons.ts"), setup.project]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const marker = "APPROVAL_REASONS=";
  const result = JSON.parse(stdout.slice(stdout.indexOf(marker) + marker.length).trim());
  expect(result.questions.sort()).toEqual([
    "Run this command?\nThe model says: Reason A.\ncustom-tool first",
    "Run this command?\nThe model says: Reason B.\ncustom-tool second",
    "Run this command?\nThe model says: Reason C.\ncustom-tool third",
    "Run this command?  custom-tool no-reason",
  ].sort());
  expect(result.toolEnds).toHaveLength(4);
  expect(result.toolEnds.every((event: { isError: boolean }) => event.isError)).toBe(true);
}, 30_000);
