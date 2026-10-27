/**
 * Repairs the shape of a tool call's arguments before Pi validates them (borrowed from opencode's tool-input
 * repair), so a weaker model's near miss runs instead of failing. Only what the tool's schema makes certain is
 * repaired, never a guess:
 * - an object or array sent as a JSON string is parsed;
 * - a single value where the schema wants an array is wrapped in one;
 * - a few common field names (`file_path`, `filepath`, `cmd`) become the schema's (`path`, `command`), only when
 *   the schema has that name and not the alias, and the call did not also send it.
 * Pi's own validation already drops a null for an optional field and turns "5" into 5 and "true" into true.
 * A repaired call's result gets one line telling the model the right form, so it sends that next time.
 *
 * The other way round is refused for Pi's file tools: Pi's validation would also turn 33, false or null into text
 * where a string is wanted, so `write {"path":33,"content":false}` would make a file named 33 holding "false". A field
 * those tools' schemas want as a string must come as one, or the call does not run and the model is told which.
 */
type Schema = Record<string, unknown>;

const ALIASES: ReadonlyArray<readonly [alias: string, field: string]> = [["file_path", "path"], ["filepath", "path"], ["cmd", "command"]];
const NESTING_LIMIT = 8;
/** Pi's file tools, whose text fields are checked before Pi's validation could turn a number, true or false, or null
 * into text. */
const TEXT_FIELD_TOOLS = new Set(["read", "write", "edit"]);

export interface RepairedArguments { args: unknown; fixes: string[] }

/** The one field of a tool call whose arguments a transport couldn't read (src/runtime/claude-subscription.ts): the
 * call is refused here, before the tool's own hook, Pi's check or the tool, and the model is told why. */
export const INVALID_ARGUMENTS = "__casper_invalid_arguments";

