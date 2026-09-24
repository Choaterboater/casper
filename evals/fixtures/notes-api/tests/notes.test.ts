import { expect, test } from "bun:test";
import { createApp } from "../src/app";

const seed = [{ title: "First", body: "hello", tags: ["intro"] }];
const get = (app: ReturnType<typeof createApp>, path: string) => app.handle(new Request(`http://notes.example.com${path}`));

test("lists seeded notes", async () => {
  const response = await get(createApp(seed), "/notes");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ notes: [{ id: 1, title: "First", body: "hello", tags: ["intro"] }] });
});

test("reads one note and reports unknown ids", async () => {
  const app = createApp(seed);
  expect(await (await get(app, "/notes/1")).json()).toMatchObject({ id: 1, title: "First" });
  const missing = await get(app, "/notes/9");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "not_found" });
  expect((await get(app, "/notes/abc")).status).toBe(400);
});
