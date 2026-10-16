import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { extractPlan, formatPlanBlock, planMarkdown, planScreenRows } from "../src/flows/plan";
import { bundledFlows, findFlow, MAX_FLOW_BODY_BYTES } from "../src/flows/catalog";

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const plain = (rows: string[]) => rows.map(row => Bun.stripANSI(row));
const content = (rows: string[]) => plain(rows).map(row => row.startsWith("│") ? row.slice(3, -3).trimEnd() : row);

test.each(["What I found", "Open questions"])("wrapped bullets in %s hang under their text, not the bullet", heading => {
  const text = heading === "Open questions"
    ? "Should tags on imported notes retain the existing spelling and punctuation?"
    : "Existing saved note fields are undocumented; keep the existing title and body fields.";
  for (const bullet of ["-", "*", "•"]) {
    const plan = extractPlan(`${heading}:\n${bullet} ${text}`);
    for (const framed of [false, true]) {
      const rows = content(planScreenRows(plan, 40, { framed }));
      const start = rows.findIndex(row => row.startsWith(`  ${bullet} `));
      expect(start).toBeGreaterThan(0);
      expect(rows[start + 1]).toMatch(/^ {4}\S/);
      const section = rows.slice(start).filter(row => row.trim() && !/^[╰─]/.test(row));
      expect(section.join(" ").replace(/\s+/g, " ")).toContain(text);
    }
  }
});

test("What you'll see keeps prose above a small dim inner box for the fenced mock-up", () => {
  const plan = extractPlan("What you'll see:\nTags sit under each note, with a filter above the list.\n```text\n[All tags v]\nNote one   #work\nNote two   #home\n```\nSteps:\n1. Add tags");
  for (const framed of [false, true]) {
    const rows = planScreenRows(plan, 80, { framed, dim });
    const text = content(rows);
    const top = text.findIndex(row => /^  ┌─+┐$/.test(row));
    expect(top).toBeGreaterThan(text.findIndex(row => row.includes("Tags sit under each note")));
    expect(text[top]!.length).toBeLessThan(40);
    expect(text[top + 1]).toMatch(/^  │ \[All tags v\] +│$/);
    expect(text[top + 2]).toContain("Note one   #work");
    expect(text[top + 4]).toMatch(/^  └─+┘$/);
    for (const row of rows.slice(rows.findIndex(row => row.includes("┌")), rows.findIndex(row => row.includes("└")) + 1)) expect(row).toContain("\x1b[2m");
    expect(rows.every(row => visibleWidth(row) <= 80)).toBe(true);
  }
  const saved = planMarkdown(plan);
  expect(saved).toMatch(/What you'll see:[\s\S]*```|What you'll see:[\s\S]*~~~/);
  expect(extractPlan(saved)).toEqual(plan);
  expect(formatPlanBlock(plan)).toContain("Note two   #home");
});

test("Open questions retains real questions and moves statements into What I found", () => {
  const fact = "Existing saved note fields are undocumented; preserve the current storage shape.";
  const parsed = extractPlan(`What I found:\n- Notes use local storage.\nOpen questions:\n- ${fact}\n- Should tags be case-sensitive?\n  Should imported tags keep their spelling?`);
  expect(parsed.found).toContain(`- ${fact}`);
  expect(parsed.openQuestions?.join(" ")).toContain("Should tags be case-sensitive?");
  expect(parsed.openQuestions?.join(" ")).not.toContain(fact);
  expect(parsed.found).toContain("- Notes use local storage.");
  const rows = planScreenRows(parsed, 160);
  expect(rows.indexOf("What I found")).toBeLessThan(rows.findIndex(row => row.includes(fact)));
  expect(rows.findIndex(row => row.includes(fact))).toBeLessThan(rows.indexOf("Open questions"));
  expect(extractPlan(planMarkdown(parsed))).toEqual(parsed);
});

test("Open questions is omitted entirely when it contains no real questions, including edited Markdown", () => {
  const fact = "Existing saved note fields are undocumented; inspect the serializer.";
  const parsed = extractPlan(`Open questions:\n- ${fact}`);
  expect(parsed.openQuestions).toBeUndefined();
  expect(parsed.found).toContain(`- ${fact}`);
  for (const plan of [parsed, { steps: [], tests: [], openQuestions: [`- ${fact}`] }]) {
    for (const framed of [false, true]) {
      const rows = planScreenRows(plan, 80, { framed });
      expect(rows.join("\n")).not.toContain("Open questions");
      expect(rows.join("\n")).toContain("What I found");
    }
    expect(planMarkdown(plan)).not.toContain("Open questions:");
    expect(formatPlanBlock(plan)).not.toContain(`Open questions:\n- ${fact}`);
  }
});

