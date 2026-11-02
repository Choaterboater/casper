import { expect, test } from "bun:test";
import { waitsAndLooks } from "../src/app/events";
import { planFold } from "../src/app/fold";
import { renderFold } from "../src/tui/terminal";

/** v0.4.4: "give updates every so often" got only "✓ Poll run 3 after 5 minutes · sleep 300, …", never what it saw. */

test("a poll's finished row says what it saw", () => {
  expect(waitsAndLooks("sleep 300; date +%H:%M; grep '^run' compare.out")).toBe(true);
  expect(waitsAndLooks("sleep 300")).toBe(false);
  expect(waitsAndLooks("sleep 2; ls")).toBe(false);
  expect(waitsAndLooks("npm test")).toBe(false);
  const fold = planFold([{ toolName: "bash", kind: "command", description: "Poll run 3 after 5 minutes", input: { command: "sleep 300; tail compare.out" },
    result: "omp: exit=0 secs=487", printed: "", title: "", elapsedMs: 300_000 }], "normal", {});
  expect(renderFold(fold, 120, false, false).join("\n")).toContain("Polled run 3 after 5 minutes (5m) → omp: exit=0 secs=487");
});
