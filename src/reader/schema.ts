/**
 * The schema guard for casper_read_untrusted. The caller's JSON Schema is copied into a tight one: every object
 * takes no fields it does not name, every string and list has a size cap, and free text longer than 500 characters
 * must be marked `"x-casper-quoted": true` (it then comes back wrapped as quoted data with its source). Refs,
 * anyOf/oneOf/allOf, pattern properties and several types per field are refused, so the shape stays easy to check.
 */

export const QUOTED_KEY = "x-casper-quoted";
/** A string with no maxLength gets this one. */
export const DEFAULT_STRING_MAX = 200;
/** The longest a string may be without being marked quoted. */
export const FREE_TEXT_MAX = 500;
/** The longest a quoted string may be. */
export const QUOTED_MAX = 8000;
export const DEFAULT_ITEMS_MAX = 100;
export const ITEMS_MAX = 1000;
const MAX_DEPTH = 6;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_ENUM = 100;

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
/** Keywords copied as they are (after a type check). Anything else is refused by name. */
const PLAIN_KEYS = new Set(["type", "description", "title", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "multipleOf", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems", "required", "properties", "items",
  "additionalProperties", "default", "examples", QUOTED_KEY, "$schema"]);

export type PreparedSchema = { ok: true; schema: Record<string, unknown> } | { ok: false; reason: string };

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);
const at = (path: string) => path || "the top";

class SchemaRefused extends Error {}
const refuse = (reason: string): never => { throw new SchemaRefused(reason); };

/** The tight copy of `input`, or a plain reason it can't be used. */
export function prepareReaderSchema(input: unknown): PreparedSchema {
  if (!isNode(input)) return { ok: false, reason: "schema must be a JSON Schema object" };
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(input)); } catch { return { ok: false, reason: "schema must be plain JSON" }; }
  if (size > MAX_SCHEMA_BYTES) return { ok: false, reason: "schema is over 16 KB; ask for fewer fields" };
  if (input.type !== "object") return { ok: false, reason: 'schema must have "type": "object" at the top' };
  try { return { ok: true, schema: tighten(input, "", 0) }; }
  catch (error) {
    if (error instanceof SchemaRefused) return { ok: false, reason: error.message };
    throw error;
  }
}

function tighten(node: unknown, path: string, depth: number): Node {
  if (!isNode(node)) return refuse(`${at(path)}: each field needs a schema object`);
  if (depth > MAX_DEPTH) return refuse(`${at(path)}: schema is nested more than ${MAX_DEPTH} levels`);
  for (const key of Object.keys(node)) if (!PLAIN_KEYS.has(key)) refuse(`${at(path)}: "${key.slice(0, 40)}" is not supported in a reader schema (use type, properties, items, enum, maxLength and the like)`);
  const type = node.type;
  if (typeof type !== "string" || !TYPES.has(type)) return refuse(`${at(path)}: needs one "type" (object, array, string, number, integer, boolean or null)`);
  const out: Node = {};
  for (const key of ["type", "description", "title", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minLength", "pattern", "format", "minItems", "uniqueItems"]) if (node[key] !== undefined) out[key] = node[key];
  if (out.enum !== undefined && (!Array.isArray(out.enum) || out.enum.length > MAX_ENUM || out.enum.some((value) => isNode(value) || Array.isArray(value)))) {
    refuse(`${at(path)}: enum must be a list of up to ${MAX_ENUM} plain values`);
  }
  if (node[QUOTED_KEY] !== undefined && (node[QUOTED_KEY] !== true || type !== "string")) refuse(`${at(path)}: "${QUOTED_KEY}": true goes only on a string`);
  if (type === "object") {
    const properties = node.properties ?? {};
    if (!isNode(properties)) refuse(`${at(path)}: properties must be an object`);
    out.properties = Object.fromEntries(Object.entries(properties as Node).map(([name, child]) => [name, tighten(child, `${path}.${name}`.replace(/^\./, ""), depth + 1)]));
    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || node.required.some((name) => typeof name !== "string")) refuse(`${at(path)}: required must be a list of field names`);
      out.required = node.required;
    }
    // Never more fields than the caller named, whatever the schema says.
    out.additionalProperties = false;
  } else if (type === "array") {
    if (!isNode(node.items)) refuse(`${at(path)}: a list needs "items" with one schema`);
    out.items = tighten(node.items, `${path}[]`, depth + 1);
    out.maxItems = cap(node.maxItems, DEFAULT_ITEMS_MAX, ITEMS_MAX, `${at(path)}: maxItems`);
  } else if (type === "string") {
    const quoted = node[QUOTED_KEY] === true;
    out.maxLength = cap(node.maxLength, DEFAULT_STRING_MAX, quoted ? QUOTED_MAX : FREE_TEXT_MAX,
      quoted ? `${at(path)}: maxLength` : `${at(path)}: free text over ${FREE_TEXT_MAX} characters needs "${QUOTED_KEY}": true, and maxLength`);
    if (quoted) out[QUOTED_KEY] = true;
  }
  return out;
}

function cap(value: unknown, fallback: number, limit: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return refuse(`${label} must be a whole number`);
  if (value > limit) return refuse(`${label} can be at most ${limit}`);
  return value;
}

/** Each quoted string's place: walk `schema` with `data` and call `visit` for every string value. */
export function walkStrings(data: unknown, schema: Node, path: string,
  visit: (value: string, schema: Node, path: string) => unknown): unknown {
  if (typeof data === "string") return visit(data, schema, path);
  if (Array.isArray(data) && isNode(schema.items)) return data.map((item, index) => walkStrings(item, schema.items as Node, `${path}[${index}]`, visit));
  if (isNode(data) && isNode(schema.properties)) {
    const properties = schema.properties as Record<string, Node>;
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, properties[key] ? walkStrings(value, properties[key], path ? `${path}.${key}` : key, visit) : value]));
  }
  return data;
}

/** True for a top-level list field: long text is read in parts and these lists are joined. */
export function topLevelLists(schema: Node): string[] {
  const properties = isNode(schema.properties) ? schema.properties as Record<string, Node> : {};
  return Object.entries(properties).filter(([, child]) => child.type === "array").map(([name]) => name);
}
