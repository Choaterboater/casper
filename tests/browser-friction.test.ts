import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { parseScenario } from "../src/browser/scenario";
import { browserFixtures, browserTest } from "./support/browser-fixture";

/**
 * The browser calls a small model got refused in a real build, though what it meant was clear: a click with no
 * reason, a withdraw reason a little long, serve with no url, a text assertion with no selector.
 */

const { fixture } = browserFixtures();

test("a step or assertion without the optional parts parses: a step's reason is filled in, a text assertion may name no element", () => {
  const scenario = parseScenario({ name: "Search", url: "http://127.0.0.1:3000/market",
    steps: [{ action: "fill", selector: "[data-testid=market-search]", value: "git", impact: "local-test" }],
    assertions: [{ kind: "text", expected: "GitHub repo" }] });
  expect(scenario.steps[0]!.reason).toBe("fill [data-testid=market-search]");
  expect(scenario.assertions[0]).toEqual({ kind: "text", expected: "GitHub repo" });
});

test("serve with no url picks a free loopback port and says where", async () => {
  const f = await fixture();
  const served = await f.session.run({ action: "serve", script: "files", impact: "local-test" });
  const url = String(served.url);
  expect(served.ready).toBe(true);
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  expect(await (await fetch(url)).text()).toContain("Hello Casper");
});

browserTest("a click without a reason runs; a text assertion without a selector passes when one element reads exactly that", async () => {
  const f = await fixture();
  await writeFile(f.sourceFile, '<!doctype html><title>t</title><article><h3>GitHub repo</h3><p>Stars and forks</p></article><button id="go" onclick="this.textContent=\'Done\'">Go</button>');
  await f.session.run({ action: "open", url: f.url });
  expect(await f.session.run({ action: "click", selector: "#go", impact: "local-test" })).toBeTruthy();
  const check = await f.session.run({ action: "check", scenario: { name: "Card title", url: f.url, steps: [],
    assertions: [{ kind: "text", expected: "GitHub repo" }, { kind: "text", expected: "GitLab repo" }] } });
  expect(check).toMatchObject({ status: "fail", assertions: [{ status: "pass" }, { status: "fail" }] });
}, 30_000);

browserTest("a withdraw reason over the limit is cut to fit, not refused", async () => {
  const f = await fixture();
  const check = await f.session.run({ action: "check", scenario: { name: "Wrong heading", url: f.url, steps: [], assertions: [{ kind: "text", selector: "h1", expected: "Nope" }] } });
  const reason = `Recorded against the old server on port 49440, which no longer runs.\nIt asserted a card the current check set covers. ${"More words. ".repeat(30)}`;
  const withdrawn = await f.session.run({ action: "withdraw", id: check.id, reason });
  expect(withdrawn.status).toBe("withdrawn");
  expect(Buffer.byteLength(String(withdrawn.reason))).toBeLessThanOrEqual(200);
  expect(String(withdrawn.reason)).toStartWith("Recorded against the old server on port 49440, which no longer runs. It asserted");
}, 30_000);
