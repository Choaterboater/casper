import { expect, test } from "bun:test";

test("the notices point at the release tag of the running build, never a fixed old one", async () => {
  const notices = await Bun.file(new URL("../THIRD_PARTY_NOTICES.txt", import.meta.url)).text();
  const line = notices.split("\n").find(text => text.trim().startsWith("Casper: https://github.com/Choaterboater/casper"));
  expect(line).toBeDefined();
  expect(line).not.toMatch(/v\d+\.\d+\.\d+/);
  expect(line).toContain("casper --version");
});
