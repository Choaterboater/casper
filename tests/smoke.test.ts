import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { loadConfiguration } from "../src/config/load";
import { matchSmoke, parseSmokeCheck } from "../src/services/smoke";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });

async function load(project: unknown, global?: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-smoke-config-"));
  roots.push(root);
  const homeDir = path.join(root, "home"), projectRoot = path.join(root, "repo");
  await mkdir(path.join(homeDir, ".casper"), { recursive: true });
  await mkdir(path.join(projectRoot, ".casper"), { recursive: true });
  await writeFile(path.join(projectRoot, ".casper/project.yaml"), stringify(project));
  if (global !== undefined) await writeFile(path.join(homeDir, ".casper/config.yaml"), stringify(global));
  return loadConfiguration({ projectRoot, homeDir });
}

const services = { api: { command: "bun run dev", ready: { http: "/health" } } };
const check = { name: "list notes", service: "api", request: { method: "GET", path: "/notes" }, expect: { status: 200 } };

test("configured smoke checks parse with the declared services, and the section is not an unknown key", async () => {
  const full = { name: "create", service: "api", request: { method: "post", path: "/notes?x=1", headers: { "x-test": "1" }, body: { title: "a" } },
    expect: { status: 201, headers: { "content-type": "json" }, json: { title: "a" }, bodyMatches: "\"id\":\\s*\\d+" } };
  const loaded = await load({ services, smoke: [check, full] });
  expect(loaded.warnings).toEqual([]);
  expect(loaded.smoke).toEqual([check, { ...full, request: { ...full.request, method: "POST" } }]);
  expect((await load({ services })).smoke).toEqual([]);
});

test("invalid smoke values are rejected with their dotted path", async () => {
  const cases: Array<[unknown, string]> = [
    [{ name: "x" }, "smoke must be a list"],
    [["x"], "smoke[0] must be a mapping"],
    [[{ ...check, extra: 1 }], "smoke[0].extra is not a smoke check setting"],
    [[{ ...check, name: "" }], "smoke[0].name"],
    [[{ ...check, service: "web" }], "smoke[0].service must name a declared service"],
    [[{ ...check, request: undefined }], "smoke[0].request"],
    [[{ ...check, request: { method: "TRACE", path: "/" } }], "smoke[0].request.method"],
    [[{ ...check, request: { method: "GET", path: "notes" } }], "smoke[0].request.path"],
    [[{ ...check, request: { method: "GET", path: "http://example.com/" } }], "smoke[0].request.path"],
    [[{ ...check, request: { method: "GET", path: "/", headers: { a: 1 } } }], "smoke[0].request.headers.a"],
    [[{ ...check, request: { method: "GET", path: "/", verb: "x" } }], "smoke[0].request.verb"],
    [[{ ...check, expect: {} }], "smoke[0].expect needs at least one of"],
    [[{ ...check, expect: { status: 99 } }], "smoke[0].expect.status"],
    [[{ ...check, expect: { status: "200" } }], "smoke[0].expect.status"],
    [[{ ...check, expect: { headers: { etag: 1 } } }], "smoke[0].expect.headers.etag"],
    [[{ ...check, expect: { bodyMatches: "(" } }], "smoke[0].expect.bodyMatches"],
    [[{ ...check, expect: { code: 200 } }], "smoke[0].expect.code"],
    [[{ ...check, request: { method: "POST", path: "/", body: "x".repeat(5000) } }], "smoke[0] is larger than 4 KiB"],
    [[check, { ...check, name: "list notes" }], "smoke[1].name repeats"],
    [Array.from({ length: 9 }, (_, index) => ({ ...check, name: `c${index}` })), "at most 8"],
  ];
  for (const [smoke, message] of cases) await expect(load({ services, smoke })).rejects.toThrow(message);
  await expect(load({ services }, { smoke: [check] })).rejects.toThrow("smoke is a project setting");
});

test("a model-recorded check is validated the same way, against the services Casper knows", () => {
  expect(parseSmokeCheck(check, "check", ["api"])).toEqual(check);
  expect(() => parseSmokeCheck({ ...check, service: "adhoc-1" }, "check", ["api"])).toThrow("check.service must name a declared service");
  expect(parseSmokeCheck({ ...check, service: "adhoc-1" }, "check", ["api", "adhoc-1"]).service).toBe("adhoc-1");
});

test("matching: status, header substrings, deep JSON subsets and a body pattern must all hold", async () => {
  const response = { status: 201, headers: new Headers({ "content-type": "application/json; charset=utf-8", etag: "W/1" }),
    body: JSON.stringify({ id: 7, title: "a", tags: ["x", "y"], items: [{ id: 1, done: true }, { id: 2, done: false }] }) };
  const pass = async (expectation: object) => expect({ expectation, ...await matchSmoke(expectation, response) }).toMatchObject({ pass: true });
  const fail = async (expectation: object, reason: string) => {
    const result = await matchSmoke(expectation, response);
    expect({ expectation, pass: result.pass }).toEqual({ expectation, pass: false });
    expect(result.reason).toContain(reason);
  };
  await pass({ status: 201 });
  await pass({ headers: { "Content-Type": "APPLICATION/JSON" } });
  await pass({ json: { title: "a" } });
  await pass({ json: { tags: ["y"], items: [{ done: false }] } });
  await pass({ bodyMatches: "\"id\":7" });
  await pass({ status: 201, json: { id: 7 }, bodyMatches: "title" });
  await fail({ status: 200 }, "status 201, expected 200");
  await fail({ headers: { etag: "W/2" } }, "etag");
  await fail({ headers: { location: "/" } }, "location");
  await fail({ json: { id: "7" } }, "json");
  await fail({ json: { tags: ["z"] } }, "json");
  await fail({ json: { missing: null } }, "json");
  await fail({ bodyMatches: "^nope" }, "body does not match");
  expect(await matchSmoke({ json: { id: 7 } }, { ...response, body: "not json" })).toMatchObject({ pass: false, reason: expect.stringContaining("not JSON") });
});

test("a catastrophically backtracking bodyMatches is cut off instead of hanging Casper", async () => {
  const began = performance.now();
  // Polynomial backtracking: minutes on 8000 characters if nothing cuts it off (JSC's own backtrack limit
  // stops exponential patterns such as (a+)+$ after about half a second, but not this).
  const result = await matchSmoke({ bodyMatches: "a*a*a*b" }, { status: 200, headers: new Headers(), body: "a".repeat(8000) });
  expect(performance.now() - began).toBeLessThan(2000);
  expect(result.pass).toBe(false);
  expect(result.reason).toContain("took too long");
});

test("a JSON expectation on a body cut at 64 KiB says the body was truncated, not that it is not JSON", async () => {
  const body = JSON.stringify({ items: Array.from({ length: 10 }, (_, id) => ({ id })) }).slice(0, 20);
  const result = await matchSmoke({ json: { items: [] } }, { status: 200, headers: new Headers(), body, complete: false });
  expect(result).toEqual({ pass: false, reason: expect.stringContaining("body over 64 KiB was truncated") });
});

test("a header mismatch quotes at most 1024 characters of the actual value", async () => {
  const result = await matchSmoke({ headers: { "x-long": "wanted" } }, { status: 200, headers: new Headers({ "x-long": "v".repeat(8000) }), body: "" });
  expect(result.pass).toBe(false);
  expect(result.reason!.length).toBeLessThan(1200);
  expect(result.reason).toContain("x-long");
});
