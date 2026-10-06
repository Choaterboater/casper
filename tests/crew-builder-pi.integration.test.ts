import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeEvent } from "../src/runtime/types";
import { answer, calls, cleanUpAfterEach, fixture } from "./support/phase8-pi";

cleanUpAfterEach();
const builder = path.join(import.meta.dir, "fixtures/pi-builder.ts");
const parse = (stdout: string): { events: RuntimeEvent[]; replaceBlocked: boolean } => JSON.parse(stdout.split("BUILDER_RESULT=")[1]!);

test("a real Pi builder edits and runs a command in its own folder, with only the built-in tools", async () => {
  let requests = 0;
  const f = await fixture(() => ++requests === 1
    ? calls([{ name: "write", args: { path: "made.txt", content: "BUILT\n" } }])
    : requests === 2 ? calls([{ name: "bash", args: { command: "cat made.txt" } }])
    : answer("Done: made.txt"));
  const result = await f.run([builder, f.project, "work"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const report = parse(result.stdout);
  expect(await readFile(path.join(f.project, "made.txt"), "utf8")).toBe("BUILT\n");
  const bash = report.events.find((event) => event.type === "tool_end" && event.toolName === "bash");
  expect(bash).toMatchObject({ isError: false });
  expect(JSON.stringify(bash)).toContain("BUILT");
  // No delegate, no MCP tools, no crew, no ask: the seven built-in tools only.
  expect(f.payloads[0]!.tools.map((tool) => tool.function.name).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
  expect(report.replaceBlocked).toBe(true);
}, 60_000);

test("a real Pi builder's gate refuses a write and its tool-call budget holds", async () => {
  const f = await fixture(() => calls([
    { name: "write", args: { path: "../outside.txt", content: "NO\n" } },
    { name: "write", args: { path: "a.txt", content: "A\n" } },
    { name: "write", args: { path: "b.txt", content: "B\n" } },
  ]));
  const result = await f.run([builder, f.project, "calls"]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  const report = parse(result.stdout);
  const ends = report.events.filter((event) => event.type === "tool_end");
  expect(ends[0]).toMatchObject({ isError: true });
  expect(JSON.stringify(ends[0])).toContain("outside the copy");
  expect(report.events).toContainEqual(expect.objectContaining({ type: "assistant_response_end", stopReason: "limit" }));
  // Budget 2: the third call is refused, and no second model turn is made.
  await expect(readFile(path.join(f.project, "b.txt"), "utf8")).rejects.toThrow();
  expect(f.payloads).toHaveLength(1);
}, 60_000);
