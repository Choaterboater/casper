import { expect, test } from "bun:test";
import { RouteError, Router, type Match } from "../src/router";

function must200(result: Match): Extract<Match, { status: 200 }> {
  if (result.status !== 200) throw new Error(`expected 200, got ${JSON.stringify(result)}`);
  return result;
}
function must204(result: Match): Extract<Match, { status: 204 }> {
  if (result.status !== 204) throw new Error(`expected 204, got ${JSON.stringify(result)}`);
  return result;
}
function must405(result: Match): Extract<Match, { status: 405 }> {
  if (result.status !== 405) throw new Error(`expected 405, got ${JSON.stringify(result)}`);
  return result;
}

test("01 static segments match exactly and case-sensitively", () => {
  const router = new Router();
  router.add("GET", "/Users/Home", "home");
  expect(router.match("GET", "/Users/Home")).toEqual({ status: 200, route: "/Users/Home", name: "home", params: {} });
  expect(router.match("GET", "/users/home").status).not.toBe(200);
});

test("02 :name matches one non-empty segment into params.name", () => {
  const router = new Router();
  router.add("GET", "/users/:id", "show-user");
  expect(router.match("GET", "/users/42")).toEqual({ status: 200, route: "/users/:id", name: "show-user", params: { id: "42" } });
});

test("03 a param name must be [A-Za-z_][A-Za-z0-9_]*, else RouteError invalid param name", () => {
  expect(() => new Router().add("GET", "/a/:9bad", "x")).toThrow("invalid param name");
  expect(() => new Router().add("GET", "/a/:9bad", "x")).toThrow(RouteError);
  expect(() => new Router().add("GET", "/a/:bad-name", "x")).toThrow("invalid param name");
});

test("04 [D] :name<int> and :name<slug> constrain the segment but keep the value a string; another type is unknown", () => {
  const router = new Router();
  router.add("GET", "/n/:id<int>", "by-int");
  router.add("GET", "/s/:slug<slug>", "by-slug");
  expect(router.match("GET", "/n/042")).toEqual({ status: 200, route: "/n/:id<int>", name: "by-int", params: { id: "042" } });
  expect(router.match("GET", "/n/4a2").status).not.toBe(200);
  expect(router.match("GET", "/s/my-page-2")).toEqual({ status: 200, route: "/s/:slug<slug>", name: "by-slug", params: { slug: "my-page-2" } });
  expect(router.match("GET", "/s/My-Page").status).not.toBe(200);
  expect(() => new Router().add("GET", "/z/:id<uuid>", "z")).toThrow("unknown param type uuid");
});

test("05 :name? is optional and only allowed last; when absent it is missing from params", () => {
  const router = new Router();
  router.add("GET", "/a/:x?", "opt");
  const present = must200(router.match("GET", "/a/5"));
  expect(present.route).toBe("/a/:x?");
  expect(present.name).toBe("opt");
  expect(present.params.x).toBe("5");
  const absent = must200(router.match("GET", "/a"));
  expect(absent.route).toBe("/a/:x?");
  expect(absent.name).toBe("opt");
  expect("x" in absent.params).toBe(false);
  expect(() => new Router().add("GET", "/a/:x?/b", "bad")).toThrow("optional param must be last");
});

test("06 * or *name as the last segment captures the rest of the path, possibly empty, without a leading slash", () => {
  const router = new Router();
  router.add("GET", "/files/*", "all-files");
  router.add("GET", "/assets/*rest", "assets");
  expect(router.match("GET", "/files/a/b/c")).toEqual({ status: 200, route: "/files/*", name: "all-files", params: { "*": "a/b/c" } });
  expect(router.match("GET", "/files")).toEqual({ status: 200, route: "/files/*", name: "all-files", params: { "*": "" } });
  expect(router.match("GET", "/assets/x/y")).toEqual({ status: 200, route: "/assets/*rest", name: "assets", params: { rest: "x/y" } });
  expect(() => new Router().add("GET", "/*x/b", "bad")).toThrow("wildcard must be last");
});

test("07 a pattern must start with /, else RouteError pattern must start with /", () => {
  expect(() => new Router().add("GET", "users", "bad")).toThrow("pattern must start with /");
});

