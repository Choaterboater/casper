import { expect, test } from "bun:test";
import { checkSchemas } from "../src/mcp/check/schemas";
import { fixtureTools, schemaOfSize } from "./fixtures/mcp-check-server";

const texts = (findings: { status: string; text: string }[]) => findings.map((finding) => `${finding.status} ${finding.text}`);

test("a required field missing from properties is a problem that names the field", () => {
  expect(texts(checkSchemas([{ name: "get_site", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["site_id"] } }])))
    .toEqual(['fail get_site: required field "site_id" is not in properties.']);
});

test("a schema that is not valid JSON Schema is a problem", () => {
  const findings = texts(checkSchemas([{ name: "get_site", inputSchema: { type: "objekt" } }]));
  expect(findings).toContain('fail get_site: the input schema must have "type": "object".');
  expect(findings).toContain("fail get_site: schema is not valid JSON Schema (type must be JSONType or JSONType[]: objekt).");
  expect(texts(checkSchemas([{ name: "no_schema" }]))).toEqual(['fail no_schema: has no input schema. Use {"type": "object"} for a tool without fields.']);
  expect(texts(checkSchemas([{ name: "bad_output", inputSchema: { type: "object" }, outputSchema: { type: "nope" } }])))
    .toEqual(["fail bad_output: output schema is not valid JSON Schema (type must be JSONType or JSONType[]: nope)."]);
});

test("a schema over Casper's 12 KB limit warns; one at the limit does not", () => {
  expect(checkSchemas([{ name: "at_limit", inputSchema: schemaOfSize(12_000) }])).toEqual([]);
  expect(texts(checkSchemas([{ name: "over", inputSchema: schemaOfSize(12_001) }])))
    .toEqual(["warn over: schema is 12,001 bytes; Casper can't call tools over 12 KB (12,000 bytes)."]);
  expect(checkSchemas(fixtureTools("good"))).toEqual([]);
});
