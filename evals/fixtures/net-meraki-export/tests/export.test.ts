import { expect, test } from "bun:test";
import { exportInventory } from "../src/export";

test("exports one page of devices as CSV with a header", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return Response.json([{ serial: "Q2AA-0001-0001", name: "lobby-ap", model: "MR46", networkId: "N_1", mac: "02:00:5e:40:00:01", lanIp: "192.0.2.21", tags: ["floor1"] }]);
  }) as typeof fetch;
  const csv = await exportInventory({ baseUrl: "https://dashboard.example.com/api/v1", apiKey: "test-key", orgId: "123", fetch: fetcher });
  expect(csv).toBe("serial,name,model,networkId,mac,lanIp,tags\nQ2AA-0001-0001,lobby-ap,MR46,N_1,02:00:5e:40:00:01,192.0.2.21,floor1\n");
  expect(seen).toEqual([{ url: "https://dashboard.example.com/api/v1/organizations/123/devices?perPage=1000", auth: "Bearer test-key" }]);
});
