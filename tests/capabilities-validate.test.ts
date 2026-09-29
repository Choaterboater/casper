import { expect, test } from "bun:test";
import { compileInputSchema, formatArgumentError, type ValidationResult } from "../src/capabilities/validate";

// Shapes modeled on real network servers (junos-mcp-server execute_junos_command)
// and on the broker's fixture tools. No server is contacted.
const junosCommand = {
  type: "object",
  properties: { router_name: { type: "string" }, command: { type: "string" }, timeout: { type: "integer", maximum: 360 } },
  required: ["router_name", "command"],
  additionalProperties: false,
};
const searchClients = {
  type: "object",
  properties: {
    filter: { type: "object", properties: { vlan: { type: "integer" } } },
    hosts: { type: "array", items: { type: "string" } },
  },
};
const sites = Array.from({ length: 80 }, (_, index) => `site-${index}`);

function problems(result: ValidationResult): string[] {
  if (result.valid) throw new Error("expected invalid arguments");
  return result.problems;
}

test("valid arguments pass", () => {
  expect(compileInputSchema(junosCommand)({ router_name: "r1", command: "show version" })).toEqual({ valid: true });
});

test("missing and unknown fields are named, with a did-you-mean", () => {
  const found = problems(compileInputSchema(junosCommand)({ router: "r1", command: "show version" }));
  expect(found).toContain('missing field "router_name"');
  expect(found).toContain('unknown field "router" (did you mean "router_name"?)');
  const message = formatArgumentError("mcp:junos:execute_junos_command", found);
  expect(message).toStartWith("Not executed (bad arguments: ");
  expect(message).toContain('missing field "router_name"; unknown field "router" (did you mean "router_name"?)');
  expect(message).toEndWith('). Check the schema: find_capability({ id: "mcp:junos:execute_junos_command" }).');
  expect(message).not.toContain("r1");
  expect(message).not.toContain("show version");
});

test("type errors name the field, nested fields use dots and [n]", () => {
  expect(problems(compileInputSchema({ type: "object", properties: { site: { type: "string" } } })({ site: 5 })))
    .toEqual(['field "site" must be a string']);
  const found = problems(compileInputSchema(searchClients)({ filter: { vlan: "ten" }, hosts: ["a", 2] }));
  expect(found).toContain('field "filter.vlan" must be an integer');
  expect(found).toContain('field "hosts[1]" must be a string');
  expect(found.join(" ")).not.toContain("ten");
  expect(problems(compileInputSchema(searchClients)("not an object"))).toEqual(["arguments must be an object"]);
  expect(problems(compileInputSchema({ type: "object", properties: { note: { type: ["string", "null"] } } })({ note: 3 })))
    .toEqual(['field "note" must be a string or null']);
});

test("unknown nested fields suggest from the nested schema", () => {
  const schema = { type: "object", properties: { filter: { type: "object", properties: { vlan_id: { type: "integer" } }, additionalProperties: false } } };
  expect(problems(compileInputSchema(schema)({ filter: { vlan: 10 } }))).toEqual(['unknown field "filter.vlan" (did you mean "filter.vlan_id"?)']);
});

test("enum errors list a few allowed values and never echo the sent value", () => {
  const schema = { type: "object", properties: { site: { enum: sites } }, required: ["site"] };
  const found = problems(compileInputSchema(schema)({ site: "SECRET-VALUE-9" }));
  expect(found).toEqual(['field "site" must be one of: "site-0", "site-1", "site-2", "site-3", "site-4" (+75 more)']);
  const message = formatArgumentError("mcp:generic:inspect_site", found);
  expect(message).not.toContain("SECRET-VALUE-9");
  expect(message.length).toBeLessThan(800);
});

test("long enum values are cut and control characters removed", () => {
  const long = `${"v".repeat(100)}\u001b[31m`;
  const found = problems(compileInputSchema({ type: "object", properties: { mode: { enum: [long] } } })({ mode: "x" }));
  expect(found[0]!.length).toBeLessThan(80);
  expect(found[0]).not.toContain("\u001b");
  expect(found[0]).toContain("...");
});

test("anyOf/oneOf collapse into one line per field", () => {
  const schema = { type: "object", properties: { mode: { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "integer", minimum: 3 }] } } };
  expect(problems(compileInputSchema(schema)({ mode: true }))).toEqual(['field "mode" does not match any allowed form']);
  const one = { type: "object", properties: { port: { oneOf: [{ type: "integer" }, { type: "number" }] } } };
  expect(problems(compileInputSchema(one)({ port: 5 }))).toEqual(['field "port" matches more than one allowed form']);
});

test("other rules reuse Ajv's wording after the field name", () => {
  const found = problems(compileInputSchema(junosCommand)({ router_name: "r1", command: "c", timeout: 999 }));
  expect(found).toEqual(['field "timeout" must be <= 360']);
  expect(found.join(" ")).not.toContain("999");
});

test("the list is capped at 5 problems plus a count", () => {
  const names = Array.from({ length: 12 }, (_, index) => `field_${index}`);
  const found = problems(compileInputSchema({ type: "object", required: names })({}));
  expect(found).toHaveLength(6);
  expect(found.slice(0, 5).every((line) => line.startsWith("missing field"))).toBe(true);
  expect(found[5]).toBe("(and 7 more)");
  expect(formatArgumentError("mcp:generic:many", found).length).toBeLessThan(800);
});

test("long hostile field names are cut to 64 characters and cleaned", () => {
  const name = `bad\u0007${"n".repeat(200)}`;
  const found = problems(compileInputSchema({ type: "object", additionalProperties: false })({ [name]: 1 }));
  expect(found).toHaveLength(1);
  expect(found[0]).not.toContain("\u0007");
  expect(found[0]!.length).toBeLessThanOrEqual('unknown field ""'.length + 64);
  // Even many long problems stay within the message budget.
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`${index}${"z".repeat(300)}`, 1]));
  const capped = problems(compileInputSchema({ type: "object", additionalProperties: false })(many));
  expect(formatArgumentError("mcp:generic:x", capped).length).toBeLessThan(800);
});

test("two schemas with the same $id keep their own rules", () => {
  const first = compileInputSchema({ $id: "https://example.invalid/same.json", type: "object", required: ["a"] });
  const second = compileInputSchema({ $id: "https://example.invalid/same.json", type: "object", required: ["b"] });
  expect(first({ a: 1 })).toEqual({ valid: true });
  expect(problems(second({ a: 1 }))).toEqual(['missing field "b"']);
});

test("a schema that cannot compile gives a plain error", () => {
  expect(() => compileInputSchema({ type: "object", properties: { a: { $ref: "#/nowhere/secret-schema-text" } } }))
    .toThrow("Tool input schema could not be compiled");
});

test("allowed values come from the server and have secrets hidden", () => {
  const schema = { type: "object", properties: { line: { enum: ["wpa-passphrase Corp-Wifi-2026!", "plain"] } } };
  const found = problems(compileInputSchema(schema)({ line: "other" }));
  expect(found.join(" ")).toContain("<secret hidden>");
  expect(found.join(" ")).not.toContain("Corp-Wifi-2026!");
});

test("a rule quoted from the server's schema has secrets hidden", () => {
  const schema = { type: "object", properties: { line: { type: "string", pattern: "^enable secret 5 $1$abcd$Xy9Zk2LmNoPqRsTuVw$" } } };
  const found = problems(compileInputSchema(schema)({ line: "other" })).join(" ");
  expect(found).toContain('field "line" must match pattern');
  expect(found).toContain("<secret hidden>");
  expect(found).not.toContain("Xy9Zk2LmNoPqRsTuVw");
});
