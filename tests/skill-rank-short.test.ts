import { expect, test } from "bun:test";
import { scoreSkill } from "../src/skills/rank";
import { classifyTask } from "../src/task/classify";

/** "re run test" loaded deep-research, grilling, migrate-to-shoehorn, modernize-tests and tdd: one word ("test", or "re"
 * from "you're") in each description. These are the descriptions from the session's skill folders. */
const skill = (name: string, description: string) => ({ name, description, tags: [], stacks: [], intents: [], extra: {} }) as never;
const SKILLS = [
  skill("deep-research", "Use this skill when the user's prompt requires (1) researching a topic across multiple sources, comparing options or alternatives, analyzing trends or history, understanding markets or industries, or reviewing literature or studies and (2) synthesizing that research into a comprehensive, narrative report. If you're planning to search the web or internal knowledge bases, consider using this skill."),
  skill("grilling", "Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases."),
  skill("migrate-to-shoehorn", "Migrate test files from `as` type assertions to @total-typescript/shoehorn. Use when user mentions shoehorn, wants to replace `as` in tests, or needs partial test data."),
  skill("modernize-tests", "Modernize an old test suite: move it to the current test runner and replace deprecated assertions."),
  skill("tdd", "Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions \"red-green-refactor\", or wants integration tests."),
];
const project = { languages: [], frameworks: [] } as never;
const picked = (request: string) => SKILLS.filter((entry) => scoreSkill(entry, request, project, classifyTask(request)) > 0).map((entry) => (entry as { name: string }).name);

test("a short request with one generic word pulls in no skill", () => {
  for (const request of ["re run test", "run test", "test", "re run the test again"]) expect({ request, picked: picked(request) }).toEqual({ request, picked: [] });
});

test("a request that is about a skill still picks it: by its name, or by two of its description's words", () => {
  expect(picked("use tdd for the parser")).toEqual(["tdd"]);
  expect(picked("grill me on this plan")).toEqual(["grilling"]);
  expect(picked("replace the as assertions in tests with shoehorn")).toContain("migrate-to-shoehorn");
  expect(picked("write integration tests test-first, red-green-refactor")).toContain("tdd");
  expect(picked("research the market and write a narrative report")).toEqual(["deep-research"]);
});
