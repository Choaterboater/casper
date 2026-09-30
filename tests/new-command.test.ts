import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { UsageError } from "../src/cli-args";
import { listLines, NEW_USAGE, parseNewArgs, runNewCommand } from "../src/new/command";
import { listTemplates } from "../src/new/templates";
import { makeNewFakes, type NewFakes } from "./support/new-fakes";
import { posixOnly } from "./support/platform";

setDefaultTimeout(30_000);

let fakes: NewFakes | undefined;
afterEach(async () => { await fakes?.cleanup(); fakes = undefined; });

test("parseNewArgs: only the exact forms are the command; anything else stays a prompt", () => {
  expect(parseNewArgs([])).toEqual({ list: false });
  expect(parseNewArgs(["mist-aps"])).toEqual({ name: "mist-aps", list: false });
  expect(parseNewArgs(["python-cli", "mist-aps"])).toEqual({ template: "python-cli", name: "mist-aps", list: false });
  expect(parseNewArgs(["--list"])).toEqual({ list: true });
  expect(parseNewArgs(["ideas", "for", "the", "app"])).toBeNull();
  expect(parseNewArgs(["cool", "thing"])).toBeNull();
});

test("parseNewArgs: a bad name or a stray option is a usage mistake", () => {
  expect(() => parseNewArgs(["../x"])).toThrow(new UsageError("Names use lowercase letters, digits and dashes, like mist-aps."));
  expect(() => parseNewArgs(["python-cli", "Bad_Name"])).toThrow(UsageError);
  expect(() => parseNewArgs(["--json"])).toThrow(`new takes no other options. ${NEW_USAGE}`);
});

test("--list prints one plain line per ready template", async () => {
  const lines: string[] = [];
  const { exitCode } = await runNewCommand({ command: { list: true }, write: (line) => lines.push(line) });
  expect(exitCode).toBe(0);
  expect(lines).toEqual(listLines());
  expect(lines).toHaveLength(listTemplates().length);
  expect(lines[0]).toStartWith("python-cli     Python tool (command line). ");
});

test("without a terminal it needs a template and a name (exit 64)", async () => {
  const lines: string[] = [];
  const { exitCode } = await runNewCommand({ command: { name: "x", list: false }, write: (line) => lines.push(line) });
  expect(exitCode).toBe(64);
  expect(lines[0]).toBe(`casper new needs a template and a name when it can't ask. ${NEW_USAGE}`);
});

posixOnly("creates ~/Projects/<name>, prints progress and the receipt, and exits 0 when ready", async () => {
  fakes = await makeNewFakes();
  const lines: string[] = [];
  const { exitCode } = await runNewCommand({
    command: { template: "python-cli", name: "demo", list: false },
    write: (line) => lines.push(line), env: fakes.env(), homeDir: fakes.home,
  });
  expect(exitCode).toBe(0);
  expect(lines[0]).toBe("Starting ~/Projects/demo from template python-cli");
  expect(lines).toContain("  uv init …");
  expect(lines.find((line) => line.startsWith("Ready: ~/Projects/demo · tests passed · first commit "))).toBeDefined();
  expect(lines.at(-1)).toBe("Next: tell Casper what to build, or run: cd ~/Projects/demo && casper");
});

posixOnly("creates ~/Projects when it is missing, and exits 1 when tests fail", async () => {
  fakes = await makeNewFakes();
  const home = path.join(fakes.root, "fresh-home");
  const lines: string[] = [];
  const { exitCode } = await runNewCommand({
    command: { template: "python-cli", name: "red", list: false },
    write: (line) => lines.push(line), env: fakes.env({ HOME: home, FAKE_TEST_FAIL: "1" }), homeDir: home,
  });
  expect((await lstat(path.join(home, "Projects"))).isDirectory()).toBe(true);
  expect(exitCode).toBe(1);
  expect(lines).toContain("Created ~/Projects/red, not committed: tests failed.");
});
