import { expect, test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** Pi checks a tool call's arguments with pi-schema (Pi 1.5.0 on). Casper's own TypeBox tool schemas stay plain JSON
 * Schema, so the engine checks them; this pins what the model is told and the coercion src/runtime/tool-repair.ts
 * relies on (a number sent for text becomes text, hence Casper's own check for Pi's file tools). */
const tool = { name: "t", description: "", parameters: Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()), list: Type.Optional(Type.Array(Type.String())) }) };
const check = (args: Record<string, unknown>) => validateToolArguments(tool as never, { type: "toolCall", id: "1", name: "t", arguments: args as never });
const failure = (args: Record<string, unknown>) => {
  try { check(args); } catch (error) { return String((error as Error).message).split("\n\nReceived")[0]; }
  throw new Error("the call was accepted");
};

test("a wrong call names each field and what was wrong with it", () => {
  expect(failure({})).toBe('Validation failed for tool "t":\n  - path: missing');
  expect(failure({ path: "a", limit: "x" })).toBe('Validation failed for tool "t":\n  - limit: expected number, got string');
});

test("near misses are coerced: text numbers, a lone value for a list, a null optional, and a number for text", () => {
  expect(check({ path: "a", limit: "5", list: "x" })).toEqual({ path: "a", limit: 5, list: ["x"] });
  expect(check({ path: "a", limit: null })).toEqual({ path: "a" });
  expect(check({ path: 33 })).toEqual({ path: "33" });
});
