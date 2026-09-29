import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundledFlows, findFlow, formatFlowPrompt, loadFlowCatalog, MAX_FLOW_BODY_BYTES, parseFlow } from "../src/flows/catalog";
import type { ProjectModel } from "../src/project/model";
import { SkillRegistry } from "../src/skills/registry";
import { classifyTask } from "../src/task/classify";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "casper-flows-"));
  temporary.push(base);
  const homeDir = path.join(base, "home");
  const projectRoot = path.join(base, "project");
  await mkdir(homeDir);
  await mkdir(projectRoot);
  return { homeDir, projectRoot };
}

const flowFrontmatter = (name: string, rule = name) =>
  `---\nname: ${name}\ndescription: My own ${name}\ndisable-model-invocation: true\ncasper-flow:\n  when: after-receipt\n  rule: ${rule}\n  label: My ${name}\n  cost: tokens\n---\n`;

async function skillFile(directory: string, source: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), source);
}

const model: ProjectModel = {
  schemaVersion: 1, project: { name: "demo", root: "/demo", git: false }, languages: ["python"], frameworks: [],
  packageManager: null, commands: {}, architecture: {}, conventions: [], detectedAt: "2026-01-01T00:00:00.000Z",
};

describe("bundled flows", () => {
  test("parse with when, rule, label and cost, and each body stays within 3 KiB", () => {
    const flows = bundledFlows();
    expect(flows.map((flow) => [flow.name, flow.when, flow.rule, flow.cost])).toEqual([
      ["plan-first", "before-work", "plan-first", "tokens"],
      ["prove-fix", "after-receipt", "prove-fix", "tokens"],
    ]);
    expect(findFlow(flows, "prove-fix")?.label).toBe("Add a test that proves this bug stays fixed");
    for (const flow of flows) {
      expect(Buffer.byteLength(flow.body)).toBeLessThanOrEqual(MAX_FLOW_BODY_BYTES);
      expect(flow.body).toContain("obra/superpowers");
      expect(flow.source).toBe("bundled");
    }
    expect(findFlow(flows, "plan-first")!.body).not.toMatch(/read-only/i);
  });

  test("a flow must opt out of keyword loading and name a known rule", () => {
    const base = flowFrontmatter("prove-fix");
    expect(() => parseFlow(base.replace("disable-model-invocation: true\n", ""))).toThrow("disable-model-invocation");
    expect(() => parseFlow(flowFrontmatter("other", "auto-deploy"))).toThrow("casper-flow.rule");
    expect(() => parseFlow(base.replace("cost: tokens", "cost: cheap"))).toThrow("casper-flow.cost");
    expect(() => parseFlow(`${base}${"x".repeat(MAX_FLOW_BODY_BYTES + 1)}`)).toThrow("3 KiB");
  });

  test("the flow prompt carries the body and the request, as guidance for this request only", () => {
    const prompt = formatFlowPrompt(findFlow(bundledFlows(), "prove-fix")!, "Fix the empty hostname crash");
    expect(prompt).toContain("chosen by the user for this request only");
    expect(prompt).toContain("Add one test that proves the bug stays fixed");
    expect(prompt.endsWith("Request: Fix the empty hostname crash")).toBe(true);
  });
});

describe("user flows", () => {
  test("a user's own skill with the same name replaces the bundled flow, and keyword ranking never loads it", async () => {
    const options = await fixture();
    await skillFile(path.join(options.homeDir, ".casper/skills/prove-fix"), `${flowFrontmatter("prove-fix")}MY_PROVE_FIX_BODY\n`);
    const registry = await SkillRegistry.discover(options);
    const catalog = await loadFlowCatalog(registry);
    const flow = findFlow(catalog, "prove-fix")!;
    expect(flow).toMatchObject({ source: "user", label: "My prove-fix", body: "MY_PROVE_FIX_BODY" });
    expect(findFlow(catalog, "plan-first")!.source).toBe("bundled");
    expect(catalog.warnings).toEqual([]);
    const request = "fix the prove-fix bug";
    expect(await registry.loadForTask(request, model, classifyTask(request))).toEqual([]);
  });

  test("a project skill with casper-flow is ignored, and an unknown flow name is reported, not offered", async () => {
    const options = await fixture();
    await skillFile(path.join(options.projectRoot, ".casper/skills/prove-fix"), `${flowFrontmatter("prove-fix")}PROJECT_BODY\n`);
    await skillFile(path.join(options.homeDir, ".casper/skills/deploy"), `${flowFrontmatter("deploy-now", "prove-fix")}DEPLOY\n`);
    const registry = await SkillRegistry.discover(options);
    const catalog = await loadFlowCatalog(registry);
    expect(findFlow(catalog, "prove-fix")!.source).toBe("bundled");
    expect(findFlow(catalog, "deploy-now")).toBeUndefined();
    expect(catalog.warnings).toEqual([expect.stringContaining("declares casper-flow but no Casper flow is named deploy-now")]);
  });

  test("a user flow that breaks the rules is reported and the bundled one stays", async () => {
    const options = await fixture();
    await skillFile(path.join(options.homeDir, ".casper/skills/plan-first"),
      `${flowFrontmatter("plan-first").replace("disable-model-invocation: true\n", "")}BODY\n`);
    const catalog = await loadFlowCatalog(await SkillRegistry.discover(options));
    expect(findFlow(catalog, "plan-first")!.source).toBe("bundled");
    expect(catalog.warnings[0]).toContain("disable-model-invocation");
  });
});
