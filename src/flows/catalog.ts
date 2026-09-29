import { parseSkillMetadata, splitSkill } from "../skills/metadata";
import type { SkillRegistry, SkillSummary } from "../skills/registry";
import planFirstSource from "./plan-first/SKILL.md" with { type: "text" };
import proveFixSource from "./prove-fix/SKILL.md" with { type: "text" };

/** When a flow is offered: before the model's turn, or on the row after the receipt. */
export type FlowWhen = "before-work" | "after-receipt";
/** Whether choosing the flow spends model tokens. A free flow runs locally. */
export type FlowCost = "tokens" | "free";

/** The rules Casper knows. A flow is offered only by its rule; a skill naming another rule is ignored. */
export const FLOW_RULES = ["plan-first", "prove-fix"] as const;
export type FlowRule = typeof FLOW_RULES[number];

/** Flow bodies ride along with one prompt, so they stay small (about 800 tokens). */
export const MAX_FLOW_BODY_BYTES = 3 * 1024;

export interface Flow {
  name: string;
  description: string;
  when: FlowWhen;
  rule: FlowRule;
  label: string;
  cost: FlowCost;
  body: string;
  /** Bundled with Casper, or a trusted skill of the user's own that replaces the bundled one. */
  source: "bundled" | "user";
  /** The skill id, for a user flow. */
  skillId?: string;
}

/** The `casper-flow` frontmatter block. Other agents ignore unknown keys, so the file stays a valid skill. */
export function parseFlow(source: string, origin: Flow["source"] = "bundled"): Flow {
  const { header, body } = splitSkill(source);
  const metadata = parseSkillMetadata(header);
  if (!metadata.disableModelInvocation) {
    throw new Error(`flow ${metadata.name} must set disable-model-invocation: true, so keyword ranking never loads it`);
  }
  const block = metadata.extra["casper-flow"];
  if (!block || typeof block !== "object" || Array.isArray(block)) throw new Error(`flow ${metadata.name} has no casper-flow block`);
  const fields = block as Record<string, unknown>;
  const when = fields.when;
  if (when !== "before-work" && when !== "after-receipt") throw new Error(`flow ${metadata.name}: casper-flow.when must be before-work or after-receipt`);
  const rule = fields.rule;
  if (typeof rule !== "string" || !FLOW_RULES.includes(rule as FlowRule)) {
    throw new Error(`flow ${metadata.name}: casper-flow.rule must be one of ${FLOW_RULES.join(", ")}`);
  }
  const label = fields.label;
  if (typeof label !== "string" || !label.trim() || label.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(label)) {
    throw new Error(`flow ${metadata.name}: casper-flow.label must be one short line`);
  }
  const cost = fields.cost;
  if (cost !== "tokens" && cost !== "free") throw new Error(`flow ${metadata.name}: casper-flow.cost must be tokens or free`);
  if (Buffer.byteLength(body) > MAX_FLOW_BODY_BYTES) throw new Error(`flow ${metadata.name}: the body is larger than 3 KiB`);
  return { name: metadata.name, description: metadata.description, when, rule: rule as FlowRule, label: label.trim(), cost, body, source: origin };
}

const BUNDLED_SOURCES = [planFirstSource, proveFixSource];

/** The flows shipped with Casper. A broken bundled flow is a build error, so this throws. */
export function bundledFlows(): Flow[] {
  return BUNDLED_SOURCES.map((source) => parseFlow(source, "bundled"));
}

export interface FlowCatalog {
  flows: Flow[];
  /** One line per user skill that declares casper-flow but could not be used. */
  warnings: string[];
}

function userFlowCandidate(skill: SkillSummary): boolean {
  // Only the user's own skills (~/.casper/skills, trusted because the user put them there) may replace a
  // flow. A project skill comes with the repository and an external one is someone else's text, so neither
  // becomes a suggestion: a reviewed external skill's digest is checked only when it loads for a task.
  return skill.source === "user" && skill.trust === "trusted" && skill.extra["casper-flow"] !== undefined;
}

/** Bundled flows, with a same-name trusted user skill in place of the bundled one. Reading a skill's body
 * here never sends it to the model: a flow reaches a prompt only after the user picks it. */
export async function loadFlowCatalog(registry?: Pick<SkillRegistry, "list" | "inspect">): Promise<FlowCatalog> {
  const flows = new Map(bundledFlows().map((flow) => [flow.name, flow]));
  const warnings: string[] = [];
  for (const skill of registry?.list() ?? []) {
    if (!userFlowCandidate(skill)) continue;
    if (!flows.has(skill.name)) {
      warnings.push(`[flows] ${skill.id} declares casper-flow but no Casper flow is named ${skill.name}; it is not offered`);
      continue;
    }
    try {
      const loaded = await registry!.inspect(skill.id);
      // inspect() returns the body only (and refuses a skill whose frontmatter changed since indexing);
      // the flow block comes from the indexed frontmatter.
      const flow = parseFlowFromParts(skill, loaded.body);
      flows.set(flow.name, { ...flow, skillId: skill.id });
    } catch (error) {
      warnings.push(`[flows] ${skill.id} is not used: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { flows: [...flows.values()], warnings };
}

function parseFlowFromParts(skill: SkillSummary, body: string): Flow {
  if (!skill.disableModelInvocation) {
    throw new Error("a flow must set disable-model-invocation: true, so keyword ranking never loads it");
  }
  const block = skill.extra["casper-flow"];
  const header = `name: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n`
    + `disable-model-invocation: true\ncasper-flow: ${JSON.stringify(block)}`;
  return parseFlow(`---\n${header}\n---\n${body}\n`, "user");
}

export function findFlow(catalog: FlowCatalog | Flow[], name: string): Flow | undefined {
  const flows = Array.isArray(catalog) ? catalog : catalog.flows;
  return flows.find((flow) => flow.name === name);
}

/** The prompt for a flow the user chose. The flow is guidance for this one request, never permission. */
export function formatFlowPrompt(flow: Flow, request: string): string {
  return [
    `Casper flow "${flow.name}", chosen by the user for this request only. It is guidance, not permission; Casper policy and the request come first.`,
    `--- Flow ${flow.name} ---`,
    flow.body,
    "--- End flow ---",
    "",
    `Request: ${request}`,
  ].join("\n");
}
