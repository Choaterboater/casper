import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bundledFlows, findFlow, MAX_FLOW_BODY_BYTES } from "../src/flows/catalog";
import { FULL_HELP_TEXT, KEYS_HELP } from "../src/tui/help";
import { extractPlan, planScreenRows } from "../src/flows/plan";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
// Feature behavior belongs in reference docs; release notes and the roadmap box are written at release prep.
const documents = ["docs/TERMINAL_UX.md", "docs/VERIFICATION.md"];
const flow = () => findFlow(bundledFlows(), "plan-first")!.body;
const words = (text: string) => text.replace(/<[^>]+>|[`*]/g, "").replace(/\s+/g, " ");

test.each(documents)("%s keeps safe choices and plain-word plan changes", file => {
  const text = read(file);
  expect(text).toContain("3 Change the plan");
  expect(text).toMatch(/number(?:s|ed).*?(?:steps|plan)/si);
  expect(text).toMatch(/rewrites? (?:the whole |the )?plan/);
  expect(text).toMatch(/Enter (?:chooses Stop|stops|still stops)/);
  expect(text).not.toMatch(/3 Edit the plan|Enter goes on to.*edit lines|Your changes:|Your note:|choose 3 to see them/);
});

test.each(documents)("%s explains the bounded interview, spec, saved plan and model report", file => {
  const text = words(read(file));
  expect(text).toMatch(/clear request.*?(?:directly|direct)/i);
  expect(text).toMatch(/choices.*?change.*?build.*?(?:at most|most) 3 questions in one round/i);
  expect(text).toContain("2-4 options");
  expect(text).toContain("Type your own");
  expect(text).toMatch(/next prompt.*?answers.*?plan without more questions/i);
  for (const heading of ["Title", "Goal", "What I found", "What you'll see", "Steps", "Done means", "Open questions", "Details",
    "Screens", "Data", "Look", "First version", "Later"]) expect(text).toContain(heading);
  expect(text).toContain("60 columns");
  expect(text).toMatch(/(?:no forced|without forced|No implementation Steps are forced)/);
  expect(text).toContain("80 columns");
  expect(text).toContain("accent frame");
  expect(text).toMatch(/(?:dim paths|paths dimmed)/);
  expect(text).toMatch(/(?:plain terminals|Plain terminals).*?NO_COLOR.*?(?:no frame|unframed)/);
  for (const key of ["Ctrl+T", "Ctrl+G", "VISUAL", "EDITOR"]) expect(text).toContain(key);
  expect(text).toMatch(/rereads? it.*?(?:return|shows)/);
  expect(text).toContain(".casper/plans/date-slug.md");
  expect(text).toContain("gitignored");
  expect(text).toMatch(/\/plan alone lists recent/);
  expect(text).toContain("checklist");
  expect(text).toContain("Step 2 of 4 · Draw the header");
  expect(text).toContain("model report");
  expect(text).toMatch(/not check proof/);
});

test.each([...documents, "README.md", "site/tour.html", "site/faq.html"])("%s limits receipt claims to build items and not-done reasons", file => {
  const text = words(read(file));
  expect(text).toContain("each item from Steps (or First version in a spec)");
  expect(text).toContain("completed items as done, not-done items with reasons");
  expect(text).not.toMatch(/every plan item|every item done or not done|with reasons,.*?including completed items/);
  expect(text).toContain("model report");
  expect(text).toContain("not check proof");
});

test("the terminal guide shows matching framed and plain plan examples with section spacing", () => {
  const text = read("docs/TERMINAL_UX.md");
  const examples = [...text.matchAll(/```text\n([\s\S]*?)\n```/g)].map(match => match[1]!);
  const rich = examples.find(example => example.startsWith("╭─ Plan · A cleaner, animated header ─"));
  const plain = examples.find(example => example.startsWith("Casper plan · A cleaner, animated header\n"));
  const plan = extractPlan([
    "Title: A cleaner, animated header", "Goal: Make the name easy to read.",
    "What I found:", "- One function draws the header.", "What you'll see:",
    "Accent colour, brief fade-in:", "```", "CASPER · ready", "```", "Steps:",
    "1. Restyle the header. — src/tui/banner.ts", "2. Add a brief fade-in. — src/tui/banner.ts",
    "Done means:", "- Plain output stays readable.", "- Fade respects reduced motion.", "- Header checks pass.",
  ].join("\n"));
  expect(rich).toBe(planScreenRows(plan, 80, { framed: true, more: "Ctrl+T details · Ctrl+G edit" }).join("\n"));
  expect(plain).toBe(planScreenRows(plan, 80, { more: "Ctrl+T details · Ctrl+G edit" }).join("\n"));
  expect(rich).toContain("│    ┌────────────────┐");
  expect(rich).toMatch(/1\. Restyle the header\. {2,}src\/tui\/banner.ts/);
  expect(rich!.split("\n").every(row => Array.from(row).length === 80)).toBe(true);
  expect(plain).not.toMatch(/^[╭╰]/m);
  expect(words(text)).toContain("Plain terminals and NO_COLOR show the same sections, unframed and without colour");
});

test("the plan flow asks only build-changing questions as initial JSON, once", () => {
  const body = flow();
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_FLOW_BODY_BYTES);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(3 * 1024);
  expect(body).toContain("A clear request gets a plan directly");
  expect(body).toContain("Only if a choice changes what you build, ask at most 3");
  expect(body).toContain("questions in ONE round, on the initial answer only");
  expect(body).toContain("Return only JSON, no fences or prose");
  const example = JSON.parse(body.split("\n").find(line => line.startsWith('{"questions":'))!);
  expect(example.questions.length).toBeGreaterThanOrEqual(1);
  expect(example.questions.length).toBeLessThanOrEqual(3);
  for (const question of example.questions) {
    expect(typeof question.question).toBe("string");
    expect(question.options.length).toBeGreaterThanOrEqual(2);
    expect(question.options.length).toBeLessThanOrEqual(4);
    for (const option of question.options) {
      expect(typeof option.label).toBe("string");
      expect(typeof option.description).toBe("string");
    }
  }
  expect(body).toContain("Each question needs 2-4 options with label and description");
  expect(body).toContain("normal picker with Type your own");
  expect(body).toContain("Do not call a tool to ask");
  expect(words(body)).toContain("The next prompt contains the answers: return the plan, never more questions");
  expect(body).toContain("A change request rewrites the whole plan without another question round");
});

test("the flow specifies existing-project plans and first-version specs without forced steps", () => {
  const body = flow();
  for (const heading of ["Title", "Goal", "What I found", "What you'll see", "Steps", "Done means", "Open questions", "Details"]) {
    expect(body).toContain(`${heading}:`);
  }
  expect(body).toContain("at most 60 columns and 12 lines");
  expect(body).toContain("Concrete acceptance criteria, including checks");
  expect(body).toContain("only genuine unknowns as questions ending in ?; omit when none");
  expect(body).toContain("Details: optional");
  expect(body).toContain("For a new/empty folder or a request to make an app, site or game");
  expect(body).toContain("Title, Goal, Screens, Data, Look, First version, Later, Done means");
  expect(body).toContain("Look names a style");
  expect(words(body)).toContain("Do not force implementation Steps into a spec");
  expect(body).toContain("Do not change any file in this turn");
  expect(body).toContain("Only an explicit Build starts work");
});

test("the terminal doc retains the planning gate and separates editing from choice 3", () => {
  const text = words(read("docs/TERMINAL_UX.md"));
  expect(text).toContain("every other tool, MCP and Casper's own tools included, is refused");
  expect(text).toContain("This is Casper's gate, not a sandbox");
  expect(text).toContain("Changed while planning");
  expect(text).toContain("This host-owned save does not let the model write during planning");
  expect(text).toContain("falling back to EDITOR");
  expect(text).toContain("separate from choice 3, which stays plain words");
  expect(text).toContain("A spec without numbered steps is a valid plan");
  expect(text).toContain("not an automatic build");
});

test("published plan notes do not retroactively claim new behavior", () => {
  const release = read("docs/RELEASE.md");
  const preview = release.slice(release.indexOf("## v0.2.35:"), release.indexOf("## v0.2.34:"));
  expect(preview).not.toMatch(/Ctrl\+G|date-slug|one round|first-version spec/);
  expect(preview).toContain("numbers its steps and test cases");
  const roadmap = read("site/roadmap.html");
  const published = roadmap.slice(roadmap.indexOf('id="v0235"'), roadmap.indexOf('id="v0234"'));
  expect(published).not.toMatch(/Ctrl\+G|date-slug|one round|first-version spec/);
});

test("plan help names both plan shapes, the single round, keys, history and all three safe choices", () => {
  const line = FULL_HELP_TEXT.split("\n").find(line => line.includes("/plan <request>"))!;
  expect(line).toContain("Plan or first-version spec");
  expect(line).toContain("at most 3 questions in one round only if choices change the build");
  expect(line).toContain("1 Stop, 2 Build, 3 Change the plan in plain words");
  expect(line).toContain("Enter stops");
  expect(line).not.toContain("you edit");
  expect(FULL_HELP_TEXT).toContain("List recent saved plans to reopen");
  expect(FULL_HELP_TEXT).toContain("model report, not check proof");
  expect(KEYS_HELP).toContain("a plan's Details");
  expect(KEYS_HELP).toContain("Ctrl+G in a plan opens its saved Markdown using VISUAL or EDITOR, then rereads and shows it again");
});

test.each(["README.md", "site/tour.html", "site/faq.html"])("%s updates its plan summary without promising check proof", file => {
  const text = words(read(file));
  expect(text).toContain("3 questions in one round");
  expect(text).toContain("first-version spec");
  expect(text).toContain("1 Stop · 2 Build · 3 Change the plan");
  expect(text).toContain("Ctrl+G");
  expect(text).toContain("model report");
  expect(text).toContain("not check proof");
  expect(text).toMatch(/built, not released/i);
});
