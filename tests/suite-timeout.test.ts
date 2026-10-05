import { expect, test } from "bun:test";

// Files that drive real git, apps and child processes can pass 5 s under load (a parallel run, a busy CI runner).
// tests/support/preload.ts raises the default for every test file, however the suite is started.
test("a test may run past bun's 5 s default without being cut off", async () => {
  const started = performance.now();
  await Bun.sleep(5_200);
  expect(performance.now() - started).toBeGreaterThan(5_000);
});
