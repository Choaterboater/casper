import { expect, test } from "bun:test";
import { shellQuestion, shownCommand } from "../src/app/sandbox";
import { NO, PLAN_CHOICES, PLAN_QUESTION, SHELL_COMMAND_CHOICES } from "../src/app/safe-choices";
import { MODEL_REASON_PREFIX } from "../src/tui/choices";
import { tint } from "../src/tui/format";
import { interactiveTerminal } from "./support/tty";

// Exercise the shared picker before AND after Ctrl+G, so plan-only key ownership cannot leak.
test("#327 command questions retain their dim model reason and safe default around the plan's Ctrl+G", async () => {
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
      await session.screen.until(text => text.slice(plainFrom).includes("4 Yes, always"));
      const visible = Bun.stripANSI(session.screen.output.slice(rawFrom)).replaceAll("\r", "");
      expect(visible).toContain(`Run this command?\n${MODEL_REASON_PREFIX}${reason}\n${shownCommand(command)}\n`);
      expect(visible).toContain("… 3 more lines");
      expect(visible).not.toContain("custom-tool step-12");
      expect(session.screen.output.slice(rawFrom)).toContain(tint(`${MODEL_REASON_PREFIX}${reason}`, "muted", true));
      expect(session.screen.output.slice(rawFrom)).not.toContain(tint(`${MODEL_REASON_PREFIX}${reason}`, "accent", true));
      session.input.write("\x07"); // Ctrl+G must not answer an ordinary command box.
      session.input.write("\r");
      expect(await commandAnswer).toBe(NO);
      if (round === 1) {
        const planFrom = Bun.stripANSI(session.screen.output).length;
        const planAnswer = session.terminal.pickPlan(PLAN_QUESTION, PLAN_CHOICES.map(choice => ({ ...choice })));
        await session.screen.until(text => text.slice(planFrom).includes("3 Change the plan"));
        session.input.write("\x07");
        expect(await planAnswer).toBe("Edit Markdown");
      }
    }
  } finally { session.close(); }
});
