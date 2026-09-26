import { expect, test } from "bun:test";
import { createApp } from "../src/app";

const url = (path: string) => `http://docs.example.com${path}`;

test("reads a document with an ETag", async () => {
  const response = await createApp().handle(new Request(url("/docs/1")));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: 1, body: "Welcome" });
  expect(response.headers.get("etag")).toBeTruthy();
});

test("updates a document when If-Match carries its current ETag", async () => {
  const app = createApp();
  const etag = (await app.handle(new Request(url("/docs/1")))).headers.get("etag")!;
  const response = await app.handle(new Request(url("/docs/1"), {
    method: "PUT", headers: { "content-type": "application/json", "if-match": etag }, body: JSON.stringify({ body: "Hello" }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: 1, body: "Hello" });
});
