import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { extractPlan, planScreenRows, type ParsedPlan, type PlanScreenOptions } from "../src/flows/plan";

const plan: ParsedPlan = {
  title: "A calmer project board", goal: ["Find the next task quickly."],
  found: ["The route already exists in src/pages/board.ts."],
  openQuestions: ["Should the board include archived tasks?"],
  screens: ["Board: grouped cards, task form and an empty state."],
  data: ["Task: title, group and due date."], look: ["Like Linear: dark, quiet."],
  firstVersion: ["Create, edit and move a task."], later: ["Shared boards."],
  steps: [], tests: ["a newly added task appears", "an empty title is rejected"],
  details: ["src/pages/board.ts owns the route."],
};
const headings = ["Goal", "What I found", "Screens", "Data", "Look", "First version", "Later", "Done means", "Open questions"];
const plain = (rows: string[]) => rows.map(row => stripVTControlCharacters(row));
// An open box: a title rule, a blank row, the plan at the left edge with nothing beside it, a blank row, a closing rule.
const inside = (rows: string[]) => rows.slice(2, -2).map(row => row.trim());
/** Its rules are as wide as the window and no row is wider; nothing sits beside the plan, so a mouse copy takes no border. */
const openBox = (rows: string[], width: number) => {
  expect(visibleWidth(rows[0]!)).toBe(width);
  expect(visibleWidth(rows.at(-1)!)).toBe(width);
  expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
  expect(plain(rows.slice(1, -1)).join("\n")).not.toMatch(/│|[╭╮╰╯]/);
};

describe("the designed plan panel", () => {
  test.each([80, 160])("a framed panel at %i columns: title in the top edge, footer in bottom edge, even spacing", width => {
    const rows = planScreenRows(plan, width, { framed: true, more: "details" });
    expect(rows[0]).toStartWith("── Plan · A calmer project board ─");
    expect(rows.at(-1)).toContain("Ctrl+T details · Ctrl+G edit");
    expect(rows.at(-1)).toEndWith("edit ─");
    // The rules are as wide as the window.
    openBox(rows, width);
    expect(rows[1]).toBe("");
    expect(rows.at(-2)).toBe("");
    const content = inside(rows);
    for (const heading of headings) {
      expect(content).toContain(heading);
      if (heading !== "Goal") expect(content[content.indexOf(heading) - 1]).toBe("");
      expect(content[content.indexOf(heading) + 1]).not.toBe("");
    }
    expect(content).not.toContain("Steps");
  });
  test("plain/NO_COLOR sections are identical, unframed, and empty sections omitted", () => {
    const unframed = planScreenRows(plan, 80);
    for (const heading of headings) expect(unframed).toContain(heading);
    expect(unframed[0]).toBe("Casper plan · A calmer project board");
    expect(unframed.join("\n")).not.toContain("╭");
    expect(unframed.join("\n")).not.toContain("owns the route");
    expect(planScreenRows({ steps: [], tests: [], found: [" "], goal: [] }, 80)).toEqual(["Casper plan"]);
    expect(planScreenRows(plan, 80, { full: true }).join("\n")).toContain("owns the route");
  });
  test("theme accents headings and dims paths after sanitizing model text", () => {
    const headingsSeen: string[] = [], pathsSeen: string[] = [];
    const options: PlanScreenOptions = { framed: true,
      accent: text => { headingsSeen.push(text); return `\x1b[36m${text}\x1b[0m`; },
      dim: text => { pathsSeen.push(text); return `\x1b[2m${text}\x1b[0m`; },
    };
    const rows = planScreenRows(plan, 80, options);
    for (const heading of headings) expect(headingsSeen).toContain(heading);
    expect(pathsSeen).toContain("src/pages/board.ts");
    openBox(rows, 80);
    expect(plain(rows)).toEqual(planScreenRows(plan, 80, { framed: true }));
    const attack = planScreenRows({ steps: ["Do \x1b[2Jnot clear"], tests: [] }, 80, options);
    expect(attack.join("\n")).not.toContain("\x1b[2J");
  });
  test.each([6, 8, 10, 20, 40, 80, 160])("long words, paths and titles wrap without cuts at %i", width => {
    const title = "Project".repeat(35), word = "abcdefghij".repeat(35), file = `src/${"folder/".repeat(30)}board.ts`;
    for (const framed of [false, true]) {
      const rows = planScreenRows({ title, screens: [word], found: [file], steps: [], tests: [] }, width, { framed, more: "Ctrl+T details · Ctrl+G edit" });
      expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
      const content = (framed ? inside(rows) : rows).join("").replace(/\s/g, "");
      for (const text of [title, word, file]) expect(content).toContain(text);
      expect(rows.join("").replace(/\s|[│─╰╯]/g, "")).toContain("Ctrl+Tdetails·Ctrl+Gedit");
      expect(content).not.toContain("…");
    }
  });
  test("blank lines inside sections are omitted while mock-up indentation stays", () => {
    const rows = planScreenRows({ steps: [], tests: [], see: ["A board", "", "  ┌──┐", "  │hi│", "  └──┘"] }, 80, { framed: true });
    expect(rows).toContain("  A board");
    const text = rows.join("\n");
    expect(text).toContain("\n    ┌──┐\n");
    expect(inside(rows).filter(row => !row)).toHaveLength(0);
  });
  test("criteria keep every qualifier, even beyond normal checklist limits", () => {
    const long = `The form ${"must preserve every supplied field and qualifier ".repeat(8)}until saved.`;
    const tests = [long, ...Array.from({ length: 84 }, (_, i) => `Criterion ${i + 2} remains visible.`)];
    const parsed = extractPlan(`Screens: a board\nDone means:\n${tests.map(item => `- ${item}`).join("\n")}`);
    for (const framed of [false, true]) {
      const rows = planScreenRows(parsed, 40, { framed });
      expect(rows.every(row => visibleWidth(row) <= 40)).toBe(true);
      const content = (framed ? inside(rows) : rows).join(" ").replace(/\s+/g, " ");
      for (const item of tests) expect(content).toContain(item);
    }
  });
  test("Unicode graphemes and combining sequences remain whole", () => {
    const title = "界面👩‍💻é".repeat(15);
    const rows = planScreenRows({ title, steps: [], tests: [] }, 20, { framed: true });
    openBox(rows, 20);
    expect(inside(rows).join("").replace(/\s/g, "")).toContain(title);
  });
});

