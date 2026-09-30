import { redactPreview } from "../tui/format";
import type { NewProjectCheck, NewProjectResult } from "./scaffold";

/**
 * The `casper new` result. Line 1 is the verdict: "Ready: …", "Created …, not committed: <why>" or
 * "Not created: <why>". The checks prove the new project runs, not a change, so this never says
 * "verified" or "secure".
 */

const WORD: Record<NewProjectCheck["name"], string> = { test: "tests", lint: "lint", typecheck: "typecheck", build: "build" };

export function checkLine(checks: readonly NewProjectCheck[]): string {
  return checks.map((check) => check.status === "pass"
    ? `✓ ${WORD[check.name]} passed${check.detail ? ` (${check.detail})` : ""}`
    : `✗ ${WORD[check.name]} failed`).join(" · ");
}

function outputLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.trim()).map((line) => `  | ${redactPreview(line).slice(0, 300)}`);
}

export function formatNewProjectReceipt(result: NewProjectResult): string[] {
  const lines: string[] = [];
  const template = result.template ? `template ${result.template.id} v${result.template.version}` : "";
  if (result.status === "ready" && result.empty) {
    lines.push(`Ready: ${result.displayDir} · empty folder${result.notes.length ? "" : " · git started"} · no template`);
    lines.push(...result.notes);
    lines.push(`Next: tell Casper what to build, or run: cd ${result.displayDir} && casper`);
    return lines;
  }
  if (result.status === "ready") {
    const tested = result.checks.some((check) => check.name === "test") ? "tests passed" : "checks passed";
    lines.push(`Ready: ${result.displayDir} · ${tested} · first commit ${result.commit ?? "?"}${template ? ` (${template})` : ""}`);
    lines.push(checkLine(result.checks));
    lines.push(`Next: tell Casper what to build, or run: cd ${result.displayDir} && casper`);
    return lines;
  }
  if (result.status === "not_created") {
    lines.push(`Not created: ${result.reason ?? "something went wrong."}`);
    return lines;
  }
  lines.push(`Created ${result.displayDir}, not committed: ${result.reason ?? "something went wrong."}`);
  if (result.output) lines.push("Output:", ...outputLines(result.output));
  if (result.checks.length) lines.push(checkLine(result.checks));
  lines.push(...result.notes);
  if (result.kept.length) lines.push(`Kept the init tool's own ${result.kept.join(", ")}.`);
  if (result.checks.some((check) => check.status === "fail")) {
    lines.push(`Next: cd ${result.displayDir} && casper, then ask Casper to fix the failing check.`);
  }
  return lines;
}
