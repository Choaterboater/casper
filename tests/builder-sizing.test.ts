import { expect, test } from "bun:test";
import { SubagentManager } from "../src/agents/manager";
import { builderSteer, builderSteerLine } from "../src/crew/auto";
import { leanToolDescription } from "../src/runtime/guidance";

// Sizing is the lead model's decision, not a keyword complexity classifier. Both its
// tool guidance and explicit split steer must keep the same substantial-parts threshold.
test("a small task does not request a crew; even an explicit split keeps the sizing threshold", () => {
  const small = "Fix the typo in src/tui/banner.ts and update its one assertion.";
  expect(builderSteer(small)).toBeUndefined();
  const guidance = builderSteerLine(builderSteer(`Split this up: ${small}`))!;
  expect(guidance).toContain("keep small or coupled work with one Casper");
  expect(guidance).toContain("several files each, different areas");
});

test("a large task can split independent multi-file areas, not every small subtask", async () => {
  const big = "Use a crew: implement the storage migration across src/storage and its tests; build the separate admin UI across src/pages and its tests; keep the release note with the lead.";
  expect(builderSteer(big)).toBe("split");
  expect(builderSteerLine(builderSteer(big))).toContain("substantial independent parts");
  const manager = new SubagentManager({ runtimeFactory: () => { throw new Error("guidance only; no model call"); } });
  try {
    const tool = manager.createTool(() => ({ cwd: "/project", projectContext: "" }), undefined,
      { run: async () => { throw new Error("guidance only; no builder"); } });
    for (const description of [tool.description, leanToolDescription(tool)]) {
      expect(description).toContain("only substantial independent parts (several files each, different areas)");
      expect(description).toContain("small/coupled work stays with one Casper");
    }
  } finally { await manager.close(); }
});
