import { expect, test } from "bun:test";
import { extractPlan } from "../src/flows/plan";
import { planChanges } from "../src/flows/plan-changes";

const plan = (text: string) => extractPlan(text);

test("a rewrite's changes are the lines added and removed under their section; a step that only moved number is not one", () => {
  const before = plan("Goal:\nTrack card sales.\n\nSteps:\n1. Read the export\n2. Save the listings\n3. Show the listings\n\nDone means:\n1. Listings show\n\nOpen questions:\n- Is the limit per user or per key?");
  const after = plan("Goal:\nTrack card sales.\n\nSteps:\n1. Read the export\n2. Read each post's date\n3. Save the listings\n4. Show the listings with their dates\n\nDone means:\n1. Listings show");
  const changes = planChanges(before, after);
  expect(changes.added).toBe(2);
  expect(changes.removed).toBe(2);
  expect(changes.rows).toEqual([
    "Steps",
    "  + 2. Read each post's date",
    "  - 3. Show the listings",
    "  + 4. Show the listings with their dates",
    "Open questions",
    "  - Is the limit per user or per key?",
  ]);
});

test("nothing changed says so, and a long list of changes stops at its limit with how many more", () => {
  const steps = (count: number, word: string) => Array.from({ length: count }, (_, index) => `${index + 1}. ${word} ${index + 1}`).join("\n");
  const same = plan(`Steps:\n${steps(3, "Build part")}`);
  expect(planChanges(same, same)).toEqual({ added: 0, removed: 0, rows: [] });
  const many = planChanges(plan(`Steps:\n${steps(30, "Build part")}`), plan(`Steps:\n${steps(30, "Make piece")}`), 10);
  expect(many.added).toBe(30);
  expect(many.removed).toBe(30);
  expect(many.rows).toHaveLength(11);
  expect(many.rows.at(-1)).toBe("  … 51 more changed lines");
});

test("a new project's spec sections are compared the same way", () => {
  const before = plan("Screens:\n- Listings: one row per post\n\nData:\n- app.db holds the listings\n\nFirst version:\n- Import and Listings");
  const after = plan("Screens:\n- Listings: one row per post, with its date\n\nData:\n- app.db holds the listings\n\nFirst version:\n- Import and Listings");
  expect(planChanges(before, after).rows).toEqual(["Screens", "  - Listings: one row per post", "  + Listings: one row per post, with its date"]);
});
