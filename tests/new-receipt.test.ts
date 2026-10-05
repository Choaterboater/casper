import { expect, test } from "bun:test";
import { checkLine, formatNewProjectReceipt } from "../src/new/receipt";
import type { NewProjectResult } from "../src/new/scaffold";

const base: NewProjectResult = {
  status: "ready", exitCode: 0, dir: "/home/me/Projects/mist-aps", displayDir: "~/Projects/mist-aps", name: "mist-aps",
  template: { id: "mist-python", version: 1, kind: "Mist Python project", title: "Mist Python scripts" },
  checks: [
    { name: "lint", command: "uv run ruff check .", status: "pass", durationMs: 40 },
    { name: "test", command: "uv run pytest", status: "pass", durationMs: 900, detail: "3 tests" },
  ],
  commit: "3f2a1c0", notes: [], kept: [],
};

test("ready: line 1 is the verdict, then the checks, then what to do next", () => {
  expect(formatNewProjectReceipt(base)).toEqual([
    "Ready: ~/Projects/mist-aps · tests passed · first commit 3f2a1c0 (template mist-python v1)",
    "✓ lint passed · ✓ tests passed (3 tests)",
    "Next: tell Casper what to build, or run: casper ~/Projects/mist-aps",
  ]);
});

test("created but not ready says why on line 1 and shows the output with secrets hidden", () => {
  const lines = formatNewProjectReceipt({
    ...base, status: "created", exitCode: 1, commit: undefined, reason: "tests failed.",
    output: "E  assert token == 'x'\nAuthorization: Bearer abc123secret",
    checks: [base.checks[0]!, { ...base.checks[1]!, status: "fail", detail: undefined }],
  });
  expect(lines[0]).toBe("Created ~/Projects/mist-aps, not committed: tests failed.");
  expect(lines[1]).toBe("Output:");
  expect(lines.join("\n")).not.toContain("abc123secret");
  expect(lines).toContain("✓ lint passed · ✗ tests failed");
  expect(lines.at(-1)).toBe("Next: casper ~/Projects/mist-aps, then ask Casper to fix the failing check.");
});

test("Ready needs a commit: a passing project inside another repo is 'Created …, not committed'", () => {
  const lines = formatNewProjectReceipt({ ...base, status: "created", exitCode: 1, commit: undefined, reason: "it's inside the git repository at ~/work; commit it there when you're ready." });
  expect(lines[0]).toBe("Created ~/Projects/mist-aps, not committed: it's inside the git repository at ~/work; commit it there when you're ready.");
  expect(lines.some((line) => line.startsWith("Ready"))).toBe(false);
});

test("not created says so on line 1", () => {
  const lines = formatNewProjectReceipt({ ...base, status: "not_created", exitCode: 1, commit: undefined, checks: [], reason: "~/Projects/x already exists and isn't empty. Pick another name." });
  expect(lines).toEqual(["Not created: ~/Projects/x already exists and isn't empty. Pick another name."]);
});

test("offline notes and kept files are shown", () => {
  const lines = formatNewProjectReceipt({
    ...base, status: "created", exitCode: 1, commit: undefined, checks: [], reason: "couldn't get packages from pypi.org.",
    notes: ["Couldn't get packages from pypi.org (offline?). The folder has the template but no packages; run uv sync when you're online."],
    kept: [".gitignore"],
  });
  expect(lines).toContain("Couldn't get packages from pypi.org (offline?). The folder has the template but no packages; run uv sync when you're online.");
  expect(lines).toContain("Kept the init tool's own .gitignore.");
});

test("the receipt never says verified or secure", () => {
  const variants: NewProjectResult[] = [
    base,
    { ...base, status: "created", exitCode: 1, reason: "tests failed.", checks: [{ ...base.checks[1]!, status: "fail" }] },
    { ...base, status: "not_created", exitCode: 64, reason: "Names use lowercase letters, digits and dashes, like mist-aps." },
  ];
  for (const result of variants) {
    const text = formatNewProjectReceipt(result).join("\n").toLowerCase();
    expect(text).not.toContain("verified");
    expect(text).not.toContain("secure");
  }
  expect(checkLine([{ name: "typecheck", command: "tsc", status: "pass", durationMs: 1 }])).toBe("✓ typecheck passed");
});
