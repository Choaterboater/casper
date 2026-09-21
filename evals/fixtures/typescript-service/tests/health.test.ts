import { expect, test } from "bun:test";
import { router } from "../src/app";

test("GET /health reports ok", () => {
  expect(router({ method: "GET", path: "/health" })).toEqual({ status: 200, body: { status: "ok" } });
});
