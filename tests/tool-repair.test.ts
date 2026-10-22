import { describe, expect, test } from "bun:test";
import os from "node:os";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { repairNote, repairToolArguments, ToolArgumentRepair } from "../src/runtime/tool-repair";

const edit = { type: "object", required: ["path", "edits"], properties: {
  path: { type: "string" },
  edits: { type: "array", items: { type: "object", properties: { oldText: { type: "string" }, newText: { type: "string" } } } },
} };
const bash = { type: "object", required: ["command"], properties: { command: { type: "string" }, timeout: { type: "number" } } };
const names = { type: "object", properties: { names: { type: "array", items: { type: "string" } }, label: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } } };

describe("repairToolArguments", () => {
  test("leaves good arguments as the same object", () => {
    const args = { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] };
    expect(repairToolArguments(edit, args)).toEqual({ args, fixes: [] });
    expect(repairToolArguments(edit, args).args).toBe(args);
  });

  test("parses an array or object sent as a JSON string, and wraps a single object", () => {
    const one = { oldText: "a", newText: "b" };
    expect(repairToolArguments(edit, { path: "a.ts", edits: JSON.stringify([one]) }).args).toEqual({ path: "a.ts", edits: [one] });
    const single = repairToolArguments(edit, { path: "a.ts", edits: JSON.stringify(one) });
    expect(single.args).toEqual({ path: "a.ts", edits: [one] });
    expect(single.fixes).toEqual(['send "edits" as JSON, not a string holding JSON', 'send "edits" as an array']);
    expect(repairToolArguments(edit, { path: "a.ts", edits: one }).args).toEqual({ path: "a.ts", edits: [one] });
  });

  test("wraps a single value where the schema wants an array, only when the items take it", () => {
    expect(repairToolArguments(names, { names: "one" })).toEqual({ args: { names: ["one"] }, fixes: ['send "names" as an array'] });
    expect(repairToolArguments(names, { names: 5 }).args).toEqual({ names: 5 });
    // A field that also takes a string is left alone.
    expect(repairToolArguments(names, { label: "x" }).fixes).toEqual([]);
  });

  test("renames a common alias only when the schema has the field and not the alias", () => {
    expect(repairToolArguments(edit, { file_path: "a.ts", edits: [] })).toEqual({ args: { path: "a.ts", edits: [] }, fixes: ['use "path", not "file_path"'] });
    expect(repairToolArguments(edit, { filepath: "a.ts", edits: [] }).args).toEqual({ path: "a.ts", edits: [] });
    expect(repairToolArguments(bash, { cmd: "ls" }).args).toEqual({ command: "ls" });
    // Both sent: nothing is guessed.
    expect(repairToolArguments(bash, { cmd: "ls", command: "pwd" }).args).toEqual({ cmd: "ls", command: "pwd" });
    // The schema names the alias itself, or lacks the target.
    expect(repairToolArguments({ type: "object", properties: { path: { type: "string" }, file_path: { type: "string" } } }, { file_path: "a" }).fixes).toEqual([]);
    expect(repairToolArguments(names, { cmd: "ls" }).fixes).toEqual([]);
    // Nothing fuzzy: a near name is left for validation to report.
    expect(repairToolArguments(bash, { comand: "ls" }).fixes).toEqual([]);
  });

  test("parses whole arguments sent as a JSON string, and never parses a string field", () => {
    expect(repairToolArguments(bash, JSON.stringify({ cmd: "ls" })).args).toEqual({ command: "ls" });
    expect(repairToolArguments(bash, { command: "[1]" }).args).toEqual({ command: "[1]" });
    expect(repairToolArguments(edit, { path: "a.ts", edits: "[not json" }).args).toEqual({ path: "a.ts", edits: "[not json" });
    // A list that is not JSON is never taken for a single item.
    expect(repairToolArguments(names, { names: "['a', 'b']" })).toEqual({ args: { names: "['a', 'b']" }, fixes: [] });
  });

  test("never changes the arguments it was given", () => {
    const args = { file_path: "a.ts", edits: "[]" };
    repairToolArguments(edit, args);
    expect(args).toEqual({ file_path: "a.ts", edits: "[]" });
  });
});

