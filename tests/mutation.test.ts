import { expect, test } from "bun:test";
import { mutantsOf, sample } from "../src/verify/mutation";

test("mutants touch expressions only: operators, rounding, booleans, 0/1, negation and throws, never types or strings", () => {
  const source = [
    "type Pair = Array<number>;",
    "export function wait(tokens: number, rate: number): number {",
    "  if (!(rate > 0)) throw new RangeError(\"rate\");",
    "  return Math.ceil((1 - tokens) / rate) + \"<\".length;",
    "}",
  ].join("\n");
  const mutants = mutantsOf("src/limiter.ts", source).map(({ line, original, replacement }) => [line, original, replacement]);
  expect(mutants).toEqual([
    [3, "!(rate > 0)", "(rate > 0)"],
    [3, ">", ">="],
    [3, "0", "1"],
    [3, "throw new RangeError(\"rate\");", ";"],
    [4, "+", "-"],
    [4, "ceil", "floor"],
    [4, "/", "*"],
    [4, "-", "+"],
    [4, "1", "0"],
  ]);
});

test("a string concatenation is not sign-swapped", () => {
  expect(mutantsOf("a.js", "const s = \"a\" + name;")).toEqual([]);
});

test("sampling keeps every mutant under the limit and spreads evenly over a longer list", () => {
  expect(sample([1, 2, 3], 5)).toEqual([1, 2, 3]);
  expect(sample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 2, 5, 7]);
});
