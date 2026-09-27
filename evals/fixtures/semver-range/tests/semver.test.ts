import { expect, test } from "bun:test";
import { compare, parse, satisfies } from "../src/semver";

test("parse reads major, minor and patch", () => {
  expect(parse("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
});

test("compare orders versions numerically", () => {
  expect(compare("1.2.3", "1.10.0")).toBe(-1);
});

test("satisfies checks a version against a range", () => {
  expect(satisfies("1.2.3", ">=1.0.0")).toBe(true);
});
