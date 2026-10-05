import { expect, test } from "bun:test";
import { SessionYes } from "../src/app/session-yes";

/** The browser and debugger boxes: 1 No · 2 Yes, this once · 3 Yes, for this session. A session yes covers the same
 * kind of action until Casper exits; nobody to ask (or Esc) is a No. */
function asker(...answers: Array<string | undefined>) {
  const asked: Array<{ question: string; labels: string[] }> = [];
  const yes = new SessionYes(async (_preview, question, options) => {
    asked.push({ question, labels: options.map((option) => option.label) });
    return answers.shift();
  });
  return { yes, asked };
}

test("the box offers the three yes-words, No first", async () => {
  const { yes, asked } = asker("No");
  expect(await yes.approve("browser", "Browser action: click #submit\n", "Allow this browser action?")).toBe(false);
  expect(asked).toEqual([{ question: "Allow this browser action?", labels: ["No", "Yes, this once", "Yes, for this session"] }]);
});

test("Yes, this once allows one action; the next asks again", async () => {
  const { yes, asked } = asker("Yes, this once", undefined);
  expect(await yes.approve("browser", "", "Allow this browser action?")).toBe(true);
  expect(await yes.approve("browser", "", "Allow this browser action?")).toBe(false);
  expect(asked).toHaveLength(2);
});

test("Yes, for this session stops asking for that key only, until forget", async () => {
  const { yes, asked } = asker("Yes, for this session", "No", "No");
  expect(await yes.approve("browser", "", "Allow this browser action?")).toBe(true);
  expect(await yes.approve("browser", "", "Allow this browser action?")).toBe(true);
  expect(asked).toHaveLength(1);
  expect(await yes.approve("debug:example", "", "Launch this debugger target?")).toBe(false);
  expect(asked).toHaveLength(2);
  yes.forget();
  expect(await yes.approve("browser", "", "Allow this browser action?")).toBe(false);
  expect(asked).toHaveLength(3);
});
