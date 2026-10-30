import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { InteractiveTerminal } from "../src/tui/terminal";
import { receiptView, shortReceiptText, type TaskResult } from "../src/task/result";
import { buildNextRow } from "../src/tui/next-row";
import { activeThemeName, BUILT_IN_THEMES, roleCode, useTheme, type ThemeRole } from "../src/tui/theme";
import type { VerificationReport, VerificationResult } from "../src/verify/evidence";
import { ansiCells, cellsFor, type Cell } from "./support/ansi-cells";
import { withEnv } from "./support/env";
import { interactiveTerminal } from "./support/tty";

function check(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return { name: "test", status: "pass", command: "npm run test", cwd: "/repo", exitCode: 0, signal: null,
    stdout: "", stderr: "", truncated: false, durationMs: 1312, freshness: "unavailable", ...overrides };
}
function report(results: VerificationResult[], overrides: Partial<VerificationReport> = {}): VerificationReport {
  const status = results.some((result) => result.status === "fail") ? "fail" : "pass";
  return { status, repairAttempts: 0, rounds: [results], results, ...overrides };
}
const done = (task: Omit<TaskResult, "execution">): TaskResult => ({ execution: "completed", ...task });
const proven: TaskResult["proof"] = { status: "proven", check: "test", command: "npm run test", testsChanged: true, without: { exitCode: 1, ended: "fail" } };
const failed = done({ changedPaths: [...Array.from({ length: 13 }, (_, index) => `src/file-${index}.ts`), ".casper/project.yaml", "package.json"], verificationMode: "auto",
  verification: report([check({ name: "lint", command: "npm run lint", durationMs: 2100 }), check({ status: "fail", exitCode: 1, durationMs: 4000 })], { repairAttempts: 2 }),
  remoteChanges: [{ host: "build-server", changes: ["installed a service (/etc/systemd/system/app.service)"] }] });

/** The receipt's rows as the rich terminal drew them: rendered at this width, and each row found in the writer's bytes
 * before its cells count as colour evidence. */
async function drawn(task: TaskResult, assert: (cells: Cell[][], rows: string[]) => void,
  options: { theme?: string; noColor?: boolean; width?: number; next?: boolean } = {}): Promise<void> {
  await withEnv({ TERM: "xterm-256color", NO_COLOR: options.noColor ? "1" : undefined }, async () => {
    const previous = activeThemeName();
    useTheme(options.theme ?? "default");
    const width = options.width ?? 100;
    const f = interactiveTerminal();
    f.screen.writer.columns = width;
    try {
      f.terminal.start();
      const view = receiptView(task);
      f.terminal.writeResult(`${shortReceiptText(view)}\n`, view);
      if (options.next) f.terminal.offerNext(buildNextRow({ diff: { label: "Show diff", command: "/diff" }, undo: { label: "Undo", command: "/undo" } }));
      const surface = (f.terminal as unknown as { surface: { tui: { render(width: number): string[] } } }).surface;
      const receipt = () => surface.tui.render(width).filter((row) => Bun.stripANSI(row).startsWith("▌"));
      await f.screen.until(() => receipt().length > 0 && receipt().every((row) => f.screen.output.includes(row))
        && (!options.next || receipt().some((row) => row.includes("Show diff"))));
      assert(ansiCells(receipt()), receipt());
    } finally { f.close(); useTheme(previous); }
  });
}

/** Every cell in the role's colour (dim for the default theme's muted, plain where a theme leaves it unpainted). */
const painted = (cells: Cell[], role: ThemeRole) => {
  const code = roleCode(role);
  return cells.length > 0 && cells.every((cell) => code === "2" ? cell.dim : code ? cell.foreground === code : cell.foreground === "default" && !cell.dim);
};
const plain = (cells: Cell[]) => cells.length > 0 && cells.every((cell) => cell.foreground === "default" && !cell.dim);
const text = (cells: Cell[][]) => cells.map((row) => row.map((cell) => cell.char).join(""));

test("a failed receipt's card: red only on its edge, its verdict and the failed check; labels grey; config, devices and next in full colour", async () => {
  for (const theme of BUILT_IN_THEMES) await drawn(failed, (cells) => {
    const error = roleCode("error");
    for (const row of cells) expect(painted([row[0]!], "error")).toBe(true);
    const verdict = cellsFor(cells, "✗ Failed");
    expect(painted(verdict, "error") && verdict.every((cell) => cell.bold)).toBe(true);
    expect(plain(cellsFor(cells, "test failed"))).toBe(true);
    for (const label of ["Checks", "Changed", "Config", "Devices", "Next"]) expect({ theme: theme.name, label, grey: painted(cellsFor(cells, label), "muted") }).toEqual({ theme: theme.name, label, grey: true });
    expect(painted(cellsFor(cells, "✓ lint").slice(0, 1), "success")).toBe(true);
    const chip = cellsFor(cells, "✗ test 4s");
    expect(painted(chip.slice(0, 1), "error") && plain(chip.slice(2, 6)) && painted(chip.slice(7), "muted")).toBe(true);
    expect(painted(cellsFor(cells, "Ctrl+T shows the log"), "muted")).toBe(true);
    for (const value of [".casper/project.yaml, package.json", "build-server: installed a service", "/verify repair test", "15 files"]) {
      expect({ theme: theme.name, value, plain: plain(cellsFor(cells, value)) }).toEqual({ theme: theme.name, value, plain: true });
    }
    // Nothing else is red: the edge, the verdict and the failed check's mark.
    expect(cells.flat().filter((cell) => cell.foreground === error).length).toBe(cells.length + "✗ Failed".length + 1);
  }, { theme: theme.name });
});

