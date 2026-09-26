import { expect, test } from "bun:test";
import { ConfigError, loadConfig, type ConfigIssue } from "../src/config";

const defaults = {
  name: "app",
  debug: false,
  hosts: ["a.example.com"],
  db: { host: "localhost", port: 5432, pool: { max: 10 } },
  log_level: "info",
};

function issues(run: () => unknown): ConfigIssue[] {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message.startsWith("Invalid configuration")).toBe(true);
    return [...(error as ConfigError).issues];
  }
  throw new Error("expected a ConfigError");
}

test("nested objects merge key by key: env over file over defaults", () => {
  const config = loadConfig(defaults, {
    file: { db: { port: 6000, pool: { max: 20 } }, name: "from-file" },
    env: { APP_DB__PORT: "7000", APP_NAME: "from-env" },
  });
  expect(config).toEqual({ ...defaults, name: "from-env", db: { host: "localhost", port: 7000, pool: { max: 20 } } });
});

test("a list from a higher source replaces the lower one entirely", () => {
  expect(loadConfig(defaults, { file: { hosts: ["b.example.com", "c.example.com"] } }).hosts).toEqual(["b.example.com", "c.example.com"]);
  expect(loadConfig(defaults, { file: { hosts: ["b.example.com"] }, env: { APP_HOSTS: " d.example.com , e.example.com ," } }).hosts)
    .toEqual(["d.example.com", "e.example.com"]);
  expect(loadConfig(defaults, { env: { APP_HOSTS: "" } }).hosts).toEqual([]);
});

test("env names: APP_ prefix only, lowercased, __ nests, a single _ stays in the key", () => {
  const config = loadConfig(defaults, { env: { APP_LOG_LEVEL: "debug", APP_DB__POOL__MAX: "3", PATH: "/usr/bin", NAME: "ignored", APP_DEBUG: undefined } });
  expect(config.log_level).toBe("debug");
  expect(config.db.pool.max).toBe(3);
  expect(config.name).toBe("app");
  expect(config.debug).toBe(false);
});

test("env values are converted to the default's type", () => {
  const config = loadConfig(defaults, { env: { APP_DEBUG: "true", APP_DB__PORT: "5433" } });
  expect(config.debug).toBe(true);
  expect(config.db.port).toBe(5433);
  expect(loadConfig(defaults, { env: { APP_DEBUG: "false" } }).debug).toBe(false);
  expect(issues(() => loadConfig(defaults, { env: { APP_DB__PORT: "54x" } }))).toEqual([{ path: "db.port", source: "env", message: "expected number" }]);
  expect(issues(() => loadConfig(defaults, { env: { APP_DB__PORT: "" } }))).toEqual([{ path: "db.port", source: "env", message: "expected number" }]);
  expect(issues(() => loadConfig(defaults, { env: { APP_DEBUG: "yes" } }))).toEqual([{ path: "debug", source: "env", message: "expected boolean" }]);
  expect(issues(() => loadConfig(defaults, { env: { APP_DB: "x" } }))).toEqual([{ path: "db", source: "env", message: "expected object" }]);
});

test("unknown keys in the file or the environment are errors with their full path", () => {
  expect(issues(() => loadConfig(defaults, { file: { db: { hots: "x" } } }))).toEqual([{ path: "db.hots", source: "file", message: "unknown key" }]);
  expect(issues(() => loadConfig(defaults, { env: { APP_DB__USER: "x" } }))).toEqual([{ path: "db.user", source: "env", message: "unknown key" }]);
  expect(issues(() => loadConfig(defaults, { env: { APP_NAME__FIRST: "x" } }))).toEqual([{ path: "name.first", source: "env", message: "unknown key" }]);
});

test("file values must have the default's type; null is never a valid value", () => {
  expect(issues(() => loadConfig(defaults, { file: { db: { port: "5432" } } }))).toEqual([{ path: "db.port", source: "file", message: "expected number" }]);
  expect(issues(() => loadConfig(defaults, { file: { hosts: "a.example.com" } }))).toEqual([{ path: "hosts", source: "file", message: "expected list" }]);
  expect(issues(() => loadConfig(defaults, { file: { hosts: ["ok", 1] } }))).toEqual([{ path: "hosts", source: "file", message: "expected list" }]);
  expect(issues(() => loadConfig(defaults, { file: { db: null } }))).toEqual([{ path: "db", source: "file", message: "expected object" }]);
  expect(issues(() => loadConfig(defaults, { file: { debug: null } }))).toEqual([{ path: "debug", source: "file", message: "expected boolean" }]);
  expect(issues(() => loadConfig(defaults, { file: [] }))).toEqual([{ path: "", source: "file", message: "expected object" }]);
});

test("every problem is reported at once: file issues in key order, then env issues by variable name", () => {
  expect(issues(() => loadConfig(defaults, {
    file: { name: 1, extra: true, db: { port: "x" } },
    env: { APP_ZZZ: "1", APP_DEBUG: "maybe", APP_DB__PORT: "nope" },
  }))).toEqual([
    { path: "name", source: "file", message: "expected string" },
    { path: "extra", source: "file", message: "unknown key" },
    { path: "db.port", source: "file", message: "expected number" },
    { path: "db.port", source: "env", message: "expected number" },
    { path: "debug", source: "env", message: "expected boolean" },
    { path: "zzz", source: "env", message: "unknown key" },
  ]);
});

test("a __proto__ key in the file is an unknown key, not a prototype change", () => {
  const file = JSON.parse('{"__proto__": {"polluted": true}}');
  expect(issues(() => loadConfig(defaults, { file }))).toEqual([{ path: "__proto__", source: "file", message: "unknown key" }]);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("inputs are never mutated and the result shares nothing mutable with them", () => {
  const file = { db: { pool: { max: 20 } }, hosts: ["f.example.com"] };
  const snapshot = structuredClone({ defaults, file });
  const config = loadConfig(defaults, { file }) as unknown as { db: { pool: { max: number } }; hosts: string[] };
  config.db.pool.max = 99;
  config.hosts.push("mutated");
  const plain = loadConfig(defaults) as unknown as { hosts: string[]; db: { host: string } };
  plain.hosts.push("mutated");
  plain.db.host = "mutated";
  expect({ defaults, file }).toEqual(snapshot);
});

test("lists from the file or the environment keep only the first occurrence of each item", () => {
  expect(loadConfig(defaults, { file: { hosts: ["b", "a", "b", "c", "a"] } }).hosts).toEqual(["b", "a", "c"]);
  expect(loadConfig(defaults, { env: { APP_HOSTS: "x, y ,x,,z,y" } }).hosts).toEqual(["x", "y", "z"]);
});

test("in an env list, \\, is a comma inside an item", () => {
  expect(loadConfig(defaults, { env: { APP_HOSTS: String.raw`a\,b, c ,d\,e\,f` } }).hosts).toEqual(["a,b", "c", "d,e,f"]);
});