describe("ToolArgumentRepair", () => {
  test("a repair is noted once on the call that claimed it, after the tool's own hook", () => {
    const repair = new ToolArgumentRepair();
    const hook = repair.hook("bash", bash, (args) => ({ ...(args as Record<string, unknown>), own: true }) as Record<string, unknown>);
    expect(hook({ cmd: "ls" })).toEqual({ command: "ls", own: true });
    repair.claim("bash", "call_1");
    expect(repair.take("call_1")).toBe(repairNote(['use "command", not "cmd"']));
    expect(repair.take("call_1")).toBeUndefined();
    // A later clean call of the same tool is not noted.
    hook({ cmd: "ls" });
    hook({ command: "ls" });
    repair.claim("bash", "call_2");
    expect(repair.take("call_2")).toBeUndefined();
  });

  test("what the tool's own hook already repairs gets no note", () => {
    const repair = new ToolArgumentRepair();
    const own = (args: unknown) => { const input = args as Record<string, unknown>; return typeof input.edits === "string" ? { ...input, edits: JSON.parse(input.edits) } : input; };
    const hook = repair.hook("edit", edit, own);
    expect(hook({ path: "a.ts", edits: "[]" })).toEqual({ path: "a.ts", edits: [] });
    repair.claim("edit", "call_1");
    expect(repair.take("call_1")).toBeUndefined();
  });
});

describe("Pi's file tools refuse a field that must be text but is not", () => {
  // Pi's own definitions, as Casper registers them: their schemas and Pi's own argument hooks.
  const tools = { read: createReadToolDefinition(os.tmpdir()), write: createWriteToolDefinition(os.tmpdir()), edit: createEditToolDefinition(os.tmpdir()) };
  const hookFor = (name: keyof typeof tools) => {
    const tool = tools[name] as { parameters: unknown; prepareArguments?: (args: unknown) => unknown };
    return new ToolArgumentRepair().hook(name, tool.parameters, tool.prepareArguments);
  };

  test("a number, a boolean or null for write's path or content is refused with each field named; nothing is turned into text", () => {
    expect(() => hookFor("write")({ path: 33, content: false }))
      .toThrow("write did not run: path must be a string, not the number 33; content must be a string, not the boolean false. Send them as strings.");
    expect(() => hookFor("write")({ path: "notes.txt", content: null })).toThrow("content must be a string, not null");
    expect(() => hookFor("write")({ path: true, content: "x" })).toThrow("path must be a string, not the boolean true");
    expect(() => hookFor("write")({ file_path: 7, content: "x" })).toThrow("path must be a string, not the number 7");
    expect(hookFor("write")({ path: "notes.txt", content: "" })).toEqual({ path: "notes.txt", content: "" });
  });

  test("edit's path and each edit's old and new text, in any form Pi or Casper repairs, must be text", () => {
    expect(() => hookFor("edit")({ path: "a.ts", edits: [{ oldText: 33, newText: false }] }))
      .toThrow("edit did not run: edits[0].oldText must be a string, not the number 33; edits[0].newText must be a string, not the boolean false.");
    expect(() => hookFor("edit")({ path: 5, edits: [{ oldText: "a", newText: "b" }] })).toThrow("path must be a string, not the number 5");
    expect(() => hookFor("edit")({ path: "a.ts", edits: { oldText: 1, newText: "b" } })).toThrow("edits[0].oldText must be a string, not the number 1");
    expect(() => hookFor("edit")({ path: "a.ts", edits: JSON.stringify([{ oldText: "a", newText: null }]) })).toThrow("edits[0].newText must be a string, not null");
    expect(hookFor("edit")({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] })).toEqual({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] });
  });

  test("read's path must be text; its numbers are still Pi's to convert, and other tools are left to Pi", () => {
    expect(() => hookFor("read")({ path: false })).toThrow("read did not run: path must be a string, not the boolean false. Send it as a string.");
    expect(hookFor("read")({ path: "a.ts", offset: "5" })).toEqual({ path: "a.ts", offset: "5" });
    expect(new ToolArgumentRepair().hook("bash", bash)({ command: 33 })).toEqual({ command: 33 });
  });

  test("a refused call leaves no repair note behind for the next call of that tool", () => {
    const repair = new ToolArgumentRepair();
    const write = repair.hook("write", tools.write.parameters);
    expect(() => write({ file_path: 33, content: "x" })).toThrow("path must be a string");
    write({ path: "a.txt", content: "x" });
    repair.claim("write", "call_2");
    expect(repair.take("call_2")).toBeUndefined();
  });
});
