import { expect, test } from "bun:test";
import { ghCanVerifyBuild, parseGhVersion } from "../src/update/gh-version";

test("gh's version is read from its first line and only 2.56.0 or newer can check Casper's build", () => {
  expect(parseGhVersion("gh version 2.55.0 (2024-08-01)\nhttps://github.com/cli/cli/releases/tag/v2.55.0\n")).toEqual([2, 55, 0]);
  expect(parseGhVersion("gh version 2.100.12")).toEqual([2, 100, 12]);
  for (const text of ["", "nonsense", "gh version 2.56", "gh version 2.56.0-rc1", "gh version 2.56.0.1", "gh version x.y.z", "gh version 9999999.1.1"]) expect(parseGhVersion(text)).toBeUndefined();
  const can = (version: string) => ghCanVerifyBuild(`gh version ${version} (2026-01-01)`);
  for (const version of ["2.56.0", "2.56.1", "2.57.0", "2.100.0", "3.0.0", "10.0.0"]) expect({ version, can: can(version) }).toEqual({ version, can: true });
  for (const version of ["2.45.0", "2.47.0", "2.48.0", "2.55.0", "2.55.99", "2.9.0", "1.99.99", "0.0.0"]) expect({ version, can: can(version) }).toEqual({ version, can: false });
  expect(ghCanVerifyBuild("")).toBe(false);
  expect(ghCanVerifyBuild("something unexpected")).toBe(false);
});
