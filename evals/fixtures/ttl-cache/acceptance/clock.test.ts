import { expect, test } from "bun:test";
import { TtlCache } from "../src/cache";

function clock(start = 5_000) {
  let time = start;
  return { now: () => time, advance: (ms: number) => { time += ms; } };
}

test("the cache reads time only from the injected clock", () => {
  const time = clock();
  const cache = new TtlCache<number>({ ttlMs: 50, now: time.now } as ConstructorParameters<typeof TtlCache<number>>[0]);
  cache.set("k", 1);
  time.advance(49);
  expect(cache.get("k")).toBe(1);
  time.advance(1);
  expect(cache.get("k")).toBeUndefined();
});

test("the boundary is exact: expired at set time + ttl, alive one millisecond before", () => {
  const time = clock(0);
  const cache = new TtlCache<string>({ ttlMs: 1, now: time.now } as ConstructorParameters<typeof TtlCache<string>>[0]);
  cache.set("k", "v");
  expect(cache.get("k")).toBe("v");
  time.advance(1);
  expect(cache.get("k")).toBeUndefined();
});

test("size counts only live entries under a fake clock", () => {
  const time = clock();
  const cache = new TtlCache<number>({ ttlMs: 10, now: time.now } as ConstructorParameters<typeof TtlCache<number>>[0]);
  cache.set("a", 1);
  time.advance(5);
  cache.set("b", 2);
  expect(cache.size).toBe(2);
  time.advance(5);
  expect(cache.size).toBe(1);
  time.advance(100);
  expect(cache.size).toBe(0);
});

test("without an injected clock it still uses Date.now", () => {
  const cache = new TtlCache<number>({ ttlMs: 60_000 });
  cache.set("a", 1);
  expect(cache.get("a")).toBe(1);
});

test("the suite's own tests pass repeatedly with the injected clock", async () => {
  const run = Bun.spawnSync([process.execPath, "test", "--rerun-each", "20", "./tests"], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const output = `${run.stdout}${run.stderr}`;
  const ran = Number(/Ran (\d+) tests?/.exec(output)?.[1] ?? 0);
  // Three original tests x 20 reruns; deleting a test cannot pass.
  expect({ exit: run.exitCode, fail: / [1-9]\d* fail/.test(output), enough: ran >= 60 }).toEqual({ exit: 0, fail: false, enough: true });
});
