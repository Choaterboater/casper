import { expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BROWSER_ACTION_FIELDS, BROWSER_ACTIONS, BROWSER_FIELDS, browserArguments, webURL } from "../src/browser/arguments";
import { parseScenario } from "../src/browser/scenario";
import { BrowserSession } from "../src/browser/session";
import { browserTool } from "../src/browser/tools";
import { removeTempDir } from "./support/temp-dir";

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
  } finally { await removeTempDir(root); }
});

test("unknown fields and actions get errors that say what to send", () => {
  expect(() => browserArguments({ action: "open", target: "http://localhost:3000" })).toThrow('Unknown browser argument "target"; open takes url');
  expect(() => browserArguments({ action: "open", url: "http://localhost:3000", executablePath: "/bin/sh" })).toThrow("Unknown browser argument");
  expect(() => browserArguments({ action: "navigate", url: "http://localhost:3000" })).toThrow("Unknown browser action \"navigate\"; use one of: open,");
  const real = { name: "Phone", url: "http://127.0.0.1:3000/", viewport: { width: 390, height: 844 }, steps: [], assertions: [{ kind: "visible", selector: "body" }] };
  expect(() => browserArguments({ action: "replay", id: "abc", scenario: real })).toThrow("replay runs the recorded scenario unchanged");
  expect(browserArguments({ action: "replay", id: "abc", scenario: null }).args).toEqual({ action: "replay", id: "abc" });
});

test("a replay call carrying the placeholder scenario every other call carries runs the recorded one; a real scenario is still refused", () => {
  // The same model sent this on replay thirteen times in a row and was refused each time, so it never replayed a check.
  const { args, ignored } = browserArguments({ ...everyField, action: "replay", id: "4ece8688" });
  expect(args).toEqual({ action: "replay", id: "4ece8688" });
  expect(ignored).toEqual(["url", "script", "width", "height", "scenario", "reason", "impact"]);
  expect(browserArguments({ action: "replay", id: "abc", scenario: {} }).args).toEqual({ action: "replay", id: "abc" });
  // A scenario with a name or a url is one the model means to run: replay does not take it.
  expect(() => browserArguments({ action: "replay", id: "abc", scenario: { ...everyField.scenario, url: "http://127.0.0.1:3000/" } }))
    .toThrow("replay runs the recorded scenario unchanged; send only action and id");
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

test("a check or the viewport action can use a wide screen up to 4K: 3840 × 2160", () => {
  // A person's window was about 3040 CSS px wide; the AI asked for it and was refused at 1920.
  const at = (width: number, height: number) => parseScenario({ name: "Wide", url: "http://localhost:3000", viewport: { width, height },
    steps: [], assertions: [{ kind: "no-horizontal-overflow" }] }).viewport;
  expect(at(3040, 1600)).toEqual({ width: 3040, height: 1600 });
  expect(at(3840, 2160)).toEqual({ width: 3840, height: 2160 });
  expect(at(240, 240)).toEqual({ width: 240, height: 240 });
  for (const [width, height] of [[3841, 1080], [1280, 2161], [239, 800], [1280, 239]]) {
    expect(() => at(width!, height!)).toThrow("Browser viewport must be 240–3840 wide and 240–2160 high");
  }
  expect(browserArguments({ action: "viewport", width: 3040, height: 1600 }).args).toEqual({ action: "viewport", width: 3040, height: 1600 });
});

test("select sets a <select> by an option's value or label, as an action and as a check step", () => {
  expect(BROWSER_ACTION_FIELDS.select).toEqual(["selector", "value", "impact", "reason"]);
  expect(browserArguments({ action: "select", selector: "#size", value: "Large", impact: "local-test", reason: "Pick a size" }).args)
    .toEqual({ action: "select", selector: "#size", value: "Large", impact: "local-test", reason: "Pick a size" });
  const step = { action: "select", selector: "#size", value: "lg", impact: "local-test", reason: "Pick a size" } as const;
  const scenario = (steps: unknown[]) => parseScenario({ name: "Size", url: "http://localhost:3000", assertions: [{ kind: "visible", selector: "#out" }], steps });
  expect(scenario([step]).steps).toEqual([step]);
  expect(() => scenario([{ ...step, value: undefined }])).toThrow("Browser scenario step 1 value is missing");
  expect(() => scenario([{ ...step, action: "hover" }])).toThrow("action must be click, fill, press or select");
  const schema = browserTool(() => { throw new Error("not opened"); }).inputSchema as { properties: { scenario: { properties: { steps: { items: { properties: { action: { enum: string[] } } } } } } } };
  expect(schema.properties.scenario.properties.steps.items.properties.action.enum).toEqual(["click", "fill", "press", "select"]);
});

test("no-horizontal-overflow is page-wide, or for one element when a selector names it", () => {
  const scoped = parseScenario({ name: "Phone", url: "http://localhost:3000", steps: [],
    assertions: [{ kind: "no-horizontal-overflow", selector: ".results" }, { kind: "no-horizontal-overflow" }] });
  expect(scoped.assertions).toEqual([{ kind: "no-horizontal-overflow", selector: ".results" }, { kind: "no-horizontal-overflow" }]);
  expect(() => parseScenario({ name: "x", url: "http://localhost:3000", steps: [], assertions: [{ kind: "no-horizontal-overflow", expected: "0" }] }))
    .toThrow('Browser scenario assertion 1 (no-horizontal-overflow) does not take "expected"; it takes kind, selector');
});

test("the schema lists exactly the fields the validator reads, and each field names the actions that take it", () => {
  const tool = browserTool(() => { throw new Error("not opened"); });
  const schema = tool.inputSchema as { properties: Record<string, { enum?: string[]; description?: string }> };
  expect(Object.keys(schema.properties).sort()).toEqual(["action", ...BROWSER_FIELDS].sort());
  expect(schema.properties.action!.enum).toEqual(BROWSER_ACTIONS);
  for (const field of BROWSER_FIELDS.filter((name) => !["selector", "value", "impact", "reason"].includes(name))) {
    const takers = BROWSER_ACTIONS.filter((action) => (BROWSER_ACTION_FIELDS[action] as readonly string[]).includes(field));
    expect({ field, note: schema.properties[field]!.description?.startsWith(`${takers.join(", ")}`) }).toEqual({ field, note: true });
  }
  expect(tool.description).toContain("Send only the fields your action takes");
  // The four fields shared by click, fill, press and serve are named in the description instead.
  expect(tool.description).toContain("click, fill, press and select take a CSS selector (all but click a value too); these and serve take impact (reason optional)");
  // The policy the model needs before it acts stays; the rest is said when an action is refused.
  for (const rule of ["untrusted data", "BEFORE editing", "easier one", "not verification", "local-test", "localhost", "asks the user"]) expect(tool.description).toContain(rule);
});

test("one check may list up to eight assertions; the tool schema and the parser agree", () => {
  const assertions = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "text", selector: `#row-${i}`, expected: `row ${i}` }));
  const scenario = (n: number) => ({ name: "Month summary", url: "http://127.0.0.1:3000", steps: [], assertions: assertions(n) });
  expect(parseScenario(scenario(8)).assertions).toHaveLength(8);
  expect(() => parseScenario(scenario(9))).toThrow("1–8 assertions");
  expect(() => parseScenario(scenario(0))).toThrow("1–8 assertions");
  const schema = browserTool({} as BrowserSession).inputSchema as { properties: { scenario: { properties: { assertions: { maxItems: number } } } } };
  expect(schema.properties.scenario.properties.assertions.maxItems).toBe(8);
});
