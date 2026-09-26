export type ConfigValue = string | number | boolean | readonly string[] | ConfigObject;
export interface ConfigObject { readonly [key: string]: ConfigValue }

export interface ConfigIssue {
  /** Dot-separated key path, for example `db.port`; `""` for the whole file. */
  readonly path: string;
  readonly source: "file" | "env";
  /** `unknown key`, or `expected <string|number|boolean|list|object>`. */
  readonly message: string;
}

export interface ConfigSources {
  /** The parsed JSON config file, if there is one. */
  readonly file?: unknown;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(`Invalid configuration: ${issues.length} problem${issues.length === 1 ? "" : "s"}`);
    this.name = "ConfigError";
  }
}

type Kind = "string" | "number" | "boolean" | "list" | "object";
type Mutable = { [key: string]: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function kindOf(value: unknown): Kind | undefined {
  if (Array.isArray(value)) return "list";
  if (isObject(value)) return "object";
  if (typeof value === "string" || typeof value === "boolean") return typeof value;
  if (typeof value === "number") return "number";
  return undefined;
}

/** Lists keep the first occurrence of each item, from any source. */
const unique = (items: readonly string[]) => [...new Set(items)];

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  return value;
}

const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

function mergeFile(target: Mutable, schema: ConfigObject, input: Record<string, unknown>, prefix: string, issues: ConfigIssue[]): void {
  for (const key of Object.keys(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!has(schema, key)) { issues.push({ path, source: "file", message: "unknown key" }); continue; }
    const expected = kindOf(schema[key])!;
    const value = input[key];
    if (expected === "object") {
      if (!isObject(value)) issues.push({ path, source: "file", message: "expected object" });
      else mergeFile(target[key] as Mutable, schema[key] as ConfigObject, value, path, issues);
      continue;
    }
    const ok = expected === "list"
      ? Array.isArray(value) && value.every((item) => typeof item === "string")
      : kindOf(value) === expected && (expected !== "number" || Number.isFinite(value));
    if (!ok) issues.push({ path, source: "file", message: `expected ${expected}` });
    else target[key] = expected === "list" ? unique(value as string[]) : clone(value);
  }
}

function fromEnv(raw: string, kind: Kind): { value: unknown } | undefined {
  if (kind === "string") return { value: raw };
  if (kind === "number") {
    const value = Number(raw);
    return raw.trim() !== "" && Number.isFinite(value) ? { value } : undefined;
  }
  if (kind === "boolean") return raw === "true" ? { value: true } : raw === "false" ? { value: false } : undefined;
  if (kind === "list") {
    // `\,` is a comma inside an item.
    const items = raw.split(/(?<!\\),/).map((item) => item.replaceAll("\\,", ",").trim()).filter((item) => item !== "");
    return { value: unique(items) };
  }
  return undefined;
}

export function loadConfig<T extends ConfigObject>(defaults: T, sources: ConfigSources = {}): T {
  const issues: ConfigIssue[] = [];
  const result = clone(defaults) as Mutable;
  if (sources.file !== undefined) {
    if (!isObject(sources.file)) issues.push({ path: "", source: "file", message: "expected object" });
    else mergeFile(result, defaults, sources.file, "", issues);
  }
  const env = sources.env ?? {};
  const names = Object.keys(env).filter((name) => name.startsWith("APP_") && env[name] !== undefined).sort();
  for (const name of names) {
    const keys = name.slice(4).toLowerCase().split("__");
    const path = keys.join(".");
    let schema: ConfigValue = defaults;
    let target = result;
    let known = true;
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      if (!isObject(schema) || key === "" || !has(schema, key)) { known = false; break; }
      if (index < keys.length - 1) {
        schema = (schema as ConfigObject)[key]!;
        if (isObject(schema)) target = target[key] as Mutable;
      } else {
        const kind = kindOf((schema as ConfigObject)[key])!;
        const converted = fromEnv(env[name]!, kind);
        if (!converted) issues.push({ path, source: "env", message: `expected ${kind}` });
        else target[key] = converted.value;
      }
    }
    if (!known) issues.push({ path, source: "env", message: "unknown key" });
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return result as T;
}
