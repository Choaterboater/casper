import { afterAll, expect, test } from "bun:test";
import { exportInventory } from "../src/export";

const devices = Array.from({ length: 7 }, (_, index) => ({
  serial: `Q2BB-000${7 - index}-0000`, name: `ap-${7 - index}`, model: "MR36", networkId: "N_2",
  mac: `02:00:5e:41:00:0${7 - index}`, lanIp: `198.51.100.${10 + index}`, tags: ["idf2"], productType: "wireless",
}));
devices[2] = { ...devices[2]!, name: 'Lobby, "main"', tags: ["a", "b"] };
devices[4] = { ...devices[4]!, name: "line1\nline2", lanIp: null as unknown as string, tags: null as unknown as string[] };
const { mac: _mac, ...withoutMac } = devices[5]!;
devices[5] = withoutMac as typeof devices[number];

const log: { path: string; auth: string | null }[] = [];
let throttle = 0;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  const url = new URL(request.url);
  log.push({ path: url.pathname + url.search, auth: request.headers.get("authorization") });
  if (url.pathname !== "/api/v1/organizations/org-9/devices") return new Response("[]", { status: 404 });
  const perPage = Number(url.searchParams.get("perPage"));
  const after = url.searchParams.get("startingAfter");
  if (after === "Q2BB-0003-0000" && throttle < 2) {
    throttle++;
    return new Response(JSON.stringify({ errors: ["Too many requests"] }), { status: 429, headers: { "retry-after": String(throttle) } });
  }
  const sorted = [...devices].sort((a, b) => a.serial.localeCompare(b.serial));
  const start = after ? sorted.findIndex((device) => device.serial === after) + 1 : 0;
  const page = sorted.slice(start, start + perPage);
  const body = [...page].reverse();
  const origin = `http://127.0.0.1:${server.port}/api/v1/organizations/org-9/devices?perPage=${perPage}`;
  const links = [`<${origin}>; rel=first`];
  if (start + perPage < sorted.length) links.push(`<${origin}&startingAfter=${page.at(-1)!.serial}>; rel="next"`);
  links.push(`<${origin}&endingBefore=zzzz>; rel=last`);
  return Response.json(body, { headers: { link: links.join(", ") } });
} });
afterAll(() => server.stop(true));
const baseUrl = () => `http://127.0.0.1:${server.port}/api/v1`;

test("follows Link rel=next across pages, retries 429 after Retry-After, and writes sorted RFC 4180 CSV", async () => {
  log.length = 0; throttle = 0;
  const sleeps: number[] = [];
  const csv = await exportInventory({ baseUrl: baseUrl(), apiKey: "k-123", orgId: "org-9", perPage: 3, sleep: async (ms) => { sleeps.push(ms); } } as Parameters<typeof exportInventory>[0]);
  expect(sleeps).toEqual([1000, 2000]);
  expect(log.map((entry) => entry.path)).toEqual([
    "/api/v1/organizations/org-9/devices?perPage=3",
    "/api/v1/organizations/org-9/devices?perPage=3&startingAfter=Q2BB-0003-0000",
    "/api/v1/organizations/org-9/devices?perPage=3&startingAfter=Q2BB-0003-0000",
    "/api/v1/organizations/org-9/devices?perPage=3&startingAfter=Q2BB-0003-0000",
    "/api/v1/organizations/org-9/devices?perPage=3&startingAfter=Q2BB-0006-0000",
  ]);
  expect(new Set(log.map((entry) => entry.auth))).toEqual(new Set(["Bearer k-123"]));
  const lines = csv.split("\n");
  expect(lines[0]).toBe("serial,name,model,networkId,mac,lanIp,tags");
  expect(csv.endsWith("\n")).toBe(true);
  expect(csv).toContain('Q2BB-0005-0000,"Lobby, ""main""",MR36,N_2,02:00:5e:41:00:05,198.51.100.12,a b\n');
  expect(csv).toContain('Q2BB-0003-0000,"line1\nline2",MR36,N_2,02:00:5e:41:00:03,,\n');
  expect(csv).toContain("Q2BB-0002-0000,ap-2,MR36,N_2,,198.51.100.15,idf2\n");
  const serials = [...csv.matchAll(/^(Q2BB-\d{4}-0000),/gm)].map((match) => match[1]);
  expect(serials).toEqual(["Q2BB-0001-0000", "Q2BB-0002-0000", "Q2BB-0003-0000", "Q2BB-0004-0000", "Q2BB-0005-0000", "Q2BB-0006-0000", "Q2BB-0007-0000"]);
  expect(csv).not.toContain("wireless");
});

test("rel=next is found among other rels and in either quoting; no next means done", async () => {
  const pages = new Map<string, Response>();
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("perPage=1000")) {
      return Response.json([{ serial: "S2" }], { headers: { link: '<https://api.example.com/p?x=1>; rel=prev, <https://api.example.com/p?cursor=abc,def>; rel=next' } });
    }
    return Response.json([{ serial: "S1", tags: [] }]);
  }) as typeof fetch;
  const csv = await exportInventory({ baseUrl: "https://api.example.com/api/v1/", apiKey: "k", orgId: "o", fetch: fetcher } as Parameters<typeof exportInventory>[0]);
  expect(calls).toEqual(["https://api.example.com/api/v1/organizations/o/devices?perPage=1000", "https://api.example.com/p?cursor=abc,def"]);
  expect(csv).toBe("serial,name,model,networkId,mac,lanIp,tags\nS1,,,,,,\nS2,,,,,,\n");
  void pages;
});

test("a persistent 429 gives up with an error after 5 retries instead of looping forever", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response("", { status: 429, headers: { "retry-after": "0" } }); }) as unknown as typeof fetch;
  await expect(exportInventory({ baseUrl: "https://api.example.com/api/v1", apiKey: "k", orgId: "o", fetch: fetcher, sleep: async () => {} } as Parameters<typeof exportInventory>[0])).rejects.toThrow();
  expect(calls).toBe(6);
});

test("other HTTP errors fail the export with the status in the message", async () => {
  for (const status of [401, 404, 500]) {
    const fetcher = (async () => new Response("", { status })) as unknown as typeof fetch;
    await expect(exportInventory({ baseUrl: "https://api.example.com/api/v1", apiKey: "k", orgId: "o", fetch: fetcher, sleep: async () => {} } as Parameters<typeof exportInventory>[0])).rejects.toThrow(String(status));
  }
});

test("an empty organization is just the header", async () => {
  const fetcher = (async () => Response.json([])) as unknown as typeof fetch;
  expect(await exportInventory({ baseUrl: "https://api.example.com/api/v1", apiKey: "k", orgId: "o", fetch: fetcher })).toBe("serial,name,model,networkId,mac,lanIp,tags\n");
});
