import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BROWSER_ACTION_FIELDS, BROWSER_ACTIONS, BROWSER_FIELDS, browserArguments, webURL } from "../src/browser/arguments";
import { parseScenario } from "../src/browser/scenario";
import { BrowserSession } from "../src/browser/session";
import { browserTool, BROWSER_USAGE } from "../src/browser/tools";

// The shape a model sent seven times in a row: every schema field filled, most with placeholders.
const everyField = {
  action: "serve", url: "http://127.0.0.1:3000", script: "dev", width: 1280, height: 800, id: "",
  scenario: { name: "", url: "", viewport: { width: 1280, height: 800 }, scope: { inputs: [], exclude: [] }, steps: [],
    assertions: [{ kind: "visible", selector: "body", expected: "", other: "" }] },
  selector: "", value: "", reason: "Start the dev server to look at the page.", impact: "local-test",
};

test("a serve call carrying every schema field keeps serve's fields and names the ignored ones", () => {
  const { action, args, ignored } = browserArguments(everyField);
  expect(action).toBe("serve");
  expect(args).toEqual({ action: "serve", url: "http://127.0.0.1:3000", script: "dev", reason: "Start the dev server to look at the page.", impact: "local-test" });
  expect(ignored).toEqual(["width", "height", "scenario"]);
});

test("the tool runs that serve call instead of rejecting it, and says what it did not apply", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-browser-args-")));
  try {
    const session = new BrowserSession({ projectRoot: root, stateDirectory: root });
    const result = await browserTool(session).execute(everyField);
    // No package.json here, so serve itself fails: the arguments got past validation.
    expect(result.text).not.toContain("Unexpected browser arguments");
    expect(result.text).not.toContain("Unknown browser argument");
    await session.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown fields and actions get errors that say what to send", () => {
  expect(() => browserArguments({ action: "open", target: "http://localhost:3000" })).toThrow('Unknown browser argument "target"; open takes url');
  expect(() => browserArguments({ action: "open", url: "http://localhost:3000", executablePath: "/bin/sh" })).toThrow("Unknown browser argument");
  expect(() => browserArguments({ action: "navigate", url: "http://localhost:3000" })).toThrow("Unknown browser action \"navigate\"; use one of: open,");
  expect(() => browserArguments({ action: "replay", id: "abc", scenario: {} })).toThrow("replay runs the recorded scenario unchanged");
  expect(browserArguments({ action: "replay", id: "abc", scenario: null }).args).toEqual({ action: "replay", id: "abc" });
});

test("a scheme-less loopback address opens as http; other bad URLs say what is expected", () => {
  expect(webURL("127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
  expect(webURL("localhost:5173/app")).toBe("http://localhost:5173/app");
  expect(() => webURL("")).toThrow("Browser url is missing");
  expect(() => webURL("file:///etc/passwd")).toThrow("HTTP(S) URL without credentials");
  expect(() => webURL("http://user:pass@localhost")).toThrow("without credentials");
  expect(() => webURL("example.com")).toThrow("full HTTP(S) URL like http://localhost:3000");
});

test("a check scenario with blank placeholder fields parses; a real stray field is named", () => {
  const scenario = parseScenario({ name: "Result shows", url: "127.0.0.1:3000", viewport: { width: 0, height: 0 }, scope: { inputs: [], exclude: [] },
    steps: [{ action: "click", selector: "#go", value: "", impact: "local-test", reason: "Synthetic click" }],
    assertions: [{ kind: "visible", selector: "#result", expected: "", other: "" }, { kind: "no-horizontal-overflow", selector: "", expected: "", other: "" }] });
  expect(scenario).toEqual({ name: "Result shows", url: "http://127.0.0.1:3000/", viewport: { width: 1280, height: 800 },
    steps: [{ action: "click", selector: "#go", impact: "local-test", reason: "Synthetic click" }],
    assertions: [{ kind: "visible", selector: "#result" }, { kind: "no-horizontal-overflow" }] });
  expect(() => parseScenario({ name: "x", url: "http://localhost:3000", steps: [], assertions: [{ kind: "visible", selector: "#a", expected: "10.0.0.0" }] }))
    .toThrow('Browser scenario assertion 1 (visible) does not take "expected"; it takes kind, selector');
  expect(() => parseScenario({ name: "", url: "http://localhost:3000", steps: [], assertions: [{ kind: "no-horizontal-overflow" }] })).toThrow("Browser scenario name is missing");
});

test("the schema and description list exactly the fields the validator reads", () => {
  const tool = browserTool(() => { throw new Error("not opened"); });
  const schema = tool.inputSchema as { properties: Record<string, { enum?: string[] }> };
  expect(Object.keys(schema.properties).sort()).toEqual(["action", ...BROWSER_FIELDS].sort());
  expect(schema.properties.action!.enum).toEqual(BROWSER_ACTIONS);
  for (const [action, fields] of Object.entries(BROWSER_ACTION_FIELDS)) {
    expect(BROWSER_USAGE).toContain(fields.length ? `${action} takes ${fields.join(", ")}` : `${action} takes no other fields`);
  }
  expect(tool.description).toContain(BROWSER_USAGE);
});
