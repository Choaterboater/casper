import { expect, test } from "bun:test";
import { resolveModelSelection, type ModelReference, type ModelRoles } from "../src/runtime/model-routing";

const models: readonly ModelReference[] = [
  { provider: "first", id: "shared" },
  { provider: "second", id: "shared" },
  { provider: "first", id: "unique" },
  { provider: "first", id: "family/model" },
  { provider: "other", id: "first/unique" },
];

test("exact matching is case-insensitive and qualified names outrank bare IDs", () => {
  expect(resolveModelSelection("FIRST/UNIQUE", models, {})).toEqual({ reference: { provider: "first", id: "unique" } });
  expect(resolveModelSelection("FAMILY/MODEL", models, {})).toEqual({ reference: { provider: "first", id: "family/model" } });
  expect(resolveModelSelection("UNIQUE", models, {})).toEqual({ reference: { provider: "first", id: "unique" } });
});

test("ambiguous bare IDs fail instead of picking a provider, including through roles and effort suffixes", () => {
  expect(() => resolveModelSelection("shared", models, {})).toThrow(/ambiguous/i);
  expect(() => resolveModelSelection("shared:high", models, {})).toThrow(/ambiguous/i);
  expect(() => resolveModelSelection("@review", models, { review: "shared" })).toThrow(/ambiguous/i);
  expect(resolveModelSelection("second/shared", models, {})).toEqual({ reference: { provider: "second", id: "shared" } });
});

test("unknown selectors never fuzzy-match or fall back to a provider", () => {
  expect(() => resolveModelSelection("uniq", models, {})).toThrow(/unknown model/i);
  expect(() => resolveModelSelection("missing/unique", models, {})).toThrow(/unknown model/i);
  expect(() => resolveModelSelection("", models, {})).toThrow(/unknown model/i);
});

test("literal colon IDs take precedence, but can themselves receive an effort suffix", () => {
  const catalog = [
    { provider: "fixture", id: "model" },
    { provider: "fixture", id: "model:low" },
    { provider: "fixture", id: "model:custom" },
  ];
  expect(resolveModelSelection("fixture/model:low", catalog, {})).toEqual({ reference: catalog[1] });
  expect(resolveModelSelection("model:low", catalog, {})).toEqual({ reference: catalog[1] });
  expect(resolveModelSelection("model:custom", catalog, {})).toEqual({ reference: catalog[2] });
  expect(resolveModelSelection("model:low:high", catalog, {})).toEqual({ reference: catalog[1], effort: "high" });
  expect(resolveModelSelection("@fast", catalog, { fast: "model:low" })).toEqual({ reference: catalog[1], role: "fast" });
});

test("ambiguous literal colon IDs are not reinterpreted as effort suffixes", () => {
  const catalog = [
    { provider: "first", id: "model" },
    { provider: "first", id: "model:low" },
    { provider: "second", id: "model:low" },
  ];
  expect(() => resolveModelSelection("model:low", catalog, {})).toThrow(/ambiguous/i);
});

test("outer effort overrides alias defaults while the requested role is retained", () => {
  const roles: ModelRoles = { review: "@reason:medium", reason: "first/unique:high" };
  expect(resolveModelSelection("@review", models, roles)).toEqual({ reference: models[2], role: "review", effort: "medium" });
  expect(resolveModelSelection("@review:auto", models, roles)).toEqual({ reference: models[2], role: "review", effort: "auto" });
  expect(resolveModelSelection("@review:off", models, roles)).toEqual({ reference: models[2], role: "review", effort: "off" });
  expect(resolveModelSelection("@review:max", models, roles)).toEqual({ reference: models[2], role: "review", effort: "max" });
  expect(resolveModelSelection("@reason", models, roles)).toEqual({ reference: models[2], role: "reason", effort: "high" });
});

test("unknown effort suffixes fail even when an outer suffix would override them", () => {
  expect(() => resolveModelSelection("unique:extreme", models, {})).toThrow(/unknown effort/i);
  expect(() => resolveModelSelection("@fast:extreme", models, { fast: "unique" })).toThrow(/unknown effort/i);
  expect(() => resolveModelSelection("@fast:low", models, { fast: "unique:extreme" })).toThrow(/unknown effort/i);
  expect(() => resolveModelSelection("unique:", models, {})).toThrow(/unknown effort/i);
});

test("@default resolves the saved provider exactly and participates in alias effort precedence", () => {
  const saved = { provider: "SECOND", id: "SHARED" };
  expect(resolveModelSelection("@default:low", models, {}, saved)).toEqual({ reference: models[1], role: "default", effort: "low" });
  expect(resolveModelSelection("@build:high", models, { build: "@default:auto" }, saved))
    .toEqual({ reference: models[1], role: "build", effort: "high" });
  expect(() => resolveModelSelection("@default", models, {})).toThrow(/no saved default/i);
  expect(() => resolveModelSelection("@default", models, {}, { provider: "missing", id: "shared" })).toThrow(/unavailable/i);
});

test("roles are independent and have no implicit model picks or alternate aliases", () => {
  expect(() => resolveModelSelection("@build", models, { fast: "unique" })).toThrow(/not configured/i);
  expect(() => resolveModelSelection("@fast", models, { fast: "  " })).toThrow(/not configured/i);
  expect(() => resolveModelSelection("@smol", models, { fast: "unique" })).toThrow(/unknown model role/i);
  expect(() => resolveModelSelection("@slow", models, { reason: "unique" })).toThrow(/unknown model role/i);
});

test("all four roles can form a valid chain but self-references and cycles fail", () => {
  const roles: ModelRoles = { fast: "@build", build: "@reason", reason: "@review", review: "unique:low" };
  expect(resolveModelSelection("@fast", models, roles)).toEqual({ reference: models[2], role: "fast", effort: "low" });
  expect(() => resolveModelSelection("@fast", models, { fast: "@fast:high" })).toThrow(/cyclic/i);
  expect(() => resolveModelSelection("@fast", models, { ...roles, review: "@fast:auto" })).toThrow(/cyclic/i);
  expect(() => resolveModelSelection("@build", models, { build: "@reason", reason: "@review", review: "@reason" })).toThrow(/cyclic/i);
});
