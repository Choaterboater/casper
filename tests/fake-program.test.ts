import { expect, test } from "bun:test";
import { sharedLauncher } from "./support/fake-program";

test("a failed fake launcher build is shared by current consumers, not cached for later tests", async () => {
  let attempts = 0;
  const first = Promise.withResolvers<string>();
  const launcher = sharedLauncher(() => ++attempts === 1 ? first.promise : Promise.resolve("complete.exe"));
  const a = launcher(), b = launcher();
  expect(a).toBe(b);
  const observed = Promise.allSettled([a, b]);
  first.reject(new Error("compiler could not start"));
  expect(await observed).toEqual([
    { status: "rejected", reason: expect.objectContaining({ message: "compiler could not start" }) },
    { status: "rejected", reason: expect.objectContaining({ message: "compiler could not start" }) },
  ]);
  expect(await launcher()).toBe("complete.exe");
  expect(await launcher()).toBe("complete.exe");
  expect(attempts).toBe(2);
});

test("concurrent fake launcher consumers await one completed build", async () => {
  let attempts = 0;
  const compiled = Promise.withResolvers<string>();
  const launcher = sharedLauncher(() => { attempts++; return compiled.promise; });
  const a = launcher(), b = launcher();
  expect(a).toBe(b);
  expect(attempts).toBe(1);
  compiled.resolve("published.exe");
  expect(await Promise.all([a, b, launcher()])).toEqual(["published.exe", "published.exe", "published.exe"]);
  expect(attempts).toBe(1);
});