test("on a wide screen a long step keeps the width with its file after the words; links and bold read as words", () => {
  const wide = extractPlan([
    "Title: Improve the first pick",
    "Goal: Pick the right tool first.",
    "What I found:",
    "- [PR #10](https://example.com/org/repo/pull/10) is merged; the biggest gap is **ranking**.",
    "Steps:",
    "1. Fix the largest demonstrated general failure pattern first. Adjust ranking for ordering failures and test bounded description-based retrieval only if missing name matches explain the failures. — src/casper_network_mcp/router/find.py",
    "2. Add a test — tests/test_rules.py",
    "Done means:",
    "- The right tool is first.",
  ].join("\n"))!;
  const rows = plain(planScreenRows(wide, 200, { framed: true }));
  openBox(rows, 200);
  const body = inside(rows);
  expect(body.find(row => row.startsWith("- PR #10"))).toBe("- PR #10 is merged; the biggest gap is ranking.");
  expect(rows.join("\n")).not.toMatch(/\]\(|\*\*/);
  // The long step wraps at the frame's full width, never in a narrow column beside its file; the file follows the words.
  const step = body.findIndex(row => row.startsWith("1. Fix the largest"));
  expect(visibleWidth(body[step]!)).toBeGreaterThan(100);
  expect(body.slice(step, step + 3).join(" ").replace(/\s+/g, " ")).toContain("explain the failures. src/casper_network_mcp/router/find.py");
  // A short step: the file two spaces after its words, with no gap across the frame.
  expect(body.find(row => row.startsWith("2. Add a test"))).toBe("2. Add a test  tests/test_rules.py");
});
