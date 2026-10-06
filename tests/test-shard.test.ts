import { expect, test } from "bun:test";
import { shardFiles, suiteFiles } from "../tools/test-shard";

test("every suite file lands in exactly one shard, and the slow files are spread out", () => {
  const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts", "tests/e.test.ts", "tests/new.test.ts"];
  const timings = { "tests/a.test.ts": 900, "tests/b.test.ts": 800, "tests/c.test.ts": 100, "tests/d.test.ts": 100, "tests/e.test.ts": 50 };
  const shards = [1, 2, 3].map((index) => shardFiles(files, timings, 3, index));
  expect(shards.flat().sort()).toEqual([...files].sort());
  // The two slowest files never share a shard.
  expect(shards.find((shard) => shard.includes("tests/a.test.ts"))).not.toContain("tests/b.test.ts");
  // A file with no timing yet (a new test) still runs somewhere.
  expect(shards.flat()).toContain("tests/new.test.ts");
});

test("the suite list leaves out what `bun run test` leaves out", async () => {
  const files = await suiteFiles();
  expect(files.length).toBeGreaterThan(100);
  expect(files.some((file) => /tests\/eval-/.test(file))).toBe(false);
  expect(files).not.toContain("tests/phase10-debugger-real.test.ts");
  expect(files).toContain("tests/test-shard.test.ts");
});

test("a shard number outside 1..count is refused", () => {
  expect(() => shardFiles(["tests/a.test.ts"], {}, 3, 0)).toThrow();
  expect(() => shardFiles(["tests/a.test.ts"], {}, 3, 4)).toThrow();
});
