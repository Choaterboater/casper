import { expect, test } from "bun:test";
import { batches, CycleError, MissingDependencyError, schedule } from "../src/schedule";

function thrown(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("expected an error");
}

test("when several tasks are ready, the smallest name goes first", () => {
  expect(schedule({ c: [], a: ["c"], b: [], d: ["b"] })).toEqual(["b", "c", "a", "d"]);
  expect(schedule({ zeta: [], alpha: [], mid: ["zeta"] })).toEqual(["alpha", "zeta", "mid"]);
});

test("names compare by plain string order, not locale order", () => {
  expect(schedule({ b: [], B: [], a: [], _x: [] })).toEqual(["B", "_x", "a", "b"]);
});

test("a dependency listed twice is one dependency", () => {
  expect(schedule({ a: ["b", "b"], b: [] })).toEqual(["b", "a"]);
  expect(batches({ a: ["b", "b"], b: [] })).toEqual([["b"], ["a"]]);
});

test("batches: each task in the first batch after all its dependencies, each batch sorted", () => {
  expect(batches({ app: ["lib", "assets"], lib: ["core"], core: [], assets: [], docs: [] }))
    .toEqual([["assets", "core", "docs"], ["lib"], ["app"]]);
  expect(batches({})).toEqual([]);
  expect(schedule({})).toEqual([]);
});

test("a missing dependency names the task and the dependency, first by sorted task name then listed order", () => {
  const error = thrown(() => schedule({ z: ["nope"], b: ["a", "ghost", "phantom"], a: [] }));
  expect(error).toBeInstanceOf(MissingDependencyError);
  expect({ task: (error as MissingDependencyError).task, dependency: (error as MissingDependencyError).dependency, message: (error as Error).message })
    .toEqual({ task: "b", dependency: "ghost", message: "b depends on unknown task ghost" });
  expect(thrown(() => batches({ a: ["x"] }))).toBeInstanceOf(MissingDependencyError);
});

test("a missing dependency is reported even when the graph also has a cycle", () => {
  expect(thrown(() => schedule({ a: ["b"], b: ["a"], c: ["missing"] }))).toBeInstanceOf(MissingDependencyError);
});

test("a cycle error gives the path from the smallest task on the cycle, following dependencies", () => {
  const error = thrown(() => schedule({ c: ["a"], b: ["c"], a: ["b"], start: ["a"] }));
  expect(error).toBeInstanceOf(CycleError);
  expect((error as CycleError).cycle).toEqual(["a", "b", "c", "a"]);
  expect((error as Error).message).toBe("cycle: a -> b -> c -> a");
});

test("a task that depends on itself is a cycle", () => {
  const error = thrown(() => batches({ ok: [], self: ["self"] }));
  expect(error).toBeInstanceOf(CycleError);
  expect((error as CycleError).cycle).toEqual(["self", "self"]);
});

test("with several cycles, the one through the smallest task on any cycle is reported", () => {
  const error = thrown(() => schedule({ x: ["y"], y: ["x"], m: ["n"], n: ["m"], a: ["m"] }));
  expect((error as CycleError).cycle).toEqual(["m", "n", "m"]);
});

test("a task that only depends on a cycle is not itself reported as the cycle", () => {
  const error = thrown(() => schedule({ a: ["q"], q: ["r"], r: ["q"] }));
  expect((error as CycleError).cycle).toEqual(["q", "r", "q"]);
});