test.each([80, 160])("known main step paths are dim, two spaces after the step's words, at %i columns; unknown paths stay absent", width => {
  const plan = extractPlan("Steps:\n1. Store tags — src/notes.ts\n2. Filter notes — src/components/Filter.tsx\n3. Confirm the design");
  for (const framed of [false, true]) {
    const styled = planScreenRows(plan, width, { framed, dim });
    const rows = content(styled);
    for (const [label, file] of [["Store tags", "src/notes.ts"], ["Filter notes", "src/components/Filter.tsx"]]) {
      const index = rows.findIndex(row => row.includes(label!));
      // No column: the file follows the words, so a wide frame leaves no gap between them.
      expect(rows[index]!.trimEnd()).toEndWith(`${label}  ${file}`);
      expect(styled[index]).toContain(dim(file!));
      expect(rows.filter(row => row.includes(file!))).toHaveLength(1);
    }
    expect(rows.find(row => row.includes("Confirm the design"))?.trimEnd()).toBe("  3. Confirm the design");
    expect(styled.every(row => visibleWidth(row) <= width)).toBe(true);
  }
});

test("long step labels and paths wrap without overlap or loss in narrow panels", () => {
  const label = "Keep all existing note fields and persist the newly assigned tags after reload";
  const file = "src/components/notes/persistence/serialize.ts";
  for (const width of [12, 24, 40, 80]) {
    const rows = planScreenRows({ steps: [`${label} — ${file}`], tests: [] }, width, { framed: true, dim });
    expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
    const text = plain(rows).slice(2, -2).map(row => row.slice(1, -1)).join("").replace(/\s/g, "");
    expect(text.replace(file, "")).toContain(label.replace(/\s/g, ""));
    expect(text).toContain(file);
    expect(text).not.toContain("…");
  }
});

test("a question's factual continuation moves to facts without losing the question", () => {
  const plan = extractPlan("Open questions:\n- Should tags be case-sensitive?\n  Existing tags are stored lowercase.");
  expect(plan.openQuestions).toEqual(["- Should tags be case-sensitive?"]);
  expect(plan.found).toEqual(["- Existing tags are stored lowercase."]);
  expect(extractPlan(planMarkdown(plan))).toEqual(plan);
});

test("dynamic route paths stay whole and dim after the step's words", () => {
  const file = "src/pages/(notes)/[id].tsx";
  const rows = planScreenRows({ steps: [`Update routing — ${file}`], tests: [] }, 80, { framed: true, dim });
  const line = content(rows).find(row => row.includes("Update routing"))!;
  expect(line.trimEnd()).toEndWith(`Update routing  ${file}`);
  expect(rows.join("\n")).toContain(dim(file));
  expect(rows.filter(row => row.includes(file))).toHaveLength(1);
  const narrow = planScreenRows({ steps: [`Update routing — ${file}`], tests: [] }, 20, { framed: true, dim });
  expect(narrow.every(row => visibleWidth(row) === 20)).toBe(true);
  expect(plain(narrow).slice(2, -2).map(row => row.slice(1, -1)).join("").replace(/\s/g, "")).toContain(file);
});

test("mock-up whitespace, literal headings and multiple code blocks survive narrow rendering and save/edit", () => {
  const plan = extractPlan("What you'll see:\nA filter above notes.\n```\nGoal:\n  [All tags v]\n\n  an-extra-long-unbroken-tag-name-that-must-wrap\n```\nThe list is filtered.\n~~~\n#work\n~~~\nSteps:\n1. Add tags");
  expect(plan.see).toEqual(["A filter above notes.", "The list is filtered."]);
  expect(plan.mockup).toEqual(["Goal:", "  [All tags v]", "", "  an-extra-long-unbroken-tag-name-that-must-wrap", "", "#work"]);
  expect(extractPlan(planMarkdown(plan))).toEqual(plan);
  for (const width of [12, 24, 40, 80]) {
    const rows = planScreenRows(plan, width, { framed: true, dim });
    expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
    const compact = plain(rows).map(row => row.replace(/[│┌┐└┘─]/g, "")).join("").replace(/\s/g, "");
    expect(compact).toContain("an-extra-long-unbroken-tag-name-that-must-wrap");
    expect(compact).toContain("#work");
  }
});

test("plan-turn guidance requests a main step path and questions, not statements, within its existing budget", () => {
  const body = findFlow(bundledFlows(), "plan-first")!.body;
  expect(body).toContain("— path/to/file");
  expect(body).toContain("ending in ?");
  expect(body).toContain("facts to What I found");
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_FLOW_BODY_BYTES);
});
