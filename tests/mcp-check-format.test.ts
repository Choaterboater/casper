import { expect, test } from "bun:test";
import { checkExitCode, countFindings, type CheckReport, type Finding } from "../src/mcp/check/index";
import { checkReportJson, formatCheckReport } from "../src/mcp/check/format";

const findings: Finding[] = [
  { section: "examples", status: "ok", label: ".mcp.json.example", text: "keeps writes off" },
  { section: "repo", status: "ok", label: "doctor", text: "uv run hpe-mcp-doctor (12 s) · Summary: 0 fail, 3 warn, 41 ok" },
  { section: "repo", status: "warn", label: "safety tests", text: "No safety tests found." },
  { section: "server", status: "fail", label: "stdout", text: "Server wrote plain text to stdout: \"\x1b[31mred\x1b[0m\"" },
  { section: "server", status: "note", label: "label", text: "get_junos_config looks read-only: add readOnlyHint: true." },
];

function report(offline = true): CheckReport {
  return { target: { name: "junos-mcp-server", path: "/src/junos-mcp-server" }, offline, findings, ...countFindings(findings), exitCode: checkExitCode(findings, false) };
}

test("the report groups findings by section in a fixed order, aligned, with escaped server text", () => {
  expect(formatCheckReport(report())).toBe([
    "Checking junos-mcp-server (/src/junos-mcp-server)",
    "Offline: no tool calls. Credentials removed, web proxy blocked. Use --live to allow read calls.",
    "Offline is best effort: a program that reads its own .env or opens SSH itself can still reach the network.",
    "Repo checks",
    "  ok    doctor        uv run hpe-mcp-doctor (12 s) · Summary: 0 fail, 3 warn, 41 ok",
    "  warn  safety tests  No safety tests found.",
    "Server",
    "  fail  stdout        Server wrote plain text to stdout: \"red\"",
    "  note  label         get_junos_config looks read-only: add readOnlyHint: true.",
    "Example configs",
    "  ok    .mcp.json.example  keeps writes off",
    "Result: 1 problem, 1 warning, 1 note",
    "Exit codes: 0 no problems, 1 problems (or warnings with --strict), 64 usage mistake",
    "",
  ].join("\n"));
  expect(formatCheckReport(report(false), { header: false }).startsWith("Repo checks\n")).toBe(true);
  expect(formatCheckReport(report(false))).toContain("Live: read-only calls to your real systems are allowed. Write tools are never called.");
});

test("exit code: problems give 1; warnings give 1 only with --strict", () => {
  const warnOnly: Finding[] = [{ section: "repo", status: "warn", label: "x", text: "y" }, { section: "repo", status: "note", label: "x", text: "y" }];
  expect(checkExitCode(warnOnly, false)).toBe(0);
  expect(checkExitCode(warnOnly, true)).toBe(1);
  expect(checkExitCode([{ section: "repo", status: "fail", label: "x", text: "y" }], false)).toBe(1);
  expect(checkReportJson(report())).toMatchObject({ version: 1, problems: 1, warnings: 1, notes: 1, exitCode: 1 });
});
