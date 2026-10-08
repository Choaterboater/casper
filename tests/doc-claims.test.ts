import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { HOST_CHOICES, SHELL_COMMAND_CHOICES } from "../src/app/safe-choices";
import { PI_SANDBOX_IGNORED, SHELL_CANT_ASK } from "../src/app/sandbox";
import { PRIVATE_PATHS } from "../src/platform/project-paths";
import { describeSandbox } from "../src/sandbox/manager";
import { cachePaths, REGISTRY_HOSTS } from "../src/sandbox/policy";

/**
 * docs/SECURITY.md says what Casper enforces, and this keeps it true in both directions: every row of its
 * enforcement table names a test that exists, what the code enforces is named in the doc, and the old
 * sentences that became false once the sandbox shipped are gone from the docs and the help.
 */

const ROOT = path.resolve(import.meta.dir, "..");
const security = readFileSync(path.join(ROOT, "docs", "SECURITY.md"), "utf8");

function enforcementRows(): Array<{ claim: string; tests: Array<{ file: string; title: string }> }> {
  const section = security.slice(security.indexOf("## What Casper enforces"), security.indexOf("## What is not held back"));
  return section.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| What") && !line.startsWith("| ---")).map((line) => {
    const cells = line.split(" | ");
    const last = cells.at(-1)!.replace(/ \|$/, "");
    return { claim: cells[0]!.slice(2), tests: [...last.matchAll(/`(tests\/[^`]+)` › “([^”]+)”/g)].map((match) => ({ file: match[1]!, title: match[2]! })) };
  });
}

test("every row of SECURITY.md's enforcement table names a test file and a test that exist", () => {
  const rows = enforcementRows();
  expect(rows.length).toBeGreaterThan(20);
  const missing: string[] = [];
  for (const row of rows) {
    if (!row.tests.length) missing.push(`no test named: ${row.claim}`);
    for (const { file, title } of row.tests) {
      const full = path.join(ROOT, file);
      if (!existsSync(full)) { missing.push(`${file} does not exist`); continue; }
      const source = readFileSync(full, "utf8");
      if (!source.includes(`"${title}"`) && !source.includes(JSON.stringify(title))) missing.push(`${file} has no test "${title}"`);
    }
  }
  expect(missing).toEqual([]);
});

test("what the sandbox enforces in code is what SECURITY.md lists", () => {
  for (const entry of PRIVATE_PATHS) expect(security).toContain(`\`~/${entry}\``);
  for (const host of REGISTRY_HOSTS) expect(security).toContain(`\`${host}\``);
  for (const cache of new Set([...cachePaths("linux"), ...cachePaths("darwin")])) expect(security).toContain(`\`~/${cache}\``);
  expect(security).toContain(SHELL_CANT_ASK);
  expect(security).toContain(PI_SANDBOX_IGNORED);
  expect(security).toContain(HOST_CHOICES.map((choice, index) => `${index + 1} ${choice.label}`).join(" · "));
  expect(security).toContain(SHELL_COMMAND_CHOICES.map((choice, index) => `${index + 1} ${choice.label}`).join(" · "));
  expect(security).toContain(describeSandbox({ kind: "missing", reason: "bubblewrap and socat are missing: sudo apt install bubblewrap socat" }).split(" · ")[0]!);
  expect(security).toContain(describeSandbox({ kind: "on" }, 11));
});

/** Sentences that were true before the sandbox and are false now. */
const STALE = [
  "trusted projects only",
  "use only in trusted projects",
  "Native coding tools can read/write files and run shell",
  "Casper is **not a sandbox",
  "not a sandbox yet",
  "until the shell sandbox ships",
  "Not enforced until the shell sandbox ships",
  "not sandboxed yet",
  "None of the new checks is sandboxed",
  "Verified by Casper",
  "no OS sandbox or universal shell approval gate",
  "Pi's native shell/filesystem tools are not sandboxed",
];

function userDocs(): Array<{ file: string; text: string }> {
  const docs = readdirSync(path.join(ROOT, "docs")).filter((name) => name.endsWith(".md")).map((name) => path.join("docs", name));
  const files = ["README.md", ...docs, "src/tui/help.ts", "src/app/commands.ts", "src/security/format.ts"];
  return files.map((file) => {
    let text = readFileSync(path.join(ROOT, file), "utf8");
    // Release notes of earlier versions say what was true then; only the notes being written are checked.
    if (file === path.join("docs", "RELEASE.md")) text = text.slice(0, text.indexOf("## v0.2.16"));
    return { file, text };
  });
}

test("no doc, help text or command still says the shell or checks are unsandboxed without saying when", () => {
  const found: string[] = [];
  for (const { file, text } of userDocs()) {
    for (const phrase of STALE) if (text.includes(phrase)) found.push(`${file}: ${phrase}`);
    // "not sandboxed" about shell commands or checks is only true with a condition beside it.
    for (const sentence of text.split(/(?<=[.!?])\s+|\n\n/)) {
      if (!/not sandboxed|isn't sandboxed|is not a sandbox|not in the sandbox/i.test(sentence)) continue;
      if (!/shell|check|service|dev server/i.test(sentence)) continue;
      if (/without|no sandbox|--no-sandbox|sandbox: off|Windows|missing|bubblewrap|MCP|language server|debugger|browser|lab check|when|until you|here \(|could not start|\$\{/i.test(sentence)) continue;
      found.push(`${file}: ${sentence.trim().slice(0, 160)}`);
    }
  }
  expect(found).toEqual([]);
});

/** Lines only `/mcp detail` prints since `/mcp` became one line per server (the list cuts a failure reason
 * short and drops "(checked)" from login access). */
const MCP_DETAIL_ONLY = [
  "transport", "source file", "time limits", "limits: start", "preset:", "Remembered:", "Changed since you approved it",
  "(checked)", "Last lines from the server", "what it said", "says why",
];

test("MCP.md and SECURITY.md give the lines only /mcp detail prints to /mcp detail, not to the one-line /mcp", () => {
  const found: string[] = [];
  for (const file of ["MCP.md", "SECURITY.md"]) {
    // A full stop inside a quoted line (`... approved it. Run ...`) doesn't end the sentence around it.
    const text = readFileSync(path.join(ROOT, "docs", file), "utf8").replace(/`[^`\n]*`/g, (code) => code.replace(/[.!?]/g, "․"));
    for (const sentence of text.split(/(?<=[.!?])\s+|\n\n|\n\s*- |\n(?=\|)/)) {
      if (!sentence.includes("`/mcp`") || sentence.includes("`/mcp detail")) continue;
      for (const line of MCP_DETAIL_ONLY) if (sentence.includes(line)) found.push(`docs/${file}: ${line}: ${sentence.trim().slice(0, 160)}`);
    }
  }
  expect(found).toEqual([]);
});

test("TERMINAL_UX.md describes the queue and steer instead of saying there is no queued prompt execution", () => {
  const terminal = readFileSync(path.join(ROOT, "docs", "TERMINAL_UX.md"), "utf8");
  const compatibility = terminal.slice(terminal.indexOf("## Compatibility"), terminal.indexOf("## Design references"));
  expect(compatibility).not.toMatch(/queued prompt execution/i);
  expect(compatibility).toMatch(/steers the\s+AI at its next step/);
  expect(compatibility).toMatch(/runs when the task ends/);
});
