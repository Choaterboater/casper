import { isVerificationScope, type VerificationScope } from "../verify/scope";

/** One service declared in `.casper/project.yaml` under `services.<name>`. */
export interface ServiceSpec {
  /** Shell string run at the project root. */
  command: string;
  port: "auto" | number;
  /** An HTTP path probed on the service's loopback origin, or a log line. */
  ready: { http: string } | { log: string };
  timeoutMs: number;
  /** Edits inside it mark the service stale; without one, any edit does. */
  scope?: VerificationScope;
  /** Literal values only: nothing is passed through from the user's shell. */
  env?: Record<string, string>;
}

export const MAX_SERVICES = 4;
/** Names are identifiers; `adhoc-<n>` is reserved for services the model starts by command. */
export const SERVICE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const SERVICE_KEYS = ["command", "port", "ready", "timeoutMs", "scope", "env"];
/** Casper sets these itself so the service listens where Casper probes. */
const RESERVED_ENV = ["PORT", "HOST"];
/** The runner's isolation and offline guards, which win over declared values anyway; refused
 * here (in any case, as Windows variable names are) so a declaration never looks like it applied. */
const ISOLATION_ENV = ["PATH", "HOME", "TMPDIR", "BUN_INSTALL_AUTO", "NPM_CONFIG_OFFLINE"];

type Mapping = Record<string, unknown>;
const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);

/** Validates the project layer's `services` section; every error names the dotted path. */
export function parseServices(value: unknown, label = ".casper/project.yaml"): Record<string, ServiceSpec> {
  if (value === undefined || value === null) return {};
  const fail = (message: string): never => { throw new Error(`Invalid ${label}: ${message}`); };
  if (!isMapping(value)) return fail("services must be a mapping of service names to declarations");
  const entries = Object.entries(value);
  if (entries.length > MAX_SERVICES) fail(`services declares ${entries.length} services; at most ${MAX_SERVICES} are allowed`);
  const services: Record<string, ServiceSpec> = {};
  for (const [name, entry] of entries) {
    const at = `services.${name}`;
    if (!SERVICE_NAME.test(name) || name.startsWith("adhoc-")) fail(`${at}: a service name is a letter then up to 31 letters, digits, _ or - (adhoc-<n> is reserved)`);
    if (!isMapping(entry)) return fail(`${at} must be a mapping with command, port and ready`);
    const unknown = Object.keys(entry).find(key => !SERVICE_KEYS.includes(key));
    if (unknown) fail(`${at}.${unknown} is not a service setting (expected ${SERVICE_KEYS.join(", ")})`);
    const { command, port = "auto", ready, timeoutMs = 30_000, scope, env } = entry;
    if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command) > 4096) fail(`${at}.command must be a nonempty shell command of at most 4 KiB`);
    if (port !== "auto" && !(typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535)) {
      fail(`${at}.port must be auto or an integer between 1024 and 65535`);
    }
    if (!isMapping(ready) || Object.keys(ready).length !== 1 || !("http" in ready || "log" in ready)) {
      return fail(`${at}.ready must be { http: <path> } or { log: <text> }`);
    }
    if ("http" in ready && (typeof ready.http !== "string" || !/^\/(?!\/)[^\s\\]*$/.test(ready.http) || ready.http.length > 1024)) {
      fail(`${at}.ready.http must be a path on the service, such as /health`);
    }
    if ("log" in ready && (typeof ready.log !== "string" || !ready.log.trim() || ready.log.length > 1024)) fail(`${at}.ready.log must be nonempty text of at most 1024 characters`);
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
      fail(`${at}.timeoutMs must be an integer between 1000 and 120000`);
    }
    if (scope !== undefined && !isVerificationScope(scope)) fail(`${at}.scope: expected bounded, nonempty project-relative inputs and optional exclude paths (no globs)`);
    if (env !== undefined) {
      if (!isMapping(env) || Object.keys(env).length > 32) fail(`${at}.env must be a mapping of at most 32 variable names to literal strings`);
      for (const [key, item] of Object.entries(env as Mapping)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) fail(`${at}.env.${key} is not a variable name`);
        if (RESERVED_ENV.includes(key)) fail(`${at}.env.${key} is set by Casper to the service's address`);
        if (ISOLATION_ENV.includes(key.toUpperCase())) fail(`${at}.env.${key} is set by Casper (an isolated home and PATH, installs disabled)`);
        if (typeof item !== "string" || Buffer.byteLength(item) > 4096) fail(`${at}.env.${key} must be a literal string of at most 4 KiB`);
      }
    }
    services[name] = { command: command as string, port: port as ServiceSpec["port"], ready: ready as ServiceSpec["ready"], timeoutMs: timeoutMs as number,
      ...(scope !== undefined ? { scope: scope as VerificationScope } : {}), ...(env !== undefined ? { env: env as Record<string, string> } : {}) };
  }
  return services;
}
