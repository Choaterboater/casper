import { expect, test } from "bun:test";
import { Router } from "../src/router";

test("a static route matches", () => {
  const router = new Router();
  router.add("GET", "/health", "health");
  expect(router.match("GET", "/health")).toEqual({ status: 200, route: "/health", name: "health", params: {} });
});

test("/users/:id gives params.id", () => {
  const router = new Router();
  router.add("GET", "/users/:id", "show-user");
  expect(router.match("GET", "/users/42")).toEqual({ status: 200, route: "/users/:id", name: "show-user", params: { id: "42" } });
});

test("an unknown path is 404", () => {
  const router = new Router();
  router.add("GET", "/health", "health");
  expect(router.match("GET", "/nope")).toEqual({ status: 404 });
});