/** A tool call's arguments that say only why they couldn't be read; the call does not run. */
export function invalidArguments(reason: string): Record<string, string> {
  return { [INVALID_ARGUMENTS]: reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON types a schema allows, from `type` and any `anyOf`/`oneOf` members; empty when it does not say. */
function schemaTypes(schema: unknown): Set<string> {
  const types = new Set<string>();
  if (!isObject(schema)) return types;
  if (typeof schema.type === "string") types.add(schema.type);
  else if (Array.isArray(schema.type)) for (const type of schema.type) if (typeof type === "string") types.add(type);
  for (const key of ["anyOf", "oneOf"]) {
    const members = schema[key];
    if (Array.isArray(members)) for (const member of members) for (const type of schemaTypes(member)) types.add(type);
  }
  return types;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function allows(types: Set<string>, value: unknown): boolean {
  const type = jsonType(value);
  return types.has(type) || (type === "integer" && types.has("number"));
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

function repairValue(value: unknown, schema: unknown, name: string, fixes: string[], depth: number): unknown {
  if (depth > NESTING_LIMIT || value === undefined) return value;
  const types = schemaTypes(schema);
  let next = value;
  if (types.size && !allows(types, next) && typeof next === "string") {
    const parsed = parseJson(next);
    if (parsed !== undefined && (allows(types, parsed) || (types.has("array") && allows(schemaTypes(itemsOf(schema)), parsed)))) {
      next = parsed;
      fixes.push(`send "${name}" as JSON, not a string holding JSON`);
    }
  }
  if (types.has("array") && !allows(types, next) && next !== null) {
    const itemTypes = schemaTypes(itemsOf(schema));
    // A string that looks like JSON but did not parse (`['a','b']`) is never taken for one item: that would guess.
    if ((!itemTypes.size || allows(itemTypes, next)) && !(typeof next === "string" && /^\s*[[{]/.test(next))) {
      next = [next];
      fixes.push(`send "${name}" as an array`);
    }
  }
  if (Array.isArray(next) && types.has("array")) {
    const items = itemsOf(schema);
    const repaired = next.map((item) => repairValue(item, items, name, fixes, depth + 1));
    if (repaired.some((item, index) => item !== (next as unknown[])[index])) next = repaired;
  } else if (isObject(next) && types.has("object")) {
    next = repairObject(next, schema as Schema, fixes, depth + 1);
  }
  return next;
}

function itemsOf(schema: unknown): unknown {
  return isObject(schema) && isObject(schema.items) ? schema.items : undefined;
}

function repairObject(args: Record<string, unknown>, schema: Schema, fixes: string[], depth: number): Record<string, unknown> {
  const properties = isObject(schema.properties) ? schema.properties : undefined;
  if (!properties) return args;
  let next = args;
  const copy = () => { if (next === args) next = { ...args }; return next; };
  for (const [alias, field] of ALIASES) {
    if (!(alias in next) || field in next || !(field in properties) || alias in properties) continue;
    const renamed = copy();
    renamed[field] = renamed[alias];
    delete renamed[alias];
    fixes.push(`use "${field}", not "${alias}"`);
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in next)) continue;
    const repaired = repairValue(next[key], propertySchema, key, fixes, depth);
    if (repaired !== next[key]) copy()[key] = repaired;
  }
  return next;
}

/** The arguments with their shape repaired against `schema`, and what was repaired. Unchanged arguments come back as
 * the same object, and the input is never changed. */
export function repairToolArguments(schema: unknown, args: unknown): RepairedArguments {
  const fixes: string[] = [];
  let next = args;
  if (typeof next === "string" && schemaTypes(schema).has("object")) {
    const parsed = parseJson(next);
    if (isObject(parsed)) { next = parsed; fixes.push("send the arguments as a JSON object, not a string"); }
  }
  if (isObject(next) && isObject(schema)) next = repairObject(next, schema, fixes, 0);
  return { args: next, fixes: [...new Set(fixes)] };
}

function sent(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `the ${typeof value} ${String(value)}`;
}

/** Each field the schema wants as a string but the call sent as something else, as "path must be a string, not the
 * number 33". Fields not sent are left for Pi's validation to report. */
function textFieldProblems(value: unknown, schema: unknown, name: string, depth: number): string[] {
  if (depth > NESTING_LIMIT || value === undefined) return [];
  const types = schemaTypes(schema);
  if (types.size === 1 && types.has("string")) return typeof value === "string" ? [] : [`${name} must be a string, not ${sent(value)}`];
  if (Array.isArray(value) && types.has("array")) return value.flatMap((item, index) => textFieldProblems(item, itemsOf(schema), `${name}[${index}]`, depth + 1));
  if (!isObject(value) || !types.has("object") || !isObject(schema) || !isObject(schema.properties)) return [];
  return Object.entries(schema.properties).flatMap(([key, property]) => textFieldProblems(value[key], property, name ? `${name}.${key}` : key, depth + 1));
}

/** Why a call to one of Pi's file tools must not run (a text field sent as a number, true or false, null, a list or an
 * object), or undefined when it may. */
export function textFieldRefusal(tool: string, schema: unknown, args: unknown): string | undefined {
  if (!TEXT_FIELD_TOOLS.has(tool)) return undefined;
  const problems = textFieldProblems(args, schema, "", 0);
  if (!problems.length) return undefined;
  return `${tool} did not run: ${problems.join("; ")}. ${problems.length === 1 ? "Send it as a string." : "Send them as strings."}`;
}

export function repairNote(fixes: string[]): string {
  return `Casper repaired this call's arguments. Next time ${fixes.join("; ")}.`;
}

/**
 * Pi prepares a call's arguments, validates them and then raises tool_call for that call, in that order and without
 * another call in between, so a repair noted under the tool's name is claimed by its call's id in tool_call.
 */
export class ToolArgumentRepair {
  private readonly pending = new Map<string, string>();
  private readonly notes = new Map<string, string>();

  /** A `prepareArguments` hook for a tool: the tool's own hook first, if it has one, so what it already repairs
   * quietly (Pi's edit takes `edits` as a JSON string or one object) gets no note; then this repair. A file tool call
   * with a text field that is not text throws, which Pi returns to the model as the call's error, before it runs. */
  hook<T>(name: string, schema: unknown, own?: (args: unknown) => T): (args: unknown) => T {
    return (args) => {
      if (isObject(args) && typeof args[INVALID_ARGUMENTS] === "string") { this.pending.delete(name); throw new Error(`Not run: ${args[INVALID_ARGUMENTS]}`); }
      const { args: repaired, fixes } = repairToolArguments(schema, own ? own(args) : args);
      const refusal = textFieldRefusal(name, schema, repaired);
      if (refusal) { this.pending.delete(name); throw new Error(refusal); }
      if (fixes.length) this.pending.set(name, repairNote(fixes));
      else this.pending.delete(name);
      return repaired as T;
    };
  }

  /** From tool_call: ties a repair just made for this tool to its call. */
  claim(toolName: string, toolCallId: string): void {
    const note = this.pending.get(toolName);
    if (note === undefined) return;
    this.pending.delete(toolName);
    this.notes.set(toolCallId, note);
  }

  /** From tool_result: the line to add to the call's result, once. */
  take(toolCallId: string): string | undefined {
    const note = this.notes.get(toolCallId);
    this.notes.delete(toolCallId);
    return note;
  }
}
