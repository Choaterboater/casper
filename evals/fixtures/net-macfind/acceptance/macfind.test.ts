import { expect, test } from "bun:test";
import path from "node:path";
import { findMac } from "../src/find";
import { loadInventory } from "../src/inventory";
import { InvalidMacError } from "../src/mac";

const dataDir = path.join(import.meta.dir, "data");
const devices = await loadInventory(dataDir);
const modules = import.meta.dir + "/../src/";
const load = async <T>(name: string): Promise<T> => await import(modules + name) as T;

test("a MAC that also passes through LAG uplinks is located on its edge port", () => {
  expect(findMac(devices, "02:00:5e:20:00:01")).toEqual({ mac: "02:00:5e:20:00:01", device: "idf2-sw1", port: "Gi1/0/12", vlan: "20" });
  expect(findMac(devices, "02:00:5e:20:00:02")).toEqual({ mac: "02:00:5e:20:00:02", device: "idf3-sw1", port: "1/1/8", vlan: "20" });
  expect(findMac(devices, "02:00:5e:20:00:10")).toEqual({ mac: "02:00:5e:20:00:10", device: "core-1", port: "ge-0/0/10", vlan: "servers" });
});

test("ports facing devices outside the inventory (phones, unmanaged switches) are edge ports", () => {
  expect(findMac(devices, "02:00:5e:20:00:20")).toMatchObject({ device: "idf2-sw1", port: "Gi1/0/3" });
  expect(findMac(devices, "02:00:5e:20:00:40")).toMatchObject({ device: "core-1", port: "ge-0/0/20" });
});

test("a MAC seen only on uplinks, or not at all, is not found", () => {
  expect(findMac(devices, "02:00:5e:20:00:30")).toBeNull();
  expect(findMac(devices, "02:00:5e:ff:ff:ff")).toBeNull();
});

test("the query MAC may be dotted, dashed or coloned in any case", () => {
  for (const form of ["0200.5E20.0001", "02-00-5E-20-00-01", "02:00:5E:20:00:01"]) {
    expect(findMac(devices, form)).toMatchObject({ mac: "02:00:5e:20:00:01", port: "Gi1/0/12" });
  }
  expect(() => findMac(devices, "02:00:5e:20:00")).toThrow(InvalidMacError);
});

test("the visible sample: a MAC learned on a plain uplink is found downstream", async () => {
  const sample = await loadInventory(path.join(import.meta.dir, "../tests/data"));
  expect(findMac(sample, "02:00:5e:10:00:99")).toEqual({ mac: "02:00:5e:10:00:99", device: "dist-1", port: "1/1/7", vlan: "10" });
});

function capture() {
  const io = { stdout: "", stderr: "", out(text: string) { io.stdout += text; }, err(text: string) { io.stderr += text; } };
  return io;
}

test("CLI: prints the location, exits 0; --json prints the location object", async () => {
  const { main } = await load<{ main(argv: string[], io: ReturnType<typeof capture>): Promise<number> }>("cli");
  const human = capture();
  expect(await main(["--data", dataDir, "0200.5e20.0002"], human)).toBe(0);
  expect(human.stdout).toBe("02:00:5e:20:00:02 is on idf3-sw1 1/1/8 (vlan 20)\n");
  const json = capture();
  expect(await main(["--json", "--data", dataDir, "02:00:5e:20:00:10"], json)).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual({ mac: "02:00:5e:20:00:10", device: "core-1", port: "ge-0/0/10", vlan: "servers" });
});

test("CLI: not found exits 1; --json prints null", async () => {
  const { main } = await load<{ main(argv: string[], io: ReturnType<typeof capture>): Promise<number> }>("cli");
  const human = capture();
  expect(await main(["--data", dataDir, "02:00:5E:20:00:30"], human)).toBe(1);
  expect(human.stdout).toBe("02:00:5e:20:00:30 not found on any edge port\n");
  const json = capture();
  expect(await main(["--data", dataDir, "--json", "02:00:5e:20:00:30"], json)).toBe(1);
  expect(JSON.parse(json.stdout)).toBeNull();
});

test("CLI: an invalid MAC, a missing --data or extra arguments are usage errors (64) on stderr", async () => {
  const { main } = await load<{ main(argv: string[], io: ReturnType<typeof capture>): Promise<number> }>("cli");
  for (const argv of [["--data", dataDir, "not-a-mac"], ["02:00:5e:20:00:01"], ["--data", dataDir], ["--data", dataDir, "02:00:5e:20:00:01", "extra"], ["--bogus", "--data", dataDir, "02:00:5e:20:00:01"]]) {
    const io = capture();
    expect(await main(argv, io)).toBe(64);
    expect(io.stdout).toBe("");
    expect(io.stderr.length).toBeGreaterThan(0);
  }
});

test("HTTP: GET /mac/<mac> returns 200 with the location, 404 not_found, 400 invalid_mac", async () => {
  const { createHandler } = await load<{ createHandler(devices: unknown): (request: Request) => Response | Promise<Response> }>("server");
  const handle = createHandler(devices);
  const get = async (pathname: string) => {
    const response = await handle(new Request(`http://macfind.example.com${pathname}`));
    expect(response.headers.get("content-type")).toContain("application/json");
    return { status: response.status, body: await response.json() };
  };
  expect(await get("/mac/0200.5e20.0001")).toEqual({ status: 200, body: { mac: "02:00:5e:20:00:01", device: "idf2-sw1", port: "Gi1/0/12", vlan: "20" } });
  expect(await get("/mac/02%3A00%3A5e%3A20%3A00%3A20")).toMatchObject({ status: 200, body: { port: "Gi1/0/3" } });
  expect(await get("/mac/02:00:5e:20:00:30")).toEqual({ status: 404, body: { error: "not_found" } });
  expect(await get("/mac/zz")).toEqual({ status: 400, body: { error: "invalid_mac" } });
});

test("HTTP: works behind a real loopback server", async () => {
  const { createHandler } = await load<{ createHandler(devices: unknown): (request: Request) => Response | Promise<Response> }>("server");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createHandler(devices) });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/mac/02-00-5e-20-00-40`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ device: "core-1", port: "ge-0/0/20", vlan: "users" });
  } finally { server.stop(true); }
});
