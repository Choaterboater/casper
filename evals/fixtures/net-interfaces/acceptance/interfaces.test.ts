import { expect, test } from "bun:test";
import path from "node:path";
import { parseInterfaces } from "../src/parse";

const dir = path.join(import.meta.dir, "transcripts");
const load = async (vendor: string) => ({
  text: await Bun.file(path.join(dir, `${vendor}.txt`)).text(),
  expected: await Bun.file(path.join(dir, `${vendor}.json`)).json(),
});

for (const vendor of ["iosxe", "junos", "aoscx"] as const) {
  test(`${vendor}: sub-interfaces, LAGs and a truncated capture match the model exactly`, async () => {
    const { text, expected } = await load(vendor);
    expect(parseInterfaces(vendor, text)).toEqual(expected);
  });

  test(`${vendor}: empty input has no interfaces and is not truncated`, () => {
    expect(parseInterfaces(vendor, "")).toEqual({ interfaces: [], truncated: false });
  });

  test(`${vendor}: text after the pager prompt is never parsed`, async () => {
    const { text } = await load(vendor);
    const names = parseInterfaces(vendor, text).interfaces.map((entry) => entry.name);
    expect(names.some((name) => /Vlan99|1\/1\/6|ge-0\/0\/5/.test(name))).toBe(false);
  });
}

test("junos: aenet member units are not listed; their physical ports carry the LAG", async () => {
  const { text } = await load("junos");
  const result = parseInterfaces("junos", text).interfaces;
  expect(result.map((entry) => entry.name)).not.toContain("xe-0/0/0.0");
  expect(result.find((entry) => entry.name === "ae1")!.lagMembers).toEqual(["xe-0/0/0", "xe-0/0/2"]);
});

test("junos: a disabled unit is admin down even when its parent is enabled", async () => {
  const { text } = await load("junos");
  expect(parseInterfaces("junos", text).interfaces.find((entry) => entry.name === "ae1.200")).toMatchObject({ adminUp: false, operUp: false });
});

test("iosxe: an abbreviated member missing from the capture stays as printed", async () => {
  const { text } = await load("iosxe");
  const channel = parseInterfaces("iosxe", text).interfaces.find((entry) => entry.name === "Port-channel20")!;
  expect(channel.lagMembers).toEqual(["TenGigabitEthernet1/1/1", "Te1/1/2"]);
});

test("aoscx: CRLF captures parse the same as LF", async () => {
  const { text } = await load("aoscx");
  expect(parseInterfaces("aoscx", text.replaceAll("\r\n", "\n"))).toEqual(parseInterfaces("aoscx", text));
});
