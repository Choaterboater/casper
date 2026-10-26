import { expect, test } from "bun:test";
import { keepGoingNeed, keepGoingPrompt, KEEP_GOING_ROUNDS, openPlanNote } from "../src/task/keep-going";

test("open items or a said next step are a reason to carry on; a question, a finished answer or nothing open are not", () => {
  expect(keepGoingNeed("Fixed the parser.\n\nStill not done: update the README — not started\n- **Still not done:** add a test — later"))
    .toEqual({ items: ["update the README — not started", "add a test — later"], next: false });
  expect(keepGoingNeed("The greeting is changed. Next I'll update the README to match.")).toEqual({ items: [], next: true });
  expect(keepGoingNeed("Changed it.\n\nStill not done: the README\n\nShould it say two or 2?")).toBeUndefined();
  expect(keepGoingNeed("Changed the greeting to two.")).toBeUndefined();
  expect(keepGoingNeed("")).toBeUndefined();
  expect(KEEP_GOING_ROUNDS).toBe(2);
});

test("the prompt names what is open and leaves the person only what needs them", () => {
  const prompt = keepGoingPrompt({ items: ["update the README — not started"], next: false }, [{ step: 4, title: "Add the export button" }]);
  expect(prompt).toContain("Casper: you stopped with work still open.");
  expect(prompt).toContain("Still open:\n- update the README — not started\n- Plan step 4: Add the export button");
  expect(prompt).toContain("Leave only what needs the person");
  expect(prompt).toContain("use the ask tool");
  expect(keepGoingPrompt({ items: [], next: true }, [])).toContain("You said what you do next and stopped: do it now.");
  // A long list is cut, with how many more.
  const many = keepGoingPrompt({ items: Array.from({ length: 30 }, (_, index) => `item ${index + 1}`), next: false }, []);
  expect(many).toContain("- item 12\n- and 18 more");
  expect(many).not.toContain("item 13");
});

test("plan steps the build left open are named for the next task, with where the plan is", () => {
  expect(openPlanNote(".casper/plans/2026-10-26-tracker.md", [{ step: 29, title: "Build the extension", status: "not-done", reason: "no extension folder" },
    { step: 30, title: "Test the extension", status: "pending" }]))
    .toBe("Open from the plan built earlier in this conversation (.casper/plans/2026-10-26-tracker.md): 29. Build the extension (not done: no extension folder); 30. Test the extension. They are part of the work when the person asks to finish it.");
  expect(openPlanNote(".casper/plans/x.md", [])).toBeUndefined();
});
