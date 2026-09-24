import { afterAll, expect, test } from "bun:test";
import { formatPlan } from "../src/format";
import { planSync } from "../src/plan";

const netboxDevices = [
  { id: 1, name: "core-1", serial: "CORE0001", site: { slug: "hq" }, role: { slug: "core" }, primary_ip4: { address: "192.0.2.1/24" } },
  { id: 2, name: "dist-1", serial: "DIST0001", site: { slug: "hq" }, role: { slug: "distribution" }, primary_ip4: null },
  { id: 3, name: "access-1", serial: "", site: { slug: "hq" }, device_role: { slug: "access" }, primary_ip4: { address: "192.0.2.21/24" } },
  { id: 4, name: "access-2", serial: "ACC0002", site: { slug: "branch-1" }, device_role: { slug: "access" }, primary_ip4: null },
  { id: 5, name: "legacy-3", serial: "LEG3", site: { slug: "hq" }, role: { slug: "access" }, primary_ip4: null },
  { id: 6, name: "access-3", serial: "ACC0003", site: { slug: "hq" }, role: { slug: "access" }, primary_ip4: { address: "198.51.100.3/24" } },
  { id: 7, name: null, serial: "UNNAMED", site: { slug: "hq" }, role: { slug: "access" }, primary_ip4: null },
];
const methods: string[] = [];
const auth = new Set<string | null>();
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  methods.push(request.method);
  auth.add(request.headers.get("authorization"));
  if (request.method !== "GET") return new Response("writes are forbidden in a dry run", { status: 405 });
  const url = new URL(request.url);
  if (url.pathname !== "/api/dcim/devices/") return new Response("", { status: 404 });
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 3);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const next = offset + limit < netboxDevices.length ? `http://127.0.0.1:${server.port}/api/dcim/devices/?limit=${limit}&offset=${offset + limit}` : null;
  return Response.json({ count: netboxDevices.length, next, previous: null, results: netboxDevices.slice(offset, offset + limit) });
} });
afterAll(() => server.stop(true));

const source = [
  { name: "dist-1", serial: "DIST0001", site: "hq", role: "distribution", primaryIp4: "192.0.2.2/24" },
  { name: "core-1", serial: "CORE0001", site: "hq", role: "core", primaryIp4: "192.0.2.1/24" },
  { name: "access-1", serial: "ACC0001", site: "hq", role: "access", primaryIp4: "192.0.2.21/24" },
  { name: "access-2", serial: "ACC0002", site: "hq", role: "access", primaryIp4: "" },
  { name: "access-3", serial: "ACC0003", site: "hq", role: "access", primaryIp4: "198.51.100.3/24" },
  { name: "new-ap-1", serial: "AP0001", site: "hq", role: "wireless", primaryIp4: null },
  { name: "edge-9", serial: "EDGE9", site: "branch-1", role: "access", primaryIp4: null },
];
const options = () => ({ baseUrl: `http://127.0.0.1:${server.port}/`, token: "0123456789abcdef", source });

test("reads every page and builds the plan across all fields, including device_role servers", async () => {
  methods.length = 0;
  const plan = await planSync(options());
  expect(plan).toEqual({
    create: [
      { name: "edge-9", serial: "EDGE9", site: "branch-1", role: "access", primaryIp4: null },
      { name: "new-ap-1", serial: "AP0001", site: "hq", role: "wireless", primaryIp4: null },
    ],
    update: [
      { name: "access-1", id: 3, changes: { serial: { from: null, to: "ACC0001" } } },
      { name: "access-2", id: 4, changes: { site: { from: "branch-1", to: "hq" } } },
      { name: "dist-1", id: 2, changes: { primaryIp4: { from: null, to: "192.0.2.2/24" } } },
    ],
    unchanged: ["access-3", "core-1"],
    onlyInNetbox: ["legacy-3"],
  });
});

test("the dry run only ever sends authenticated GETs", async () => {
  methods.length = 0;
  auth.clear();
  await planSync(options());
  expect(methods.length).toBeGreaterThanOrEqual(3);
  expect(new Set(methods)).toEqual(new Set(["GET"]));
  expect([...auth]).toEqual(["Token 0123456789abcdef"]);
});

test("the printed plan matches the plan", async () => {
  expect(formatPlan(await planSync(options()))).toBe([
    "+ create edge-9 (site branch-1, role access)",
    "+ create new-ap-1 (site hq, role wireless)",
    "~ update access-1: serial - -> ACC0001",
    "~ update access-2: site branch-1 -> hq",
    "~ update dist-1: primaryIp4 - -> 192.0.2.2/24",
    "? only in NetBox: legacy-3",
    "Plan: 2 to create, 3 to update, 2 unchanged, 1 only in NetBox. Dry run: no changes made.",
    "",
  ].join("\n"));
});

test("duplicate source names are rejected before any request", async () => {
  methods.length = 0;
  await expect(planSync({ ...options(), source: [source[0]!, source[0]!] })).rejects.toThrow();
  expect(methods).toEqual([]);
});

test("an API error fails the plan instead of planning against partial data", async () => {
  const fetcher = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
  await expect(planSync({ ...options(), fetch: fetcher } as Parameters<typeof planSync>[0])).rejects.toThrow("403");
});
