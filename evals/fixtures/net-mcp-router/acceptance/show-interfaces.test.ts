import { expect, test } from "bun:test";
import type { Inventory } from "../src/inventory";
import { MAX_OUTPUT_CHARS } from "../src/result";
import { createRouter } from "../src/router";
import { deviceTools } from "../src/tools";

const many = Array.from({ length: 120 }, (_, index) => ({
  name: `ge-0/0/${index}`, adminUp: true, operUp: index % 3 !== 0, description: `port ${index} ${"x".repeat(40)}`, speedMbps: 1000,
}));
const inventory: Inventory = new Map([
  ["core-1", { hostname: "core-1", model: "EX4400", firmware: "23.4R2", interfaces: [
    { name: "ge-0/0/0", adminUp: true, operUp: true, description: "wan", speedMbps: 1000 },
    { name: "ge-0/0/1", adminUp: true, operUp: false, description: null, speedMbps: null },
    { name: "xe-0/1/0", adminUp: false, operUp: false, description: "spare", speedMbps: 10000 },
    { name: "ae0", adminUp: true, operUp: true, description: "to-dist", speedMbps: 20000 },
  ] }],
  ["big-1", { hostname: "big-1", model: "QFX", firmware: "23.4R2", interfaces: many }],
]);
const router = () => createRouter(inventory);
const text = (result: { content: readonly { text: string }[] }) => result.content.map((part) => part.text).join("");
const read = (args: unknown) => router().callTool("invoke_read_tool", { name: "show_interfaces", arguments: args });

test("show_interfaces is a registered device tool, not a directly listed one", () => {
  expect(deviceTools.map((tool) => tool.name)).toEqual(["set_interface_description", "show_interfaces", "show_version"]);
  expect(router().listTools().map((tool) => tool.name)).toEqual(["find_tool", "invoke_read_tool", "invoke_tool"]);
});

test("it is discoverable: find_tool 'interfaces' and 'interface status' return it first, marked read-only", () => {
  for (const query of ["interfaces", "interface status"]) {
    const found = JSON.parse(text(router().callTool("find_tool", { query, include_schema: true })));
    expect(found[0]).toMatchObject({ name: "show_interfaces", readOnly: true });
    expect(found[0].inputSchema.required).toEqual(["device"]);
  }
});

test("schema and annotations: device required, prefix string, operUp boolean, read-only closed-world", () => {
  const tool = deviceTools.find((entry) => entry.name === "show_interfaces")!;
  const schema = tool.inputSchema as unknown as { properties: Record<string, { type: string; description?: string }>; additionalProperties: boolean; required: string[] };
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toEqual(["device"]);
  expect(Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, value.type]))).toEqual({ device: "string", prefix: "string", operUp: "boolean" });
  for (const property of Object.values(schema.properties)) expect(property.description?.length ?? 0).toBeGreaterThan(0);
  expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});

test("invoke_read_tool returns every interface as JSON with total and truncated", () => {
  const result = read({ device: "core-1" });
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(text(result))).toEqual({ device: "core-1", total: 4, truncated: false, interfaces: [
    { name: "ge-0/0/0", adminUp: true, operUp: true, description: "wan", speedMbps: 1000 },
    { name: "ge-0/0/1", adminUp: true, operUp: false, description: null, speedMbps: null },
    { name: "xe-0/1/0", adminUp: false, operUp: false, description: "spare", speedMbps: 10000 },
    { name: "ae0", adminUp: true, operUp: true, description: "to-dist", speedMbps: 20000 },
  ] });
});

test("prefix and operUp filters combine", () => {
  expect(JSON.parse(text(read({ device: "core-1", prefix: "ge-" }))).interfaces.map((entry: { name: string }) => entry.name)).toEqual(["ge-0/0/0", "ge-0/0/1"]);
  expect(JSON.parse(text(read({ device: "core-1", operUp: false }))).interfaces.map((entry: { name: string }) => entry.name)).toEqual(["ge-0/0/1", "xe-0/1/0"]);
  expect(JSON.parse(text(read({ device: "core-1", prefix: "ge-", operUp: true })))).toMatchObject({ total: 1, truncated: false });
  expect(JSON.parse(text(read({ device: "core-1", prefix: "zz" })))).toEqual({ device: "core-1", total: 0, truncated: false, interfaces: [] });
});

test("large devices are bounded: at most 50 interfaces, total counts all matches, output under the limit", () => {
  const output = text(read({ device: "big-1" }));
  expect(output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
  const body = JSON.parse(output);
  expect(body.total).toBe(120);
  expect(body.truncated).toBe(true);
  expect(body.interfaces.length).toBeGreaterThan(0);
  expect(body.interfaces.length).toBeLessThanOrEqual(50);
  expect(body.interfaces[0].name).toBe("ge-0/0/0");
  expect(JSON.parse(text(read({ device: "big-1", operUp: false })))).toMatchObject({ total: 40 });
});

test("an unknown device is a tool error naming the known devices", () => {
  const result = read({ device: "nope" });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("nope");
  expect(text(result)).toContain("core-1");
});

test("invalid arguments are tool errors, never exceptions", () => {
  for (const args of [{}, { device: "" }, { device: "core-1", operUp: "yes" }, { device: "core-1", extra: 1 }, { device: 4 }]) {
    const result = read(args);
    expect(result.isError).toBe(true);
    expect(text(result).startsWith("Invalid arguments")).toBe(true);
  }
});
