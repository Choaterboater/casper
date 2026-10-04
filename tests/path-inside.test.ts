import { describe, expect, test } from "bun:test";
import path from "node:path";
import { isOutside } from "../src/platform/inside";
import { within } from "../src/platform/project-paths";
import { relativePath } from "../src/security/parse";

describe("inside the project", () => {
  test("only a real step up counts as outside", () => {
    expect(isOutside("..")).toBe(true);
    expect(isOutside("../x")).toBe(true);
    expect(isOutside("..\\x")).toBe(true);
    expect(isOutside(path.resolve("/elsewhere"))).toBe(true);
    expect(isOutside("..env")).toBe(false);
    expect(isOutside("..hidden/file")).toBe(false);
    expect(isOutside("src/a.ts")).toBe(false);
    expect(isOutside("")).toBe(false);
  });

  test("a file named ..env is inside the project", () => {
    const root = path.resolve("/project");
    expect(within(root, path.join(root, "..env"))).toBe(true);
    expect(within(root, path.join(root, "..config", "a"))).toBe(true);
    expect(within(root, path.resolve(root, "..", "other"))).toBe(false);
    expect(relativePath(root, "..env")).toBe("..env");
    expect(relativePath(root, "../other/x.txt")).toBe("x.txt");
  });
});
