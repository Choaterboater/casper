import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServiceSpec } from "../src/services/config";
import { ServiceManager } from "../src/services/manager";
import { removeTempDir } from "./support/temp-dir";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const SERVER = path.join(import.meta.dir, "fixtures", "service-server.ts");
const spec = (extra: Partial<ServiceSpec> = {}): ServiceSpec => ({ command: `"${process.execPath}" "${SERVER}"`, port: "auto", ready: { http: "/health" }, timeoutMs: 10_000, ...extra });

async function manager(services: Record<string, ServiceSpec> = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-slot-")));
  cleanups.push(() => removeTempDir(root));
  const services_ = new ServiceManager({ projectRoot: root, services });
  cleanups.push(() => services_.close().catch(() => {}));
  return services_;
}

test("ensureSlot adds an idle detected slot without starting it, and is idempotent", async () => {
  const m = await manager();
  expect(m.ensureSlot("web", spec())).toMatchObject({ name: "web", state: "idle", stale: false });
  expect(m.ensureSlot("web", spec())).toMatchObject({ name: "web", state: "idle" });
  expect(m.names()).toEqual(["web"]);
  expect(m.live()).toBe(false);
});

test("a declared service of the same name is never replaced by a detected one", async () => {
  const declared = spec({ ready: { http: "/" } });
  const m = await manager({ web: declared });
  expect(m.ensureSlot("web", spec({ command: "vite --port $PORT" })).command).toBe(declared.command);
});

test("a detected slot whose command changed takes the new spec and a running one goes stale", async () => {
  const m = await manager();
  m.ensureSlot("web", spec());
  await m.start("web", new AbortController().signal);
  const changed = m.ensureSlot("web", spec({ env: { MODE: "dev" } }));
  expect(changed).toMatchObject({ state: "ready", stale: true });
  expect(await m.ensureFresh("web", new AbortController().signal)).toEqual({ restarted: true });
}, 30_000);

test("detected slots count toward the service cap; bad names are refused", async () => {
  const m = await manager({ a: spec(), b: spec(), c: spec(), d: spec() });
  expect(() => m.ensureSlot("web", spec())).toThrow("At most 4 services");
  const open = await manager();
  expect(() => open.ensureSlot("adhoc-1", spec())).toThrow("not a service name");
  expect(() => open.ensureSlot("1web", spec())).toThrow("not a service name");
  await open.close();
  expect(() => open.ensureSlot("web", spec())).toThrow("stopped");
});
