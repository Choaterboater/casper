// Checks tool arguments against a tool's input schema and says, in plain
// words, which fields are wrong. Loaded lazily on the first tool call.
//
// It never repeats the values the caller sent: error.data is never read, and
// Ajv runs without `verbose`, so errors do not carry the data at all.
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { suggestField } from "./search";

export type ValidationResult = { valid: true } | { valid: false; problems: string[] };
export type CompiledValidator = (input: unknown) => ValidationResult;

const MAX_FIELD_CHARS = 64;
const MAX_PROBLEMS = 5;
const MAX_PROBLEM_CHARS = 700;
const MAX_ENUM_SHOWN = 5;
const MAX_ENUM_VALUE_CHARS = 40;
const MAX_LINE_CHARS = 200;
const MAX_ID_CHARS = 80;

// Same options as the MCP SDK's default AjvJsonSchemaValidator
// (@modelcontextprotocol/sdk validation/ajv-provider.js). Check them again when
// the SDK is upgraded, so direct tools and fallback calls agree.
const AJV_OPTIONS = { strict: false, validateFormats: true, validateSchema: false, allErrors: true } as const;

function createAjv(): Ajv {
  const ajv = new Ajv(AJV_OPTIONS);
  addFormats(ajv);
  return ajv;
}
let shared: Ajv | undefined;

/**
 * Compile a tool's input schema once. Throws a plain error (without the
 * schema's text) when the schema cannot be compiled.
 */
export function compileInputSchema(schema: unknown): CompiledValidator {
  // Ajv registers schemas by $id. A shared instance would let one server's
  // schema stand in for another's with the same $id, so those compile alone.
  const ajv = hasId(schema) ? createAjv() : (shared ??= createAjv());
  let check: ReturnType<Ajv["compile"]>;
  try {
    check = ajv.compile(schema as object);
  } catch (error) {
    throw new Error("Tool input schema could not be compiled", { cause: error });
  }
  return (input) => {
    if (check(input)) return { valid: true };
    return { valid: false, problems: describeProblems(check.errors ?? [], schema) };
  };
}

/** One plain message for bad arguments, in the agreed "Not executed" form. */
export function formatArgumentError(id: string, problems: readonly string[]): string {
  const shown = clean(id).slice(0, MAX_ID_CHARS);
  const list = problems.length ? problems.join("; ") : "arguments do not match the schema";
  return `Not executed (bad arguments: ${list}). Check the schema: find_capability({ id: "${shown}" }).`;
}

/**
 * Turn Ajv errors into short phrases such as 'missing field "site"' or
 * 'field "hosts[1]" must be a string'. At most 5 phrases and 700 characters,
 * with '(and N more)' when some were left out.
 */
export function describeProblems(errors: readonly ErrorObject[], schema: unknown): string[] {
  // anyOf/oneOf report every failed branch first; fold them into one line.
  const groups = errors.filter((error) => error.keyword === "anyOf" || error.keyword === "oneOf").map((error) => `${error.schemaPath}/`);
  const phrases: string[] = [];
  for (const error of errors) {
    if (groups.some((prefix) => error.schemaPath.startsWith(prefix))) continue;
    const phrase = describe(error, schema);
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  const shown: string[] = [];
  let used = 0;
  for (const phrase of phrases) {
    if (shown.length >= MAX_PROBLEMS || used + phrase.length + 2 > MAX_PROBLEM_CHARS) break;
    shown.push(phrase);
    used += phrase.length + 2;
  }
  if (phrases.length > shown.length) shown.push(`(and ${phrases.length - shown.length} more)`);
  return shown;
}

function describe(error: ErrorObject, schema: unknown): string | undefined {
  const segments = pathSegments(error.instancePath);
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "required": {
      const missing = typeof params.missingProperty === "string" ? params.missingProperty : "";
      return `missing field "${fieldName([...segments, missing])}"`;
    }
    case "additionalProperties": {
      const extra = typeof params.additionalProperty === "string" ? params.additionalProperty : "";
      const known = propertyNames(schemaAt(schema, segments));
      const guess = suggestField(extra, known);
      const hint = guess === undefined ? "" : ` (did you mean "${fieldName([...segments, guess])}"?)`;
      return `unknown field "${fieldName([...segments, extra])}"${hint}`;
    }
    case "type": {
      const types = (Array.isArray(params.type) ? params.type : String(params.type ?? "").split(","))
        .map((type) => clean(String(type)).trim()).filter(Boolean);
      const words = types.map((type, index) => (index === 0 ? withArticle(type) : type)).join(" or ");
      return `${subject(segments)} must be ${words || "a different type"}`;
    }
    case "enum": {
      const allowed = Array.isArray(params.allowedValues) ? params.allowedValues : [];
      const listed = allowed.slice(0, MAX_ENUM_SHOWN).map((value) => enumValue(value)).join(", ");
      const more = allowed.length > MAX_ENUM_SHOWN ? ` (+${allowed.length - MAX_ENUM_SHOWN} more)` : "";
      return `${subject(segments)} must be one of: ${listed}${more}`;
    }
    case "anyOf":
    case "oneOf":
      if (error.keyword === "oneOf" && Array.isArray(params.passingSchemas)) return `${subject(segments)} matches more than one allowed form`;
      return `${subject(segments)} does not match any allowed form`;
    default: {
      // Ajv's own messages describe the rule (like "must be <= 100"), not the value sent.
      const message = clean(error.message ?? "is not valid").slice(0, MAX_LINE_CHARS);
      return `${subject(segments)} ${message}`;
    }
  }
}

function hasId(schema: unknown): boolean {
  try { return JSON.stringify(schema)?.includes('"$id"') ?? false; } catch { return true; }
}

function pathSegments(instancePath: string): string[] {
  if (!instancePath) return [];
  return instancePath.split("/").slice(1).map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function fieldName(segments: readonly string[]): string {
  let name = "";
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) name += `[${segment}]`;
    else name += name ? `.${segment}` : segment;
  }
  return clean(name).slice(0, MAX_FIELD_CHARS);
}

function subject(segments: readonly string[]): string {
  return segments.length ? `field "${fieldName(segments)}"` : "arguments";
}

// Strip control characters so server or model text cannot break the terminal.
function clean(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) continue;
    out += char;
  }
  return out;
}

function withArticle(type: string): string {
  return /^[aeiou]/i.test(type) ? `an ${type}` : `a ${type}`;
}

function enumValue(value: unknown): string {
  let text: string;
  try { text = JSON.stringify(value) ?? String(value); } catch { text = String(value); }
  text = clean(text);
  return text.length > MAX_ENUM_VALUE_CHARS ? `${text.slice(0, MAX_ENUM_VALUE_CHARS - 3)}...` : text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Follow `properties`/`items` from the root schema down to the given path. */
function schemaAt(schema: unknown, segments: readonly string[]): unknown {
  let current: unknown = schema;
  for (const segment of segments) {
    if (!isObject(current)) return undefined;
    if (/^\d+$/.test(segment) && current.items !== undefined) {
      const items = current.items;
      current = Array.isArray(items) ? items[Number(segment)] : items;
    } else if (isObject(current.properties) && Object.hasOwn(current.properties, segment)) {
      current = current.properties[segment];
    } else return undefined;
  }
  return current;
}

function propertyNames(schema: unknown): string[] {
  return isObject(schema) && isObject(schema.properties) ? Object.keys(schema.properties) : [];
}
