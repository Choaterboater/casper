import { expect, test } from "bun:test";
import { StepRail } from "../src/app/steps";
import { interactiveTerminal } from "./support/tty";

test("the step rail lists each stage once, in order, with a check mark once it ends", () => {
  const rail = new StepRail();
  expect(rail.text()).toBeUndefined();
  rail.update("checklist", "start");
  expect(rail.text()).toBe("checklist");
  rail.update("checklist", "end"); rail.update("task", "start");
  expect(rail.text()).toBe("checklist ✓ · building");
  rail.update("task", "end"); rail.update("checks", "start"); rail.update("smoke", "start");
  expect(rail.text()).toBe("checklist ✓ · building ✓ · checks · smoke");
  rail.update("smoke", "end"); rail.update("checks", "end"); rail.update("repair", "start");
  expect(rail.text()).toBe("checklist ✓ · building ✓ · checks ✓ · smoke ✓ · repair");
  // A stage that runs again is active again.
  rail.update("repair", "end"); rail.update("checks", "start");
  expect(rail.text()).toBe("checklist ✓ · building ✓ · checks · smoke ✓ · repair ✓");
  rail.clear();
  expect(rail.text()).toBeUndefined();
});

test("while work runs the footer leads with the steps; idle, it shows the plain status", async () => {
  process.env.TERM = "xterm-256color";
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("project │ fixture/demo │ idle"); session.terminal.start();
    session.terminal.setActivity("working");
    session.terminal.setSteps("checklist ✓ · building");
    await session.screen.until(output => Bun.stripANSI(output).includes("checklist ✓ · building"));
    const footer = Bun.stripANSI(session.screen.output).split(/\r?\n/).filter(line => line.includes("checklist ✓ · building")).at(-1)!;
    expect(footer.indexOf("checklist ✓ · building")).toBeLessThan(footer.indexOf("project"));
    session.terminal.setSteps(undefined); session.terminal.setActivity(undefined);
  } finally { session.close(); }
});
