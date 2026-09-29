import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fastapiRules, mcpRules, ruleIds } from "../src/security/rules";

const rulesDir = path.join(import.meta.dir, "..", "src", "security", "rules");

test("Casper ships its own MIT semgrep rules, embedded, with a test case for every rule", () => {
  expect(ruleIds(mcpRules)).toEqual([
    "casper.mcp-tool-shell-from-input", "casper.mcp-tool-sql-from-input", "casper.tls-verify-off", "casper.yaml-load-unsafe",
    "casper.mcp-http-bind-all", "casper.mcp-tool-returns-secrets",
  ]);
  expect(ruleIds(fastapiRules)).toEqual(["casper.fastapi-cors-any-origin-with-credentials", "casper.fastapi-debug-on", "casper.fastapi-write-route-without-login"]);
  for (const [text, cases] of [[mcpRules, "mcp.py"], [fastapiRules, "fastapi.py"]] as const) {
    expect(text).toContain("SPDX-License-Identifier: MIT");
    const fixture = readFileSync(path.join(rulesDir, cases), "utf8");
    for (const id of ruleIds(text)) {
      expect(fixture).toContain(`# ruleid: ${id}`);
      expect(fixture).toContain(`# ok: ${id}`);
    }
  }
});

test("the MCP rules match both decorator styles the reference servers use", () => {
  expect(mcpRules).toContain("@$APP.tool(...)");
  expect(mcpRules).toContain("@$APP.tool\n");
  expect(mcpRules).toContain("@$APP.call_tool(...)");
  const fixture = readFileSync(path.join(rulesDir, "mcp.py"), "utf8");
  expect(fixture).toContain("@mcp.tool(annotations=");
  expect(fixture).toContain("@server.call_tool()");
});
