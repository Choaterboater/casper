import { afterEach, expect, test } from "bun:test";
import { getSystemSummary } from "../src/system";
import { startMockSwitch } from "./mock-switch";

let stop: (() => void) | undefined;
afterEach(() => stop?.());

test("reads the system summary through one session", async () => {
  const mock = startMockSwitch();
  stop = mock.stop;
  expect(await getSystemSummary({ baseUrl: mock.baseUrl, username: "admin", password: "lab-password" }))
    .toEqual({ hostname: "lab-sw1", firmware: "FL.10.13.1000", interfaceCount: 3 });
  expect(mock.stats).toMatchObject({ logins: 1, logouts: 1 });
  expect(mock.openSessions()).toBe(0);
});
