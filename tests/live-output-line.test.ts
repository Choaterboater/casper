import { afterAll, expect, spyOn, test } from "bun:test";
import { RuntimeEventView } from "../src/app/events";
import { footerJob } from "../src/app/footer";
import { BackgroundCommands } from "../src/runtime/background-commands";
import type { RuntimeEvent } from "../src/runtime/types";
import type { WorkView } from "../src/tui/surface";
import type { InteractiveTerminal } from "../src/tui/terminal";
import { activeThemeName, BUILT_IN_THEMES, roleCode, useTheme } from "../src/tui/theme";
import { ansiCells, cellsFor } from "./support/ansi-cells";
import { withEnv } from "./support/env";
import { interactiveTerminal } from "./support/tty";

/** From a live session: while a command ran the screen said only "Running sleep 90 +1 more · 13s". The running step
 * keeps one dim line with its latest output, and a job in the background shows its latest line on the status row. */

let clock = 1_000;
const spy = spyOn(performance, "now").mockImplementation(() => clock);
afterAll(() => spy.mockRestore());

const LINE = "#12 [3/6] RUN pip install -r requirements.txt";

function box() {
  const views: WorkView[] = [];
  const terminal = { rich: true, columns: 100, questionsShown: 0, questionOpen: false, endAssistant() {}, assistant() {},
    setWork(view?: WorkView) { if (view) views.push(view); }, write() {}, writeFold() {} };
  const events = new RuntimeEventView(terminal as unknown as InteractiveTerminal, { write() {} }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false, projectRoot: () => "/work/app" });
  return { events, views, handle: (...list: RuntimeEvent[]) => { for (const event of list) events.handle(event); } };
}

test("the running command's output line is redrawn at most about once a second", () => {
  clock = 1_000;
  const s = box();
  const progress = (text: string): RuntimeEvent => ({ type: "tool_progress", toolName: "bash", toolCallId: "1", text });
  s.handle({ type: "tool_start", toolName: "bash", toolCallId: "1", input: { command: "docker compose build" } }, progress("#10 [1/6] FROM python"));
  expect(s.views.at(-1)!.plain).toContain("↳ #10 [1/6] FROM python");
  const drawn = s.views.length;
  clock += 300;
  s.handle(progress("#11 [2/6] COPY . ."));
  clock += 300;
  s.handle(progress(`#11 [2/6] COPY . .\n${LINE}\n`));
  expect(s.views.length).toBe(drawn);
  clock += 500;
  s.handle(progress(`${LINE}\napi_key=sk-abcdefghijklmnopqrstuvwxyz123456\n`));
  expect(s.views.length).toBe(drawn + 1);
  expect(s.views.at(-1)!.plain!.at(-1)).toStartWith("↳ api_key=");
  expect(s.views.at(-1)!.plain!.join("\n")).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  s.events.reset();
});

test("the live output line is dim (grey), never amber or red, in every theme", async () => {
  for (const noColor of [false, true]) await withEnv({ TERM: "xterm-256color", NO_COLOR: noColor ? "1" : undefined }, async () => {
    const previous = activeThemeName();
    try {
      for (const theme of BUILT_IN_THEMES) {
        useTheme(theme.name);
        const f = interactiveTerminal();
        try {
          f.screen.writer.columns = 100;
          f.terminal.start();
          f.terminal.setWork({ rows: ["• bash · docker compose build", `↳ ${LINE}`], plain: ["• Running docker compose build · 12s", `↳ ${LINE}`], status: "Running docker compose build · 12s" });
          await f.screen.until(text => text.includes("RUN pip install"));
          const rows = (f.terminal as unknown as { surface: { tui: { render(width: number): string[] } } }).surface.tui.render(100);
          const row = rows.find(line => Bun.stripANSI(line).includes(LINE))!;
          await f.screen.until(() => f.screen.output.includes(row));
          const cells = cellsFor(ansiCells([row]), LINE);
          const dim = !noColor && theme.name !== "high-contrast";
          expect(cells.every(cell => cell.dim === dim)).toBe(true);
          if (!noColor) expect(cells.some(cell => [roleCode("warning"), roleCode("error")].includes(cell.foreground))).toBe(false);
        } finally { f.close(); }
      }
    } finally { useTheme(previous); }
  });
});

test("a job in the background shows its latest output line on the status row, secrets hidden", async () => {
  let shown = 0;
  const done = Promise.withResolvers<{ exitCode: number | null }>();
  const commands = new BackgroundCommands({ notify() {}, output: () => { shown++; } });
  const job = commands.adopt({ command: "ssh nas tail -f /tmp/app-build.log", startedAt: 0, output: "", done: done.promise, stop: () => done.resolve({ exitCode: null }) })!;
  job.write(Buffer.from("#10 [1/6] FROM python\n"));
  job.write(Buffer.from(`${LINE}\n`));
  // At most about once a second: the first now, the newest within the second.
  expect(shown).toBe(1);
  const end = Date.now() + 3_000;
  while (shown < 2 && Date.now() < end) await Bun.sleep(50);
  expect(shown).toBe(2);
  expect(footerJob(commands)).toMatchObject({ id: "cmd-1", line: LINE });
  job.write(Buffer.from("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n"));
  expect(footerJob(commands)?.line).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  await commands.close();
});

test("the status row's job says its latest line, dim", async () => {
  await withEnv({ TERM: "xterm-256color", NO_COLOR: undefined }, async () => {
    const previous = activeThemeName();
    try {
      useTheme("default");
      const f = interactiveTerminal();
      try {
        f.terminal.setStatus("sample │ provider/model"); f.terminal.start();
        f.terminal.setJob({ id: "cmd-1", label: "ssh nas tail -f …", startedAt: Date.now(), line: LINE });
        let footer = "";
        const end = Date.now() + 3_000;
        while (!Bun.stripANSI(footer = f.terminal.footerLine(200) ?? "").includes("RUN pip") && Date.now() < end) await Bun.sleep(20);
        expect(Bun.stripANSI(footer)).toContain(`◐ cmd-1 running <1m · ssh nas tail -f … → ${LINE}`);
        expect(cellsFor(ansiCells([footer]), "RUN pip").every(cell => cell.dim)).toBe(true);
      } finally { f.close(); }
    } finally { useTheme(previous); }
  });
});
