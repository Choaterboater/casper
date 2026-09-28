import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PI_TOOL_RULES } from "../src/runtime/pi";

test("the tool rules Casper restores are Pi's own, word for word", async () => {
  const tools = path.resolve(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools");
  const source = (await Promise.all(["read", "edit", "write"].map((name) => readFile(path.join(tools, `${name}.js`), "utf8")))).join("\n");
  expect(PI_TOOL_RULES.length).toBeGreaterThanOrEqual(6);
  for (const rule of PI_TOOL_RULES) expect({ rule, inPi: source.includes(JSON.stringify(rule)) }).toEqual({ rule, inPi: true });
  expect(PI_TOOL_RULES).toContain("Use read to examine files instead of cat or sed.");
});
