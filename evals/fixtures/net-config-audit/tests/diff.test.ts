import { expect, test } from "bun:test";
import path from "node:path";
import { diffConfigs } from "../src/diff";

const read = (name: string) => Bun.file(path.join(import.meta.dir, "configs", name)).text();

test("a Junos backup diff shows only the real change", async () => {
  expect(diffConfigs("junos", await read("junos-before.set"), await read("junos-after.set"))).toEqual({
    added: ["set interfaces ge-0/0/0 description wan-primary"],
    removed: ["set interfaces ge-0/0/0 description wan"],
  });
});
