import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SYSTEM_PROMPT_APPEND, LEAN_SYSTEM_PROMPT_APPEND } from "../src/app/prompt";
import { PI_TOOL_RULES } from "../src/runtime/pi";
import { COMMAND_GUIDANCE, LEAN_COMMAND_GUIDANCE } from "../src/runtime/guidance";
import { cleanUpAfterEach, answer, calls, fixture, cli, type Payload } from "./support/phase8-pi";
import { childTestLimit } from "./support/limits";

cleanUpAfterEach();
const systemText = (payload: Payload) => payload.messages.filter((message) => message.role === "system")
  .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
const definitions = (payload: Payload) => payload.tools.map((tool) => {
  const { description: _description, ...rest } = tool.function as { name: string; description: string; parameters: unknown };
  return rest;
});

test("real Pi requests switch lean/off/auto live, rebind cleanly and execute the same tools without extra turns", async () => {
  let step = 0;
  const f = await fixture(() => step++ === 0 ? calls([{ name: "casper_session", args: { part: "model" } }]) : answer("GUIDANCE_OK"));
  const result = await f.run([path.join(import.meta.dir, "fixtures/pi-guidance.ts"), f.project]);
  expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(result.stdout).toContain('GUIDANCE_RESULT={"ran":1}');
  expect(f.payloads).toHaveLength(4); // tool request, answer, off answer, rebind answer; no guidance model turn.
  for (const index of [0, 1, 3]) {
    expect(systemText(f.payloads[index]!)).toContain(LEAN_SYSTEM_PROMPT_APPEND);
    expect(systemText(f.payloads[index]!)).not.toContain(DEFAULT_SYSTEM_PROMPT_APPEND);
    expect(systemText(f.payloads[index]!)).toContain("USER_RULE");
    expect(definitions(f.payloads[index]!)).toEqual(definitions(f.payloads[2]!));
  }
  expect(systemText(f.payloads[2]!)).toContain(DEFAULT_SYSTEM_PROMPT_APPEND);
  expect(JSON.stringify(f.payloads[1]!.messages)).toContain("GUIDANCE_TOOL_RAN");
  for (const rule of PI_TOOL_RULES) for (const payload of f.payloads) expect(systemText(payload)).toContain(rule);
  const description = (index: number, name: string) => (f.payloads[index]!.tools.find((tool) => tool.function.name === name)!.function as { name: string; description: string }).description;
  expect(description(0, "casper_session").length).toBeLessThan(description(2, "casper_session").length);
  for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) expect(description(0, name)).toBe(description(2, name));
}, childTestLimit());

test("CLI local model gets lean by default; its user config off switch restores full and preserves project rules", async () => {
  const f = await fixture(() => answer("GUIDANCE_OK"));
  const home = path.dirname(path.dirname(f.agent));
  await writeFile(path.join(f.project, "AGENTS.md"), "KEEP_PROJECT_RULES\n");
  expect((await f.run([cli, "Explain without tools"])).exit).toBe(0);
  await writeFile(path.join(home, ".casper/config.yaml"), "lean_guidance: off\n");
  expect((await f.run([cli, "Explain without tools"])).exit).toBe(0);
  expect(f.payloads).toHaveLength(2);
  expect(systemText(f.payloads[0]!)).toContain(LEAN_SYSTEM_PROMPT_APPEND);
  expect(systemText(f.payloads[1]!)).toContain(DEFAULT_SYSTEM_PROMPT_APPEND);
  for (const payload of f.payloads) expect(systemText(payload)).toContain("KEEP_PROJECT_RULES");
  expect(definitions(f.payloads[0]!)).toEqual(definitions(f.payloads[1]!));
  // Projection never writes its lean text into saved history.
  const routing = JSON.parse(await readFile(path.join(home, ".casper/settings.json"), "utf8"));
  expect(routing.defaultProvider).toBe("fixture");
}, childTestLimit(2));

test("a real Pi builder honors the parent's guidance off switch for Casper's addendum", async () => {
  const f = await fixture(() => answer("GUIDANCE_OK"));
  const builder = path.join(import.meta.dir, "fixtures/pi-builder.ts");
  expect((await f.run([builder, f.project, "work", "auto"])).exit).toBe(0);
  expect((await f.run([builder, f.project, "work", "off"])).exit).toBe(0);
  expect(f.payloads).toHaveLength(2);
  expect(systemText(f.payloads[0]!)).toContain(LEAN_COMMAND_GUIDANCE);
  expect(systemText(f.payloads[0]!)).not.toContain(COMMAND_GUIDANCE);
  expect(systemText(f.payloads[1]!)).toContain(COMMAND_GUIDANCE);
  expect(definitions(f.payloads[0]!)).toEqual(definitions(f.payloads[1]!));
}, childTestLimit(2));
