import { expect, test } from "bun:test";
import path from "node:path";
import { parseInterfaces } from "../src/parse";

for (const vendor of ["iosxe", "junos", "aoscx"] as const) {
  test(`${vendor} sample parses to its expected model`, async () => {
    const dir = path.join(import.meta.dir, "samples");
    const text = await Bun.file(path.join(dir, `${vendor}.txt`)).text();
    const expected = await Bun.file(path.join(dir, `${vendor}.json`)).json();
    expect(parseInterfaces(vendor, text)).toEqual(expected);
  });
}
