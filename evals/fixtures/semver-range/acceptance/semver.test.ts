import { expect, test } from "bun:test";
import { SemverError, compare, maxSatisfying, minSatisfying, parse, satisfies, sort } from "../src/semver";

test("01 a version is major.minor.patch of non-negative integers without leading zeros", () => {
  expect(parse("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0, prerelease: [], build: [] });
  expect(() => parse("01.2.3")).toThrow(SemverError);
});

test("02 a leading v or = and surrounding whitespace are accepted", () => {
  expect(parse(" v1.2.3 ")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
  expect(parse("=1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
});

test("03 prerelease identifiers: letters, digits and -, numeric ones have no leading zero and parse as numbers", () => {
  expect(parse("1.2.3-alpha-1.2").prerelease).toEqual(["alpha-1", 2]);
  expect(() => parse("1.0.0-01")).toThrow(SemverError);
});

test("04 build metadata is parsed into build and ignored in comparisons", () => {
  expect(parse("1.2.3+build.5").build).toEqual(["build", "5"]);
  expect(parse("1.2.3+007").build).toEqual(["007"]);
  expect(compare("1.2.3+aaa", "1.2.3+zzz")).toBe(0);
});

test("05 an invalid version in parse or compare is SemverError invalid version", () => {
  expect(() => parse("not-a-version")).toThrow('invalid version "not-a-version"');
  expect(() => compare("not-a-version", "1.0.0")).toThrow('invalid version "not-a-version"');
});

test("06 compare orders by major, minor, patch numerically", () => {
  expect(compare("1.9.0", "1.10.0")).toBe(-1);
  expect(compare("2.0.0", "1.99.99")).toBe(1);
  expect(compare("1.2.3", "1.2.3")).toBe(0);
});

test("07 a prerelease is lower than the same release", () => {
  expect(compare("2.0.0-rc.1", "2.0.0")).toBe(-1);
  expect(compare("2.0.0", "2.0.0-rc.1")).toBe(1);
});

test("08 prerelease identifiers compare one by one, numbers before strings, shorter lower when equal", () => {
  const order = [
    "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
    "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1",
  ];
  for (let i = 0; i < order.length - 1; i++) expect(compare(order[i]!, order[i + 1]!)).toBe(-1);
});

test("09 comparators <, <=, >, >=, = and a bare version meaning =", () => {
  expect(satisfies("1.2.3", "<1.3.0")).toBe(true);
  expect(satisfies("1.3.0", "<1.3.0")).toBe(false);
  expect(satisfies("1.2.3", "<=1.2.3")).toBe(true);
  expect(satisfies("1.2.4", "<=1.2.3")).toBe(false);
  expect(satisfies("1.2.4", ">1.2.3")).toBe(true);
  expect(satisfies("1.2.3", ">1.2.3")).toBe(false);
  expect(satisfies("1.2.3", ">=1.2.3")).toBe(true);
  expect(satisfies("1.2.2", ">=1.2.3")).toBe(false);
  expect(satisfies("1.2.3", "=1.2.3")).toBe(true);
  expect(satisfies("1.2.4", "=1.2.3")).toBe(false);
  expect(satisfies("1.2.3", "1.2.3")).toBe(true);
  expect(satisfies("1.2.4", "1.2.3")).toBe(false);
});

test("10 [D] != excludes exactly that version", () => {
  expect(satisfies("1.2.3", "!=1.2.3")).toBe(false);
  expect(satisfies("1.2.4", "!=1.2.3")).toBe(true);
});

test("11 whitespace between an operator and its version is allowed", () => {
  expect(satisfies("1.2.3", ">= 1.2.3")).toBe(true);
  expect(satisfies("1.2.2", ">= 1.2.3")).toBe(false);
});

test("12 space-separated comparators must all hold, || separates alternatives", () => {
  expect(satisfies("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
  expect(satisfies("2.5.0", ">=1.0.0 <2.0.0")).toBe(false);
  expect(satisfies("2.5.0", ">=1.0.0 <2.0.0 || >=2.5.0 <3.0.0")).toBe(true);
});

test("13 *, x, X and an empty range match any release", () => {
  expect(satisfies("9.9.9", "*")).toBe(true);
  expect(satisfies("9.9.9", "x")).toBe(true);
  expect(satisfies("9.9.9", "X")).toBe(true);
  expect(satisfies("9.9.9", "")).toBe(true);
});

test("14 1.x, 1.2.*, 1 and 1.2 are x-ranges", () => {
  expect(satisfies("1.5.0", "1.x")).toBe(true);
  expect(satisfies("2.0.0", "1.x")).toBe(false);
  expect(satisfies("1.2.9", "1.2.*")).toBe(true);
  expect(satisfies("1.3.0", "1.2.*")).toBe(false);
  expect(satisfies("1.9.9", "1")).toBe(true);
  expect(satisfies("1.2.5", "1.2")).toBe(true);
  expect(satisfies("1.3.0", "1.2")).toBe(false);
});

test("15 partial versions after operators expand to the stated bounds", () => {
  expect(satisfies("1.3.0", ">1.2")).toBe(true);
  expect(satisfies("1.2.9", ">1.2")).toBe(false);
  expect(satisfies("1.2.0", ">=1.2")).toBe(true);
  expect(satisfies("1.1.9", ">=1.2")).toBe(false);
  expect(satisfies("1.1.9", "<1.2")).toBe(true);
  expect(satisfies("1.2.0", "<1.2")).toBe(false);
  expect(satisfies("1.2.9", "<=1.2")).toBe(true);
  expect(satisfies("1.3.0", "<=1.2")).toBe(false);
});

test("16 a hyphen range includes both ends", () => {
  expect(satisfies("1.2.3", "1.2.3 - 2.3.4")).toBe(true);
  expect(satisfies("2.3.4", "1.2.3 - 2.3.4")).toBe(true);
  expect(satisfies("2.3.5", "1.2.3 - 2.3.4")).toBe(false);
});

test("17 a partial hyphen-range right end is an x-range bound, a partial left end is zero-filled", () => {
  expect(satisfies("2.3.9", "1.2 - 2.3")).toBe(true);
  expect(satisfies("2.4.0", "1.2 - 2.3")).toBe(false);
  expect(satisfies("1.1.9", "1.2 - 2.3")).toBe(false);
});

test("18 tilde: ~1.2.3 is >=1.2.3 <1.3.0, ~1.2 is <1.3.0, ~1 is <2.0.0", () => {
  expect(satisfies("1.2.3", "~1.2.3")).toBe(true);
  expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
  expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
  expect(satisfies("1.2.9", "~1.2")).toBe(true);
  expect(satisfies("1.3.0", "~1.2")).toBe(false);
  expect(satisfies("1.9.9", "~1")).toBe(true);
  expect(satisfies("2.0.0", "~1")).toBe(false);
});

test("19 caret: ^1.2.3 is >=1.2.3 <2.0.0", () => {
  expect(satisfies("1.2.3", "^1.2.3")).toBe(true);
  expect(satisfies("1.9.9", "^1.2.3")).toBe(true);
  expect(satisfies("2.0.0", "^1.2.3")).toBe(false);
  expect(satisfies("1.2.2", "^1.2.3")).toBe(false);
});

test("20 [D] caret never pins the minor or patch below 1.0.0", () => {
  expect(satisfies("0.9.9", "^0.2.3")).toBe(true);
  expect(satisfies("1.0.0", "^0.2.3")).toBe(false);
  expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
  expect(satisfies("0.9.9", "^0.0.3")).toBe(true);
  expect(satisfies("1.0.0", "^0.0.3")).toBe(false);
});

test("21 a prerelease satisfies only via a same-triple prerelease comparator", () => {
  expect(satisfies("1.2.4-beta", ">=1.2.3")).toBe(false);
  expect(satisfies("1.2.3-beta.2", ">=1.2.3-beta.1")).toBe(true);
});

test("22 includePrerelease: true drops the prerelease rule", () => {
  expect(satisfies("1.2.4-beta", ">=1.2.3", { includePrerelease: true })).toBe(true);
  expect(satisfies("1.2.2-beta", ">=1.2.3", { includePrerelease: true })).toBe(false);
});

test("23 an invalid range is SemverError invalid range, an empty side of || is invalid", () => {
  expect(() => satisfies("1.2.3", "not a range")).toThrow(SemverError);
  expect(() => satisfies("1.2.3", "1.2.3 || ")).toThrow('invalid range "1.2.3 || "');
});

test("24 [D] satisfies returns false for an invalid version instead of throwing", () => {
  expect(satisfies("not-a-version", ">=1.0.0")).toBe(false);
});

test("25 maxSatisfying returns the highest satisfying version as given, or null", () => {
  expect(maxSatisfying(["1.2.3", "1.5.0", "2.0.0"], "<2.0.0")).toBe("1.5.0");
  expect(maxSatisfying(["1.0.0", "1.1.0"], ">5.0.0")).toBeNull();
});

test("26 minSatisfying returns the lowest satisfying version, or null", () => {
  expect(minSatisfying(["1.2.3", "1.5.0", "2.0.0"], ">=1.0.0")).toBe("1.2.3");
  expect(minSatisfying(["1.0.0", "1.1.0"], ">5.0.0")).toBeNull();
});

test("27 [D] maxSatisfying and minSatisfying skip invalid versions in the list", () => {
  expect(maxSatisfying(["not-a-version", "1.2.3", "also-bad"], ">=1.0.0")).toBe("1.2.3");
  expect(minSatisfying(["not-a-version", "1.2.3", "also-bad"], ">=1.0.0")).toBe("1.2.3");
});

test("28 sort returns a new ascending list and does not change its input", () => {
  const input = ["1.5.0", "1.2.3", "2.0.0"];
  const result = sort(input);
  expect(result).toEqual(["1.2.3", "1.5.0", "2.0.0"]);
  expect(input).toEqual(["1.5.0", "1.2.3", "2.0.0"]);
});

test("29 sort keeps the input order of versions that compare equal", () => {
  expect(sort(["v1.2.3", "1.0.0", "1.2.3"])).toEqual(["1.0.0", "v1.2.3", "1.2.3"]);
});

test("30 [D] sort puts invalid versions last, in their input order", () => {
  expect(sort(["bad2", "1.0.0", "bad1"])).toEqual(["1.0.0", "bad2", "bad1"]);
});
