import { expect, test } from "bun:test";
import { createClient, HttpError } from "../src";

const fake = (handler: (url: string, init?: RequestInit) => Response) =>
  (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;

test("get resolves against the base URL and sends the bearer token", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const client = createClient({
    baseUrl: "https://api.example.com/v1/", token: "t0k",
    fetch: fake((url, init) => { seen.push({ url, auth: new Headers(init?.headers).get("authorization") }); return Response.json({ ok: true }); }),
  });
  expect(await client.get("status")).toEqual({ ok: true });
  expect(seen).toEqual([{ url: "https://api.example.com/v1/status", auth: "Bearer t0k" }]);
});

test("a 404 is an HttpError with the status", async () => {
  const client = createClient({ baseUrl: "https://api.example.com/", fetch: fake(() => new Response("", { status: 404 })) });
  const error = await client.get("missing").catch((failure) => failure);
  expect(error).toBeInstanceOf(HttpError);
  expect(error.status).toBe(404);
});
