import { expect, test } from "bun:test";
import { createApp } from "../src/app";

const url = (path: string) => `http://docs.example.com${path}`;
type App = ReturnType<typeof createApp>;
const get = (app: App, headers: Record<string, string> = {}, id = 1) => app.handle(new Request(url(`/docs/${id}`), { headers }));
const put = (app: App, body: unknown, headers: Record<string, string> = {}, id = 1) => app.handle(new Request(url(`/docs/${id}`), {
  method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
}));
const etagOf = async (app: App) => (await get(app)).headers.get("etag")!;
const bodyOf = async (app: App) => (await (await get(app)).json() as { body: string }).body;

test("the ETag is strong, quoted, stable for the same representation and changes with the content", async () => {
  const app = createApp();
  const first = await etagOf(app);
  expect(first).toMatch(/^"[^"]+"$/);
  expect(await etagOf(app)).toBe(first);
  expect(await etagOf(createApp())).toBe(first);
  const updated = await put(app, { body: "changed" }, { "if-match": first });
  expect(updated.status).toBe(200);
  const second = updated.headers.get("etag");
  expect(second).toMatch(/^"[^"]+"$/);
  expect(second).not.toBe(first);
  expect(await etagOf(app)).toBe(second!);
  // Back to the original content: back to the original tag.
  await put(app, { body: "Welcome" }, { "if-match": second! });
  expect(await etagOf(app)).toBe(first);
});

test("If-None-Match with the current tag is 304 with no body and the ETag", async () => {
  const app = createApp();
  const etag = await etagOf(app);
  const response = await get(app, { "if-none-match": etag });
  expect(response.status).toBe(304);
  expect(await response.text()).toBe("");
  expect(response.headers.get("etag")).toBe(etag);
});

test("If-None-Match uses weak comparison, accepts lists and *, and a non-match is a normal 200", async () => {
  const app = createApp();
  const etag = await etagOf(app);
  expect((await get(app, { "if-none-match": `W/${etag}` })).status).toBe(304);
  expect((await get(app, { "if-none-match": `"nope", ${etag}` })).status).toBe(304);
  expect((await get(app, { "if-none-match": "*" })).status).toBe(304);
  const miss = await get(app, { "if-none-match": `"nope", W/"other"` });
  expect(miss.status).toBe(200);
  expect(await miss.json()).toEqual({ id: 1, body: "Welcome" });
});

test("PUT with a stale If-Match is 412 precondition_failed and writes nothing", async () => {
  const app = createApp();
  const response = await put(app, { body: "lost update" }, { "if-match": `"stale"` });
  expect(response.status).toBe(412);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error: "precondition_failed" });
  expect(await bodyOf(app)).toBe("Welcome");
});

test("If-Match uses strong comparison: a weak tag never matches, even the current one", async () => {
  const app = createApp();
  const etag = await etagOf(app);
  expect((await put(app, { body: "x" }, { "if-match": `W/${etag}` })).status).toBe(412);
  expect(await bodyOf(app)).toBe("Welcome");
});

test("If-Match accepts a list and *", async () => {
  const app = createApp();
  const etag = await etagOf(app);
  expect((await put(app, { body: "listed" }, { "if-match": `"other", ${etag}` })).status).toBe(200);
  expect((await put(app, { body: "star" }, { "if-match": "*" })).status).toBe(200);
  expect(await bodyOf(app)).toBe("star");
});

test("PUT without If-Match is 428 precondition_required and writes nothing", async () => {
  const app = createApp();
  const response = await put(app, { body: "blind write" });
  expect(response.status).toBe(428);
  expect(await response.json()).toEqual({ error: "precondition_required" });
  expect(await bodyOf(app)).toBe("Welcome");
});

test("an unknown document is 404 not_found before any precondition", async () => {
  const app = createApp();
  expect((await put(app, { body: "x" }, {}, 9)).status).toBe(404);
  expect((await put(app, { body: "x" }, { "if-match": "*" }, 9)).status).toBe(404);
  expect((await get(app, { "if-none-match": "*" }, 9)).status).toBe(404);
});
