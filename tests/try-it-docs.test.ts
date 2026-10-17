import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FULL_HELP_TEXT } from "../src/tui/help";

const doc = (file: string) => readFileSync(path.join(import.meta.dir, "..", file), "utf8");

test("verification docs describe one completion observation, not a suite or behavioral proof", () => {
  const text = doc("docs/VERIFICATION.md").split("## Try it before done\n")[1]!.split("## Smoke checks")[0]!;
  for (const claim of ["both `auto` and `offer`", "Docs-only, tests-only and unchanged tasks start nothing", "one local GET", "expects HTTP 2xx", "at most 15 s", "at most 10 s", "not behavioral proof", "App smoke: not run (off)"])
    expect(text).toContain(claim);
  expect(FULL_HELP_TEXT).toContain("app/server/page changes get one runtime smoke in auto or offer mode");
});

test("verification docs explain the one GET to a preserved service, without a second fixed-port copy", () => {
  const text = doc("docs/VERIFICATION.md");
  expect(text).toContain("instead of launching a second copy, even on a fixed port");
  expect(text).toContain("`existing service left running`");
  expect(text).toContain("does not prove the running service reloaded your edits");
});

test("service and JSON docs name automatic task cleanup and the structured smoke result", () => {
  expect(doc("docs/SERVICES.md")).toContain("stops before that task's final receipt");
  const text = doc("docs/SCRIPTING.md");
  for (const field of ["`appSmoke`", "`status`", "`cleanup`", "`reused: true`", "`not-run`", "unconfirmed cleanup makes the task incomplete"])
    expect(text).toContain(field);
});
