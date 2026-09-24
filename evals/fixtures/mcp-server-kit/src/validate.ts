export interface SchemaProperty {
  readonly type: "string" | "integer" | "boolean";
  readonly description: string;
  readonly minLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: unknown;
}

export interface InputSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, SchemaProperty>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

/** Returns the first problem as `Invalid arguments: …`, or null when the arguments match. */
export function validate(schema: InputSchema, args: unknown): string | null {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "Invalid arguments: expected an object";
  const record = args as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!(key in schema.properties)) return `Invalid arguments: unknown property ${key}`;
  for (const key of schema.required) if (record[key] === undefined) return `Invalid arguments: ${key} is required`;
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = record[key];
    if (value === undefined) continue;
    if (property.type === "integer" ? !Number.isInteger(value) : typeof value !== property.type) return `Invalid arguments: ${key} must be ${property.type === "integer" ? "an integer" : `a ${property.type}`}`;
    if (property.minLength !== undefined && typeof value === "string" && value.length < property.minLength) return `Invalid arguments: ${key} must be at least ${property.minLength} characters`;
    if (property.minimum !== undefined && typeof value === "number" && value < property.minimum) return `Invalid arguments: ${key} must be at least ${property.minimum}`;
    if (property.maximum !== undefined && typeof value === "number" && value > property.maximum) return `Invalid arguments: ${key} must be at most ${property.maximum}`;
  }
  return null;
}
