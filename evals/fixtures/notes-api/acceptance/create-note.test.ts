import { expect, test } from "bun:test";
import { createApp } from "../src/app";

const post = (app: ReturnType<typeof createApp>, body: string, type = "application/json") =>
  app.handle(new Request("http://notes.example.com/notes", { method: "POST", headers: { "content-type": type }, body }));

async function errorOf(response: Response) {
  expect(response.headers.get("content-type")).toContain("application/json");
  return await response.json() as { error: string; fields?: Record<string, string> };
}

test("creates a note with 201, a Location header and trimmed title", async () => {
  const app = createApp();
  const response = await post(app, JSON.stringify({ title: "  Plan  ", body: "details", tags: ["work", "q3"] }));
  expect(response.status).toBe(201);
  expect(response.headers.get("location")).toBe("/notes/1");
  expect(await response.json()).toEqual({ id: 1, title: "Plan", body: "details", tags: ["work", "q3"] });
  expect(await (await app.handle(new Request("http://notes.example.com/notes/1"))).json()).toMatchObject({ title: "Plan" });
});

test("body and tags are optional and default to empty", async () => {
  const response = await post(createApp(), JSON.stringify({ title: "Only title" }));
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: 1, title: "Only title", body: "", tags: [] });
});

test("ids keep increasing after seeded notes", async () => {
  const response = await post(createApp([{ title: "a", body: "", tags: [] }]), JSON.stringify({ title: "b" }));
  expect((await response.json() as { id: number }).id).toBe(2);
});

test("malformed JSON is 400 invalid_json", async () => {
  const response = await post(createApp(), "{ nope");
  expect(response.status).toBe(400);
  expect(await errorOf(response)).toEqual({ error: "invalid_json" });
});

test("a non-JSON content type is 415", async () => {
  const response = await post(createApp(), "title=x", "application/x-www-form-urlencoded");
  expect(response.status).toBe(415);
  expect(await errorOf(response)).toEqual({ error: "unsupported_media_type" });
});

test.each([
  [{}, ["title"]],
  [{ title: "   " }, ["title"]],
  [{ title: "x".repeat(101) }, ["title"]],
  [{ title: 5 }, ["title"]],
  [{ title: "ok", body: 3 }, ["body"]],
  [{ title: "ok", body: "x".repeat(1001) }, ["body"]],
  [{ title: "ok", tags: "a" }, ["tags"]],
  [{ title: "ok", tags: ["a", "b", "c", "d", "e", "f"] }, ["tags"]],
  [{ title: "ok", tags: ["Upper"] }, ["tags"]],
  [{ title: "ok", tags: ["dup", "dup"] }, ["tags"]],
  [{ title: "ok", tags: [""] }, ["tags"]],
  [{ title: "ok", color: "red" }, ["color"]],
  [{ body: 1, extra: true }, ["body", "extra", "title"]],
])("rejects %j with 422 naming %j", async (input, names) => {
  const app = createApp();
  const response = await post(app, JSON.stringify(input));
  expect(response.status).toBe(422);
  const error = await errorOf(response);
  expect(error.error).toBe("validation_failed");
  expect(Object.keys(error.fields ?? {}).sort()).toEqual(names);
  for (const message of Object.values(error.fields ?? {})) expect(typeof message).toBe("string");
  expect(await (await app.handle(new Request("http://notes.example.com/notes"))).json()).toEqual({ notes: [] });
});

test("a JSON array or scalar body is a validation error, not a crash", async () => {
  for (const body of ["[]", "42", "null"]) {
    const response = await post(createApp(), body);
    expect(response.status).toBe(422);
    expect((await errorOf(response)).error).toBe("validation_failed");
  }
});

test("other methods on /notes are 405", async () => {
  const response = await createApp().handle(new Request("http://notes.example.com/notes", { method: "DELETE" }));
  expect(response.status).toBe(405);
  expect(await errorOf(response)).toEqual({ error: "method_not_allowed" });
});
