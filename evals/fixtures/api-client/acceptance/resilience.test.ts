import { expect, test } from "bun:test";
import * as api from "../src";
import { createClient, HttpError } from "../src";

const TimeoutError = (api as Record<string, unknown>).TimeoutError as new (...args: never[]) => Error;
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function harness(handler: Handler, extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const client = createClient({
    baseUrl: "https://api.example.com/v1/",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => { calls.push(String(input)); return handler(String(input), init); }) as typeof fetch,
    sleep: async (ms: number) => { sleeps.push(ms); },
    ...extra,
  } as Parameters<typeof createClient>[0]);
  return { client: client as typeof client & { listAll<T>(path: string): Promise<T[]> }, calls, sleeps };
}
const page = (items: unknown[], next: string | null) => Response.json({ items, next });

test("listAll follows next links (relative and absolute) and concatenates items in order", async () => {
  const { client, calls } = harness((url) => {
    if (url.endsWith("/v1/devices")) return page([1, 2], "devices?cursor=b");
    if (url.endsWith("cursor=b")) return page([3], "https://api.example.com/v1/devices?cursor=c");
    return page([4, 5], null);
  });
  expect(await client.listAll("devices")).toEqual([1, 2, 3, 4, 5]);
  expect(calls).toEqual([
    "https://api.example.com/v1/devices",
    "https://api.example.com/v1/devices?cursor=b",
    "https://api.example.com/v1/devices?cursor=c",
  ]);
});

test("an empty first page returns an empty list", async () => {
  const { client } = harness(() => page([], null));
  expect(await client.listAll("devices")).toEqual([]);
});

test("a next link that repeats a page is an error, not an infinite loop", async () => {
  const { client, calls } = harness(() => page([1], "devices"));
  await expect(client.listAll("devices")).rejects.toThrow();
  expect(calls.length).toBeLessThanOrEqual(3);
});

test("429 waits for Retry-After seconds, then succeeds", async () => {
  let count = 0;
  const { client, sleeps } = harness(() => ++count === 1 ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : Response.json({ ok: 1 }));
  expect(await client.get("x")).toEqual({ ok: 1 });
  expect(sleeps).toEqual([2000]);
});

test("429 inside pagination retries the same page, not the first one", async () => {
  let throttled = false;
  const { client, calls } = harness((url) => {
    if (url.endsWith("/v1/devices")) return page(["a"], "devices?cursor=2");
    if (!throttled) { throttled = true; return new Response("", { status: 429, headers: { "retry-after": "0" } }); }
    return page(["b"], null);
  });
  expect(await client.listAll("devices")).toEqual(["a", "b"]);
  expect(calls).toEqual([
    "https://api.example.com/v1/devices", "https://api.example.com/v1/devices?cursor=2", "https://api.example.com/v1/devices?cursor=2",
  ]);
});

test("5xx responses back off 100, 200, 400 ms, then succeed", async () => {
  let count = 0;
  const { client, sleeps } = harness(() => ++count <= 3 ? new Response("", { status: 503 }) : Response.json({ ok: 1 }));
  expect(await client.get("x")).toEqual({ ok: 1 });
  expect(sleeps).toEqual([100, 200, 400]);
});

test("429 without Retry-After uses the same backoff", async () => {
  let count = 0;
  const { client, sleeps } = harness(() => ++count <= 2 ? new Response("", { status: 429 }) : Response.json({ ok: 1 }));
  await client.get("x");
  expect(sleeps).toEqual([100, 200]);
});

test("after maxRetries (default 3) the last status is thrown as HttpError", async () => {
  const { client, calls } = harness(() => new Response("", { status: 502 }));
  const error = await client.get("x").catch((failure) => failure);
  expect(error).toBeInstanceOf(HttpError);
  expect(error.status).toBe(502);
  expect(calls).toHaveLength(4);
});

test("maxRetries is configurable", async () => {
  const { client, calls } = harness(() => new Response("", { status: 500 }), { maxRetries: 1 });
  await expect(client.get("x")).rejects.toBeInstanceOf(HttpError);
  expect(calls).toHaveLength(2);
});

test("non-retryable 4xx responses fail immediately without sleeping", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const { client, calls, sleeps } = harness(() => new Response("", { status }));
    const error = await client.get("x").catch((failure) => failure);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(status);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  }
});

test("a network error is retried like a 5xx", async () => {
  let count = 0;
  const { client, sleeps } = harness(() => { if (++count === 1) throw new TypeError("connection reset"); return Response.json({ ok: 1 }); });
  expect(await client.get("x")).toEqual({ ok: 1 });
  expect(sleeps).toEqual([100]);
});

test("a request slower than timeoutMs rejects with TimeoutError and aborts the fetch", async () => {
  expect(typeof TimeoutError).toBe("function");
  let aborted = false;
  const { client, calls } = harness((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); });
  }), { timeoutMs: 50 });
  const started = performance.now();
  const error = await client.get("slow").catch((failure) => failure);
  expect(error).toBeInstanceOf(TimeoutError);
  expect(error.name).toBe("TimeoutError");
  expect(aborted).toBe(true);
  expect(calls).toHaveLength(1);
  expect(performance.now() - started).toBeLessThan(1000);
});

test("works against a real loopback server with Retry-After", async () => {
  let count = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
    const url = new URL(request.url);
    if (++count === 1) return new Response("", { status: 429, headers: { "retry-after": "0" } });
    return url.searchParams.get("cursor") ? Response.json({ items: [2], next: null }) : Response.json({ items: [1], next: "/items?cursor=2" });
  } });
  try {
    const client = createClient({ baseUrl: `http://127.0.0.1:${server.port}/`, sleep: async () => {} } as Parameters<typeof createClient>[0]) as ReturnType<typeof createClient> & { listAll<T>(path: string): Promise<T[]> };
    expect(await client.listAll("items")).toEqual([1, 2]);
  } finally { server.stop(true); }
});
