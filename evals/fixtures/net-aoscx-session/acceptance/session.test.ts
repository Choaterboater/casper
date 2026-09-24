import { afterEach, expect, test } from "bun:test";
import { HttpError, LoginError, LogoutError } from "../src/errors";
import { withSession } from "../src/session";
import { getSystemSummary } from "../src/system";
import { startMockSwitch, type MockOptions } from "../tests/mock-switch";

let stop: (() => void) | undefined;
afterEach(() => stop?.());
function mock(options: MockOptions = {}) {
  const started = startMockSwitch(options);
  stop = started.stop;
  return { ...started, credentials: { baseUrl: started.baseUrl, username: "admin", password: "lab-password" } };
}

test("a failing GET rejects with HttpError and still logs out", async () => {
  const sw = mock({ failures: { "/system/interfaces": 500 } });
  const error = await getSystemSummary(sw.credentials).catch((failure) => failure);
  expect(error).toBeInstanceOf(HttpError);
  expect({ status: error.status, path: error.path }).toEqual({ status: 500, path: "/system/interfaces" });
  expect(sw.stats).toMatchObject({ logins: 1, logouts: 1 });
  expect(sw.openSessions()).toBe(0);
});

test("an error thrown by the caller's work is rethrown unchanged after logout", async () => {
  const sw = mock();
  const boom = new Error("work failed");
  const error = await withSession(sw.credentials, async (session) => { await session.get("/system?attributes=hostname,firmware_version"); throw boom; }).catch((failure) => failure);
  expect(error).toBe(boom);
  expect(sw.stats).toMatchObject({ logins: 1, logouts: 1 });
});

test("an unparseable response body still ends the session", async () => {
  const sw = mock({ garbled: ["/system?attributes=hostname,firmware_version"] });
  await expect(getSystemSummary(sw.credentials)).rejects.toThrow();
  expect(sw.stats).toMatchObject({ logins: 1, logouts: 1 });
  expect(sw.openSessions()).toBe(0);
});

test("a rejected login is a LoginError and sends no other request", async () => {
  const sw = mock();
  const error = await getSystemSummary({ ...sw.credentials, password: "wrong" }).catch((failure) => failure);
  expect(error).toBeInstanceOf(LoginError);
  expect(error.status).toBe(401);
  expect(sw.stats.requests).toEqual(["POST /login"]);
});

test("a failed logout after successful work rejects with LogoutError", async () => {
  const sw = mock({ logoutStatus: 500 });
  const error = await getSystemSummary(sw.credentials).catch((failure) => failure);
  expect(error).toBeInstanceOf(LogoutError);
  expect(sw.stats.logouts).toBe(1);
});

test("when work and logout both fail, the work's error wins", async () => {
  const sw = mock({ failures: { "/system/interfaces": 404 }, logoutStatus: 500 });
  const error = await getSystemSummary(sw.credentials).catch((failure) => failure);
  expect(error).toBeInstanceOf(HttpError);
  expect(error.status).toBe(404);
});

test("repeated failures never exhaust the switch's session limit", async () => {
  const sw = mock({ maxSessions: 2, failures: { "/system/interfaces": 503 } });
  for (let index = 0; index < 6; index++) await expect(getSystemSummary(sw.credentials)).rejects.toBeInstanceOf(HttpError);
  await expect(withSession(sw.credentials, async () => { throw new Error("x"); })).rejects.toThrow("x");
  expect(sw.openSessions()).toBe(0);
  expect(sw.stats.logins).toBe(7);
  expect(sw.stats.logouts).toBe(7);
  expect(await withSession(sw.credentials, (session) => session.get("/system?attributes=hostname,firmware_version")))
    .toEqual({ hostname: "lab-sw1", firmware_version: "FL.10.13.1000" });
});

test("exactly one logout per login, sent with the session cookie, as the last request", async () => {
  const sw = mock();
  await getSystemSummary(sw.credentials);
  expect(sw.stats.requests).toEqual(["POST /login", "GET /system?attributes=hostname,firmware_version", "GET /system/interfaces", "POST /logout"]);
  expect(sw.stats.logouts).toBe(1);
});

test("parallel sessions up to the limit all succeed and all close", async () => {
  const sw = mock({ maxSessions: 3 });
  const results = await Promise.all([1, 2, 3].map(() => getSystemSummary(sw.credentials)));
  expect(results.map((result) => result.interfaceCount)).toEqual([3, 3, 3]);
  expect(sw.openSessions()).toBe(0);
});
