import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const MODEL_ROLES = ["fast", "build", "reason", "review"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export type EffortSelection = "auto" | ThinkingLevel;
export type ModelReference = { provider: string; id: string };
export type ModelRoles = Partial<Record<ModelRole, string>>;
export type ResolvedModelSelection = {
  reference: ModelReference;
  effort?: EffortSelection;
  role?: ModelRole | "default";
};

export function isModelRole(value: string): value is ModelRole {
  return MODEL_ROLES.some((role) => role === value);
}

export function isEffortSelection(value: string): value is EffortSelection {
  return value === "auto" || value === "off" || value === "minimal" || value === "low"
    || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function exactModel(query: string, models: readonly ModelReference[]): ModelReference | undefined {
  const normalized = query.toLowerCase();
  let qualified: ModelReference | undefined;
  let bare: ModelReference | undefined;
  let qualifiedAmbiguous = false;
  let bareAmbiguous = false;
  for (const model of models) {
    if (`${model.provider}/${model.id}`.toLowerCase() === normalized) {
      if (qualified) qualifiedAmbiguous = true;
      qualified = model;
    }
    if (model.id.toLowerCase() === normalized) {
      if (bare) bareAmbiguous = true;
      bare = model;
    }
  }
  if (qualified ? qualifiedAmbiguous : bareAmbiguous) {
    throw new Error(`Ambiguous model "${query}"; use provider/model-id.`);
  }
  return qualified ?? bare;
}

/** Resolve only explicit selectors; authentication and model activation belong to the caller. */
export function resolveModelSelection(query: string, models: readonly ModelReference[], roles: ModelRoles,
  defaultReference?: ModelReference): ResolvedModelSelection {
  let selector = query.trim();
  let effort: EffortSelection | undefined;
  let role: ModelRole | "default" | undefined;
  const visited: ModelRole[] = [];
  const resolved = (reference: ModelReference): ResolvedModelSelection => ({
    reference: { provider: reference.provider, id: reference.id },
    ...(effort === undefined ? {} : { effort }),
    ...(role === undefined ? {} : { role }),
  });

  // Each configured role can be expanded once; the final step resolves its model or @default.
  for (let depth = 0; depth <= MODEL_ROLES.length; depth++) {
    let model = exactModel(selector, models);
    if (model) return resolved(model);

    const colon = selector.lastIndexOf(":");
    if (colon !== -1) {
      const suffix = selector.slice(colon + 1).toLowerCase();
      if (!isEffortSelection(suffix)) {
        throw new Error(`Unknown effort suffix "${suffix}"; use auto, off, minimal, low, medium, high, xhigh, or max.`);
      }
      effort ??= suffix;
      selector = selector.slice(0, colon);
      model = exactModel(selector, models);
      if (model) return resolved(model);
    }

    if (!selector.startsWith("@")) {
      throw new Error(`Unknown model selector "${selector}". Use /model to see available models.`);
    }
    const alias = selector.slice(1).toLowerCase();
    if (alias === "default") {
      role ??= "default";
      if (!defaultReference) throw new Error("No saved default model is configured for @default.");
      const saved = models.find((candidate) => candidate.provider.toLowerCase() === defaultReference.provider.toLowerCase()
        && candidate.id.toLowerCase() === defaultReference.id.toLowerCase());
      if (!saved) {
        throw new Error(`Saved default model "${defaultReference.provider}/${defaultReference.id}" is unavailable. Select a new default with /model.`);
      }
      return resolved(saved);
    }
    if (!isModelRole(alias)) {
      throw new Error(`Unknown model role "${selector}"; use @fast, @build, @reason, @review, or @default.`);
    }
    role ??= alias;
    if (visited.includes(alias)) {
      throw new Error(`Cyclic model role alias: ${[...visited, alias].map((entry) => `@${entry}`).join(" -> ")}.`);
    }
    visited.push(alias);
    const configured = roles[alias]?.trim();
    if (!configured) throw new Error(`Model role @${alias} is not configured.`);
    selector = configured;
  }
  throw new Error("Model role alias chain exceeds the number of supported roles.");
}
