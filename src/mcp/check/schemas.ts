/**
 * Schema checks for `casper mcp check`. Every schema is compiled with the same validator Casper uses for
 * real calls (compileInputSchema), so a schema that passes here also works in the broker.
 */
import { MAX_SCHEMA_BYTES } from "../../capabilities/broker";
import { compileInputSchema } from "../../capabilities/validate";
import { redactPreview } from "../../tui/format";
import type { Finding } from "./index";
import type { CheckTool } from "./labels";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compileProblem(schema: unknown): string | undefined {
  try { compileInputSchema(schema); return undefined; } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : String(error);
    const text = redactPreview(cause);
    return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  }
}

/** Size as Casper measures it for its 12 KB limit: the schema as an escaped JSON string. */
export function schemaBytes(schema: unknown): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(schema ?? {})));
}

/** Findings for each tool's inputSchema (and outputSchema): valid JSON Schema, type "object", every
 * required field declared, and not over Casper's 12 KB schema limit. */
export function checkSchemas(tools: readonly (CheckTool & { outputSchema?: unknown })[]): Finding[] {
  const findings: Finding[] = [];
  const fail = (text: string): Finding => ({ section: "server", status: "fail", label: "schema", text });
  for (const tool of tools) {
    const schema = tool.inputSchema;
    if (!record(schema)) { findings.push(fail(`${tool.name}: has no input schema. Use {"type": "object"} for a tool without fields.`)); continue; }
    if (schema.type !== "object") findings.push(fail(`${tool.name}: the input schema must have "type": "object".`));
    const problem = compileProblem(schema);
    if (problem) findings.push(fail(`${tool.name}: schema is not valid JSON Schema (${problem}).`));
    const declared = record(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (typeof field === "string" && !Object.hasOwn(declared, field)) findings.push(fail(`${tool.name}: required field "${field}" is not in properties.`));
      }
    }
    const bytes = schemaBytes(schema);
    if (bytes > MAX_SCHEMA_BYTES) {
      findings.push({ section: "server", status: "warn", label: "schema", text: `${tool.name}: schema is ${bytes.toLocaleString("en-US")} bytes; Casper can't call tools over 12 KB (${MAX_SCHEMA_BYTES.toLocaleString("en-US")} bytes).` });
    }
    if (tool.outputSchema !== undefined) {
      const output = record(tool.outputSchema) ? compileProblem(tool.outputSchema) : "not an object";
      if (output) findings.push(fail(`${tool.name}: output schema is not valid JSON Schema (${output}).`));
    }
  }
  return findings;
}
