import { expect, test } from "bun:test";
import { shellQuestion } from "../src/app/sandbox";
import { NO, PLAN_CHOICES, PLAN_QUESTION, SHELL_COMMAND_CHOICES } from "../src/app/safe-choices";
import { MODEL_REASON_PREFIX } from "../src/tui/choices";
import { tint } from "../src/tui/format";
import { renderPanel } from "../src/tui/presentation";
import { interactiveTerminal } from "./support/tty";

// Exercise the shared picker before AND after Ctrl+G, so plan-only key ownership cannot leak.
test("#327 command questions keep Casper's title, dim model reason and safe default around the plan's Ctrl+G", async () => {
  const previous = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const session = interactiveTerminal();
  if (previous === undefined) delete process.env.TERM; else process.env.TERM = previous;
  try {
    session.terminal.start();
    for (const round of [1, 2]) {
      const rawFrom = session.screen.output.length;
      const plainFrom = Bun.stripANSI(session.screen.output).length;
      const reason = `Check custom steps, round ${round}.`;
      const command = Array.from({ length: 15 }, (_, i) => `custom-tool step-${i}`).join("\n");
      const commandAnswer = session.terminal.pick(shellQuestion(command, reason), [...SHELL_COMMAND_CHOICES]);
      await session.screen.until(text => text.slice(plainFrom).includes("4. Yes to everything"));
      const visible = Bun.stripANSI(session.screen.output.slice(rawFrom)).replaceAll("\r", "");
      const commandRows = renderPanel("Command", [...command.split("\n").slice(0, 8), "… 4 more lines", ...command.split("\n").slice(-3)], session.screen.writer.columns, false, "muted");
      expect(visible).toContain(`\nRun this command?\n${MODEL_REASON_PREFIX}${reason}\n${commandRows.join("\n")}\n`);
      expect(visible).not.toContain("custom-tool step-10");
      expect(session.screen.output.slice(rawFrom)).toContain(tint(`${MODEL_REASON_PREFIX}${reason}`, "muted", true));
      for (const row of commandRows) expect(session.screen.output.slice(rawFrom)).toContain(`\x1b[2m${row}\x1b[0m`);
      session.input.write("\x07"); // Ctrl+G must not answer an ordinary command box.
      session.input.write("\r"); session.input.write("\r"); // Enter on No opens its note line; an empty one is a plain No.
      expect(await commandAnswer).toBe(NO);
      if (round === 1) {
        const planFrom = Bun.stripANSI(session.screen.output).length;
        const planAnswer = session.terminal.pickPlan(PLAN_QUESTION, PLAN_CHOICES.map(choice => ({ ...choice })));
        await session.screen.until(text => text.slice(planFrom).includes("3. Change the plan"));
        session.input.write("\x07");
        expect(await planAnswer).toBe("Edit Markdown");
      }
    }
  } finally { session.close(); }
});
