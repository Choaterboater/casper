import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { loadConfiguration } from "../src/config/load";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function load(project: unknown, global?: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-services-config-"));
  roots.push(root);
  const homeDir = path.join(root, "home"), projectRoot = path.join(root, "repo");
  await mkdir(path.join(homeDir, ".casper"), { recursive: true });
  await mkdir(path.join(projectRoot, ".casper"), { recursive: true });
  await writeFile(path.join(projectRoot, ".casper/project.yaml"), stringify(project));
  if (global !== undefined) await writeFile(path.join(homeDir, ".casper/config.yaml"), stringify(global));
  return loadConfiguration({ projectRoot, homeDir });
}

const api = { command: "bun run dev", port: "auto", ready: { http: "/health" } };

test("a declared service parses with defaults, and the section is not an unknown key", async () => {
  const loaded = await load({ services: {
    api,
    worker: { command: "bun worker.ts", port: 4100, ready: { log: "worker up" }, timeoutMs: 5000,
      scope: { inputs: ["src"], exclude: ["src/ui"] }, env: { DATABASE_URL: "postgres://localhost/dev" } },
  } });
  expect(loaded.warnings).toEqual([]);
  expect(loaded.services).toEqual({
    api: { command: "bun run dev", port: "auto", ready: { http: "/health" }, timeoutMs: 30_000 },
    worker: { command: "bun worker.ts", port: 4100, ready: { log: "worker up" }, timeoutMs: 5000,
      scope: { inputs: ["src"], exclude: ["src/ui"] }, env: { DATABASE_URL: "postgres://localhost/dev" } },
  });
  expect((await load({})).services).toEqual({});
});

test("invalid service values are rejected with their dotted path", async () => {
  const cases: Array<[unknown, string]> = [
    [[api], "services must be a mapping"],
    [{ api: "bun run dev" }, "services.api must be a mapping"],
    [{ "bad name": api }, "services.bad name"],
    [{ "adhoc-1": api }, "services.adhoc-1"],
    [{ api: { ...api, command: "" } }, "services.api.command"],
    [{ api: { ...api, port: 80 } }, "services.api.port must be auto or an integer between 1024 and 65535"],
    [{ api: { ...api, port: 70000 } }, "services.api.port"],
    [{ api: { ...api, port: "3000" } }, "services.api.port"],
    [{ api: { ...api, ready: undefined } }, "services.api.ready"],
    [{ api: { ...api, ready: { http: "http://example.com/health" } } }, "services.api.ready.http must be a path"],
    [{ api: { ...api, ready: { http: "health" } } }, "services.api.ready.http"],
    [{ api: { ...api, ready: { http: "/", log: "up" } } }, "services.api.ready"],
    [{ api: { ...api, ready: { log: "" } } }, "services.api.ready.log"],
    [{ api: { ...api, timeoutMs: 999 } }, "services.api.timeoutMs must be an integer between 1000 and 120000"],
    [{ api: { ...api, timeoutMs: 120_001 } }, "services.api.timeoutMs"],
    [{ api: { ...api, scope: { inputs: ["../outside"] } } }, "services.api.scope"],
    [{ api: { ...api, env: { DEBUG: 1 } } }, "services.api.env.DEBUG must be a literal string"],
    [{ api: { ...api, env: { PORT: "3000" } } }, "services.api.env.PORT"],
    [{ api: { ...api, env: { HOME: "/home/me" } } }, "services.api.env.HOME is set by Casper"],
    [{ api: { ...api, env: { Path: "/usr/bin" } } }, "services.api.env.Path is set by Casper"],
    [{ api: { ...api, env: { npm_config_offline: "false" } } }, "services.api.env.npm_config_offline"],
    [{ api: { ...api, env: ["A=1"] } }, "services.api.env"],
    [{ api: { ...api, restart: true } }, "services.api.restart"],
    [Object.fromEntries(["a", "b", "c", "d", "e"].map(name => [name, api])), "at most 4"],
  ];
  for (const [services, message] of cases) {
    await expect(load({ services })).rejects.toThrow(message);
  }
});

test("services are a project setting only", async () => {
  await expect(load({}, { services: { api } })).rejects.toThrow("services");
});