test("not verified, not checked, incomplete and stopped are amber with ⚠, never red", async () => {
  for (const task of [
    done({ changedPaths: ["a.ts"], verificationMode: "auto", verification: report([check({ status: "fail", exitCode: null, ended: "timeout", reason: "Timed out after 600000ms" })]) }),
    done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]),
      proof: { status: "unproven", check: "test", command: "npm run test", testsChanged: false, without: { exitCode: 0, ended: "pass" } } }),
    done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]), proofSkipped: "only docs changed" }),
    done({ changedPaths: ["sum.js"], autoSkipped: "no-checks" }),
    done({ changedPaths: ["sum.js"], turnLimit: 3 }),
    { execution: "cancelled" as const, changedPaths: ["sum.js"] },
  ]) await drawn(task, (cells, rows) => {
    for (const row of cells) expect(painted([row[0]!], "warning")).toBe(true);
    const title = cells[0]!.slice(2, 2 + text(cells)[0]!.slice(2).indexOf(":"));
    expect({ title: text(cells)[0], amber: painted(title, "warning") && title.every((cell) => cell.bold) }).toEqual({ title: text(cells)[0], amber: true });
    expect({ rows, red: cells.flat().some((cell) => cell.foreground === roleCode("error")) }).toEqual({ rows, red: false });
  });
});

test("a clean pass is one green line, edge and words", async () => {
  await drawn(done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]), proof: proven }), (cells) => {
    expect(text(cells)).toEqual(["▌ ✓ Verified · test passed · changed sum.js"]);
    expect(painted(cells[0]!.filter((cell) => cell.char.trim()), "success")).toBe(true);
  });
});

test("notes are grey, and the next-step keys join the card's Next row on its edge", async () => {
  const task = done({ changedPaths: ["sum.js"], autoSkipped: "no-checks", sandbox: { held: false, reason: "--no-sandbox" } });
  await drawn(task, (cells, rows) => {
    // The first problem receipt of a session ends with where its words are explained (tests/receipt-detail.test.ts).
    // Each key is a key cap (a reversed " 1 "), then the step's words, plain (tests/next-keycaps-ansi.test.ts).
    expect(text(cells).slice(-4).map((row) => row.trimEnd())).toEqual(["▌   Notes    Shell commands and checks were not sandboxed (--no-sandbox)", '▌   Next     "add tests"',
      "▌             1  Show diff    2  Undo   · press a number", "▌   What these words mean: /help receipt"]);
    expect(painted(cellsFor(cells, "Shell commands and checks were not sandboxed"), "muted")).toBe(true);
    expect(painted([cells.at(-2)![0]!], "warning") && plain(cellsFor(cells, "Show diff")) && plain(cellsFor(cells, "Undo"))).toBe(true);
    expect(rows.join("\n")).not.toContain("Next: 1");
  }, { next: true });
  // A card with no commands of its own gets the keys on a Next row.
  await drawn(done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]) }), (cells) => {
    expect(text(cells).at(-2)?.trimEnd()).toBe("▌   Next      1  Show diff    2  Undo   · press a number");
  }, { next: true });
});

test("NO_COLOR keeps the card's layout and drops every colour", async () => {
  await drawn(failed, (cells) => {
    expect(text(cells)[0]).toBe("▌ ✗ Failed: test failed");
    for (const cell of cells.flat()) expect(cell).toMatchObject({ foreground: "default", background: "default", dim: false, bold: false });
  }, { noColor: true });
});

test("below 50 columns the receipt's own lines are shown under the edge instead", async () => {
  await drawn(failed, (cells) => {
    const rows = text(cells);
    expect(rows[0]).toBe("▌ ✗ Failed — test failed");
    expect(rows.join("\n")).not.toContain("Checks   ");
    expect(rows.join("\n")).toContain("▌ ↻ Casper tried 2 repairs");
    expect(painted([cells[0]![0]!], "error")).toBe(true);
  }, { width: 44 });
});

test("the plain terminal prints the receipt's lines as they are, without the card", () => {
  const writer = Object.assign(new EventEmitter(), { isTTY: false, columns: 100, output: "", write(chunk: string) { writer.output += chunk; return true; } });
  const terminal = new InteractiveTerminal(Object.assign(new PassThrough(), { isTTY: false }), writer, () => {}, () => {});
  const view = receiptView(failed);
  terminal.writeResult(`${shortReceiptText(view)}\n`, view);
  expect(writer.output).toBe(`${shortReceiptText(view)}\n`);
});
