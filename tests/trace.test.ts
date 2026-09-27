import { expect, test } from "bun:test";
import { parseTrace, testResults, withoutAgentMarkers } from "../src/verify/trace";

test("per-test results are read from bun, jest/vitest and pytest -v output; the last result of a name wins", () => {
  const output = [
    "\x1b[32m(pass)\x1b[0m limiter > allows a burst [0.12ms]",
    "(fail) denies with the exact wait [1.00ms]",
    "  ✓ formats JPY (3 ms)",
    "  × rejects leading zeros 2ms",
    "tests/test_x.py::test_split PASSED                                   [ 50%]",
    "(pass) denies with the exact wait [0.9ms]",
  ].join("\n");
  expect([...testResults(output)]).toEqual([
    ["limiter > allows a burst", "pass"], ["denies with the exact wait", "pass"], ["formats JPY", "pass"], ["rejects leading zeros", "fail"], ["test_split", "pass"],
  ]);
});

test("the mapping keeps only listed tests; an answer that is not the requirement list is rejected", () => {
  const listed = new Set(["a", "b"]);
  expect(parseTrace('Here: {"requirements":[{"text":" exact wait ","tests":["a","zzz","a"]},{"text":"cap","tests":[]}]}', listed))
    .toEqual([{ text: "exact wait", tests: ["a"] }, { text: "cap", tests: [] }]);
  expect(parseTrace("no json", listed)).toBeUndefined();
  expect(parseTrace('{"requirements":[]}', listed)).toBeUndefined();
  expect(parseTrace('{"requirements":[{"tests":["a"]}]}', listed)).toBeUndefined();
});

test("agent markers that make Bun hide passing tests are removed; everything else is kept", () => {
  expect(withoutAgentMarkers({ AGENT: "1", CLAUDECODE: "1", CODEX_SANDBOX: "x", PATH: "/bin", AGENTS: "keep" })).toEqual({ PATH: "/bin", AGENTS: "keep" });
});