test("08 [D] precedence is decided by kind segment by segment, not registration order: static, then typed, then param, then optional, then wildcard", () => {
  const full = new Router();
  full.add("GET", "/n/*", "wildcard-route");
  full.add("GET", "/n/:x?", "optional-route");
  full.add("GET", "/n/:name", "param-route");
  full.add("GET", "/n/:id<int>", "typed-route");
  full.add("GET", "/n/42", "static-route");
  const r1 = must200(full.match("GET", "/n/42"));
  expect([r1.route, r1.name]).toEqual(["/n/42", "static-route"]);

  const noStatic = new Router();
  noStatic.add("GET", "/n/*", "wildcard-route");
  noStatic.add("GET", "/n/:x?", "optional-route");
  noStatic.add("GET", "/n/:name", "param-route");
  noStatic.add("GET", "/n/:id<int>", "typed-route");
  const r2 = must200(noStatic.match("GET", "/n/42"));
  expect([r2.route, r2.name]).toEqual(["/n/:id<int>", "typed-route"]);

  const paramOnly = new Router();
  paramOnly.add("GET", "/n/*", "wildcard-route");
  paramOnly.add("GET", "/n/:x?", "optional-route");
  paramOnly.add("GET", "/n/:name", "param-route");
  const r3 = must200(paramOnly.match("GET", "/n/42"));
  expect([r3.route, r3.name]).toEqual(["/n/:name", "param-route"]);

  const optionalOnly = new Router();
  optionalOnly.add("GET", "/n/*", "wildcard-route");
  optionalOnly.add("GET", "/n/:x?", "optional-route");
  const r4 = must200(optionalOnly.match("GET", "/n/42"));
  expect([r4.route, r4.name]).toEqual(["/n/:x?", "optional-route"]);
});

test("09 between routes of equal precedence, the one added first wins", () => {
  const router = new Router();
  router.add("GET", "/a/:y<slug>", "slug-first");
  router.add("GET", "/a/:x<int>", "int-second");
  const r = must200(router.match("GET", "/a/42"));
  expect([r.route, r.name]).toEqual(["/a/:y<slug>", "slug-first"]);
});

test("10 the same method and pattern twice, ignoring param names, is RouteError duplicate route", () => {
  const router = new Router();
  router.add("GET", "/a/:x", "first");
  expect(() => router.add("GET", "/a/:y", "second")).toThrow("duplicate route");
});

test("11 [D] a trailing slash on the request path is ignored, except the root /", () => {
  const router = new Router();
  router.add("GET", "/users", "users");
  router.add("GET", "/", "root");
  expect(router.match("GET", "/users/")).toEqual({ status: 200, route: "/users", name: "users", params: {} });
  expect(router.match("GET", "/")).toEqual({ status: 200, route: "/", name: "root", params: {} });
});

test("12 [D] repeated slashes in the request path count as one", () => {
  const router = new Router();
  router.add("GET", "/users/:id", "show-user");
  const r = must200(router.match("GET", "/users//42"));
  expect([r.route, r.name]).toEqual(["/users/:id", "show-user"]);
});

test("13 the query string and fragment are ignored", () => {
  const router = new Router();
  router.add("GET", "/search", "search");
  expect(router.match("GET", "/search?q=1#top")).toEqual({ status: 200, route: "/search", name: "search", params: {} });
});

test("14 param values are percent-decoded after matching (%20 is a space)", () => {
  const router = new Router();
  router.add("GET", "/greet/:name", "greet");
  expect(router.match("GET", "/greet/John%20Doe")).toEqual({ status: 200, route: "/greet/:name", name: "greet", params: { name: "John Doe" } });
});

test("15 an encoded slash %2F stays inside its segment and decodes to / in the param value", () => {
  const router = new Router();
  router.add("GET", "/files/:name", "one-segment");
  expect(router.match("GET", "/files/a%2Fb")).toEqual({ status: 200, route: "/files/:name", name: "one-segment", params: { name: "a/b" } });
});

test("16 static segments match their decoded form", () => {
  const router = new Router();
  router.add("GET", "/café", "cafe");
  expect(router.match("GET", "/caf%C3%A9")).toEqual({ status: 200, route: "/café", name: "cafe", params: {} });
});

test("17 invalid percent-encoding, or bytes that are not UTF-8, is status 400", () => {
  const router = new Router();
  router.add("GET", "/a/:x", "a");
  expect(router.match("GET", "/a/%zz")).toEqual({ status: 400 });
  expect(router.match("GET", "/a/%C3%28")).toEqual({ status: 400 });
});

test("18 a request path not starting with / is status 400", () => {
  const router = new Router();
  router.add("GET", "/a", "a");
  expect(router.match("GET", "a")).toEqual({ status: 400 });
});

test("19 methods are case-insensitive and stored upper-case", () => {
  const router = new Router();
  router.add("get", "/a", "a");
  expect(router.match("GET", "/a")).toEqual({ status: 200, route: "/a", name: "a", params: {} });
  expect(router.match("get", "/a")).toEqual({ status: 200, route: "/a", name: "a", params: {} });
  expect(router.list()[0]).toMatch(/^GET /);
});

