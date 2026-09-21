import { expect, test } from "bun:test";
import { router } from "../src/app";

test("an unknown route is a 404 with an error body", () => {
  expect(router({ method: "GET", path: "/missing" })).toEqual({ status: 404, body: { error: "not found" } });
});

test("the router matches on method and path together", () => {
  expect(router({ method: "POST", path: "/health" }).status).toBe(404);
});
