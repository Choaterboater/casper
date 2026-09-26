import { expect, test } from "bun:test";
import { parseArguments, recordedRoute } from "../tools/eval";

const bench = (...extra: string[]) => ["--harness", "casper", "--harness", "pi", ...extra];

test("an OpenRouter benchmark needs --route: unpinned, it measures which host each harness drew", () => {
  expect(() => parseArguments(bench("--model", "openrouter/z-ai/glm-5.3-flash")))
    .toThrow("OpenRouter benchmarks need --route <hosts>");
  expect(() => parseArguments(bench("--model", "openrouter/z-ai/glm-5.3-flash"))).toThrow("--route any");
  const pinned = parseArguments(bench("--model", "openrouter/z-ai/glm-5.3-flash", "--route", "Together, Novita"));
  expect(pinned.route).toEqual(["Together", "Novita"]);
  expect(recordedRoute(pinned)).toEqual(["Together", "Novita"]);
  // Other providers have no host choice and need no route.
  expect(recordedRoute(parseArguments(bench("--model", "github-copilot/gpt-5-mini")))).toBeNull();
});

test("--route any is the explicit escape hatch: no hosts pinned, recorded as unpinned", () => {
  const unpinned = parseArguments(bench("--model", "openrouter/z-ai/glm-5.3-flash", "--route", "any"));
  expect(unpinned.route).toBeUndefined();
  expect(recordedRoute(unpinned)).toBe("unpinned");
  expect(() => parseArguments(bench("--model", "github-copilot/gpt-5-mini", "--route", "any"))).toThrow("--route applies only to openrouter models");
  // "any" is a keyword, not a host name to pin next to real ones.
  expect(() => parseArguments(bench("--model", "openrouter/z-ai/glm-5.3-flash", "--route", "Together,any"))).toThrow("--route any");
});