test("20 [D] an ANY route matches every method, but a route for the exact method on the same pattern wins", () => {
  const router = new Router();
  router.add("ANY", "/a", "any-a");
  expect(router.match("POST", "/a")).toEqual({ status: 200, route: "/a", name: "any-a", params: {} });
  router.add("GET", "/a", "get-a");
  expect(router.match("GET", "/a")).toEqual({ status: 200, route: "/a", name: "get-a", params: {} });
  expect(router.match("POST", "/a")).toEqual({ status: 200, route: "/a", name: "any-a", params: {} });

  const grouped = new Router();
  grouped.add("ANY", "/n/:x<int>", "any-int");
  grouped.add("GET", "/n/:y<slug>", "get-slug");
  const r = must200(grouped.match("GET", "/n/5"));
  expect([r.route, r.name]).toEqual(["/n/:y<slug>", "get-slug"]);
});

test("21 HEAD uses the GET route when no HEAD route matches", () => {
  const router = new Router();
  router.add("GET", "/a", "get-a");
  expect(router.match("HEAD", "/a")).toEqual({ status: 200, route: "/a", name: "get-a", params: {} });

  const withAny = new Router();
  withAny.add("ANY", "/b", "any-b");
  withAny.add("GET", "/b", "get-b");
  expect(withAny.match("HEAD", "/b")).toEqual({ status: 200, route: "/b", name: "any-b", params: {} });
});

test("22 a path matched for another method is status 405 with allow", () => {
  const router = new Router();
  router.add("POST", "/a", "post-a");
  const r = must405(router.match("GET", "/a"));
  expect(r.allow).toContain("POST");
});

test("23 allow is sorted, includes HEAD whenever GET is allowed, and always includes OPTIONS", () => {
  const router = new Router();
  router.add("GET", "/a", "get-a");
  router.add("POST", "/a", "post-a");
  router.add("DELETE", "/a", "delete-a");
  const r = must405(router.match("PUT", "/a"));
  expect(r.allow).toEqual(["DELETE", "GET", "HEAD", "OPTIONS", "POST"]);
});

test("24 [D] OPTIONS on a matching path with no OPTIONS route is status 204 with allow", () => {
  const router = new Router();
  router.add("GET", "/a", "get-a");
  const r = must204(router.match("OPTIONS", "/a"));
  expect(r.allow).toContain("GET");
});

test("25 no route matches the path, status 404", () => {
  const router = new Router();
  router.add("GET", "/a", "get-a");
  expect(router.match("GET", "/b")).toEqual({ status: 404 });
});

test("26 a match returns route as the pattern was registered and name as given", () => {
  const router = new Router();
  router.add("GET", "/Users/:Id", "Show User");
  const r = must200(router.match("GET", "/Users/7"));
  expect([r.route, r.name]).toEqual(["/Users/:Id", "Show User"]);
});

test("27 params holds only named params, and * for an unnamed wildcard", () => {
  const router = new Router();
  router.add("GET", "/a/:x/*", "mixed");
  const r = must200(router.match("GET", "/a/5/b/c"));
  expect(Object.keys(r.params).sort()).toEqual(["*", "x"]);
});

test("28 [D] list() returns every route in precedence order, ties in the order added", () => {
  const router = new Router();
  router.add("GET", "/a/*", "wildcard-route");
  router.add("POST", "/a/:x", "param-first");
  router.add("PUT", "/a/:y", "param-second");
  router.add("DELETE", "/a/fixed", "static-route");
  expect(router.list()).toEqual(["DELETE /a/fixed", "POST /a/:x", "PUT /a/:y", "GET /a/*"]);
});

test("29 precedence applies across different lengths: /a/:x beats /a/* for /a/b, and /a/* matches /a/b/c", () => {
  const router = new Router();
  router.add("GET", "/a/*", "wildcard-route");
  router.add("GET", "/a/:x", "param-route");
  const r1 = must200(router.match("GET", "/a/b"));
  expect([r1.route, r1.name]).toEqual(["/a/:x", "param-route"]);
  const r2 = must200(router.match("GET", "/a/b/c"));
  expect([r2.route, r2.name]).toEqual(["/a/*", "wildcard-route"]);
});

test("30 a typed param that does not match falls through to the next candidate route", () => {
  const router = new Router();
  router.add("GET", "/n/:id<int>", "by-int");
  router.add("GET", "/n/:name", "by-name");
  const r = must200(router.match("GET", "/n/abc"));
  expect([r.route, r.name]).toEqual(["/n/:name", "by-name"]);
});
