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

export function loadConfig<T extends ConfigObject>(_defaults: T, _sources: ConfigSources = {}): T {
  throw new Error("not implemented");
}
