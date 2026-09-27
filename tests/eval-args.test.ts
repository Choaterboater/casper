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

test("--harness takes the Casper variants: casper (as shipped, review off), casper-no-review and casper-review", () => {
  const options = parseArguments(["--harness", "casper", "--harness", "casper-no-review", "--harness", "casper-review", "--model", "github-copilot/gpt-5-mini"]);
  expect(options.harnesses).toEqual(["casper", "casper-no-review", "casper-review"]);
  expect(() => parseArguments(["--harness", "casper-reviewed", "--model", "github-copilot/gpt-5-mini"])).toThrow("casper-no-review, casper-review, pi, omp");
});

test("--stop-when-decided names a Casper harness of the benchmark; --keep-workspaces is benchmark-only", () => {
  const model = ["--model", "github-copilot/gpt-5-mini"];
  expect(parseArguments(bench(...model, "--stop-when-decided", "casper", "--keep-workspaces", "kept"))).toMatchObject({ stopWhenDecided: "casper", keepWorkspaces: "kept" });
  // Pi has no receipt to decide on; a harness not in the run decides nothing.
  expect(() => parseArguments(bench(...model, "--stop-when-decided", "pi"))).toThrow("must name a Casper harness of this benchmark");
  expect(() => parseArguments(bench(...model, "--stop-when-decided", "casper-review"))).toThrow("must name a Casper harness of this benchmark");
  expect(() => parseArguments(bench(...model, "--stop-when-decided"))).toThrow("--stop-when-decided needs the Casper harness");
  expect(() => parseArguments(["--keep-workspaces", "kept"])).toThrow("--keep-workspaces, --stop-when-decided, --casper, --pi and --omp apply only to a benchmark");
});

test("--replay takes its own options only and needs a results document", () => {
  const replay = parseArguments(["--replay", "a.json", "--replay", "b.json", "--json", "out.json", "--acceptance-model", "openrouter/x/y", "--acceptance-route", "Together",
    "--concurrency", "4", "--stop-when-decided"]);
  expect(replay).toMatchObject({ replays: ["a.json", "b.json"], acceptanceModel: "openrouter/x/y", acceptanceRoute: ["Together"], concurrency: 4, stopWhenDecided: true });
  expect(() => parseArguments(["--replay", "a.json"])).toThrow("--replay needs --json");
  expect(() => parseArguments(["--replay", "a.json", "--json", "o.json", "--harness", "casper"])).toThrow("--replay takes only");
  expect(() => parseArguments(["--replay", "a.json", "--json", "o.json", "--stop-when-decided", "casper"])).toThrow("takes no harness with --replay");
  expect(() => parseArguments(["--replay", "a.json", "--json", "o.json", "--model", "openrouter/x/y"])).toThrow("An openrouter --model needs --route");
  expect(() => parseArguments(["--replay", "a.json", "--json", "o.json", "--model", "a/b", "--acceptance-model", "a/c"])).toThrow("--acceptance-model or --model, not both");
});
