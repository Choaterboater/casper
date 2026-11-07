import { expect, test } from "bun:test";
import path from "node:path";
import { cutAtLine, editPairs, endUpdate, fence, grepShape, patchDiffs, pathsShape, readShape, startUpdate, stepFacts, webShape, wholeTail, MAX_DIFF_SIDE_BYTES } from "../src/acp/tool-content";
import { hider, UpdateMapper } from "../src/acp/updates";
import { fileTextHoldsSecret, onlyNetconanChecks } from "../src/secrets/tool-output";

// What an ACP client is shown of each tool step (decision 79).
const CWD = path.resolve("/work/project");
/** Casper's rules for a file's text, without any login file of the machine running the tests. */
const rules = { holdsSecret: (file: string, text: string) => fileTextHoldsSecret(file, text, { loginFile: path.join(CWD, "no-such-auth.json"), env: {} }) };
const mapper = (values: string[] = []) => new UpdateMapper(hider(() => values), { cwd: () => CWD, holdsSecret: rules.holdsSecret });
const content = (update: Record<string, any>) => update.content as Array<Record<string, any>>;

test("patchDiffs: each hunk is a diff with its new start line; \\ No newline ends a side bare; a removed line may start with --", () => {
  const patch = [
    "Index: a.txt", "===================================================================", "--- a.txt", "+++ a.txt",
    "@@ -1,3 +1,3 @@", " one", "--- a dashed line", "+++ a plus line", " three",
    "@@ -10,2 +10,2 @@", " ten", "-eleven", "\\ No newline at end of file", "+ELEVEN", "\\ No newline at end of file", "",
  ].join("\n");
  expect(patchDiffs(patch)).toEqual([
    { oldText: "one\n-- a dashed line\nthree\n", newText: "one\n++ a plus line\nthree\n", line: 1 },
    { oldText: "ten\neleven", newText: "ten\nELEVEN", line: 10 },
  ]);
});

test("an edit's replacements come from its edits[], a JSON string of them, one object or the old single pair", () => {
  const pair = { oldText: "a", newText: "b" };
  expect(editPairs({ edits: [pair, { oldText: "c", newText: "d" }] })).toEqual([pair, { oldText: "c", newText: "d" }]);
  expect(editPairs({ edits: JSON.stringify([pair]) })).toEqual([pair]);
  expect(editPairs({ edits: pair })).toEqual([pair]);
  expect(editPairs({ oldText: "a", newText: "b" })).toEqual([pair]);
  expect(editPairs({ edits: "not json" })).toEqual([]);
});

test("an edit starts with one diff per replacement and ends with the patch's hunks; without a patch it falls back to edits[]", () => {
  const facts = stepFacts({ toolName: "edit", input: { path: "src/sum.js" }, args: { path: "src/sum.js", edits: [{ oldText: "a - b", newText: "a + b" }] } }, CWD);
  const file = path.join(CWD, "src/sum.js");
  const start = startUpdate("casper-tool-1", facts, rules);
  expect(start).toMatchObject({ title: "edit src/sum.js", kind: "edit", locations: [{ path: file }], content: [{ type: "diff", path: file, oldText: "a - b", newText: "a + b" }],
    _meta: { casper: { tool: "edit", target: "src/sum.js" } } });
  const patch = "--- src/sum.js\n+++ src/sum.js\n@@ -4,1 +4,1 @@\n-  return a - b;\n+  return a + b;\n";
  const end = endUpdate("casper-tool-1", facts, { isError: false, lines: { added: 1, removed: 1 }, diff: patch, display: { text: "ok", truncated: false, line: 4 } }, rules);
  expect(end).toMatchObject({ status: "completed", content: [{ type: "diff", path: file, oldText: "  return a - b;\n", newText: "  return a + b;\n" }],
    locations: [{ path: file, line: 4 }], rawOutput: { path: file, added: 1, removed: 1 } });
  const fallback = endUpdate("casper-tool-1", facts, { isError: false, display: { text: "ok", truncated: false, line: 4 } }, rules);
  expect(fallback).toMatchObject({ content: [{ type: "diff", path: file, oldText: "a - b", newText: "a + b" }], locations: [{ path: file, line: 4 }] });
});

test("a write's diff: null old text for a new file, the old text for an overwrite, a note when the old file was too big", () => {
  const facts = stepFacts({ toolName: "write", input: { path: "notes.txt" }, args: { path: "notes.txt", content: "new\n" } }, CWD);
  const file = path.join(CWD, "notes.txt");
  expect(startUpdate("casper-tool-2", facts, rules)).toMatchObject({ kind: "edit", locations: [{ path: file }], rawInput: { path: "notes.txt", content: "new\n" } });
  expect(endUpdate("casper-tool-2", facts, { isError: false, lines: { added: 1, removed: 0 }, display: { text: "", truncated: false, before: null } }, rules))
    .toMatchObject({ content: [{ type: "diff", path: file, oldText: null, newText: "new\n" }], rawOutput: { path: file, added: 1, removed: 0, created: true } });
  expect(endUpdate("casper-tool-2", facts, { isError: false, lines: { added: 1, removed: 1 }, display: { text: "", truncated: false, before: "old\n" } }, rules))
    .toMatchObject({ content: [{ type: "diff", path: file, oldText: "old\n", newText: "new\n" }], rawOutput: { created: false } });
  // pi could not read the old file (over 1 MiB): no diff, never a "new file".
  const big = endUpdate("casper-tool-2", facts, { isError: false, display: { text: "", truncated: false } }, rules);
  expect(content(big)).toEqual([{ type: "content", content: { type: "text", text: "Changed notes.txt, too large to show here" } }]);
  expect(big.rawOutput).toMatchObject({ created: false });
});

test("a diff side over 256 KB is a note with the counts instead", () => {
  const huge = `${"x".repeat(80)}\n`.repeat(Math.ceil(MAX_DIFF_SIDE_BYTES / 81) + 1);
  const facts = stepFacts({ toolName: "write", input: { path: "big.txt" }, args: { path: "big.txt", content: huge } }, CWD);
  const end = endUpdate("casper-tool-3", facts, { isError: false, lines: { added: 3300, removed: 1 }, display: { text: "", truncated: false, before: "small\n" } }, rules);
  expect(content(end)).toEqual([{ type: "content", content: { type: "text", text: "Changed big.txt (+3300 −1), too large to show here" } }]);
});

test("a write that adds a secret shows no body anywhere: its arguments and its end say where, never the value", () => {
  const value = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const facts = stepFacts({ toolName: "write", input: { path: "deploy.sh", secretWritten: "deploy.sh", secretWhere: "line 2, a token or key" },
    args: { path: "deploy.sh", content: `#!/bin/sh\nTOKEN=${value}\n` } }, CWD);
  const start = startUpdate("casper-tool-4", facts, rules);
  expect(start.rawInput).toEqual({ path: "deploy.sh", content: "<not shown: adds a secret>" });
  const end = endUpdate("casper-tool-4", facts, { isError: false, lines: { added: 2, removed: 0 }, display: { text: "", truncated: false, before: null } }, rules);
  expect(content(end)).toEqual([{ type: "content", content: { type: "text", text: "Changed deploy.sh: not shown, it adds a secret at line 2, a token or key" } }]);
  expect(JSON.stringify([start, end])).not.toContain(value);
});

test("file text the scrubber would change is never shown, even when the write adds nothing new: a config holding a secret", () => {
  // Not an env-style line: a device config's secret, which only the config rules see.
  const config = "hostname r1\nsnmp-server community s3cr3t-c0mmunity RO\nenable secret 5 $1$abcd$0123456789abcdefghij\n";
  const facts = stepFacts({ toolName: "edit", input: { path: "configs/r1.cfg" }, args: { path: "configs/r1.cfg", edits: [{ oldText: "hostname r1", newText: "hostname r2" }] } }, CWD);
  const patch = `--- configs/r1.cfg\n+++ configs/r1.cfg\n@@ -1,3 +1,3 @@\n-hostname r1\n+hostname r2\n${config.split("\n").slice(1, 3).map((line) => ` ${line}`).join("\n")}\n`;
  const end = endUpdate("casper-tool-5", facts, { isError: false, lines: { added: 1, removed: 1 }, diff: patch, display: { text: "", truncated: false } }, rules);
  expect(content(end)).toEqual([{ type: "content", content: { type: "text", text: "Changed configs/r1.cfg (+1 −1): not shown, it holds a secret" } }]);
  expect(JSON.stringify(end)).not.toContain("s3cr3t-c0mmunity");
  // The same text written whole: no diff, and none of it in the arguments.
  const write = stepFacts({ toolName: "write", input: { path: "configs/r1.cfg" }, args: { path: "configs/r1.cfg", content: config } }, CWD);
  expect(startUpdate("casper-tool-6", write, rules).rawInput).toEqual({ path: "configs/r1.cfg", content: "<not shown: holds a secret>" });
  expect(JSON.stringify(endUpdate("casper-tool-6", write, { isError: false, display: { text: "", truncated: false, before: null } }, rules))).not.toContain("s3cr3t-c0mmunity");
});

test("while netconan is in use a device config's text is never shown, since only netconan may see its secret; other files still are", () => {
  // A line Casper's own rules miss and netconan hides (tests/secrets-netconan.test.ts).
  const config = "set system host-name edge1\nset services custom-app token Zq8LeakyToken\n";
  expect(fileTextHoldsSecret("configs/edge1.set", config, { loginFile: path.join(CWD, "no-such-auth.json"), env: {} })).toBe(false);
  const withNetconan = { ...rules, unchecked: (file: string) => onlyNetconanChecks(file, { netconan: true }) };
  const write = stepFacts({ toolName: "write", input: { path: "configs/edge1.set" }, args: { path: "configs/edge1.set", content: config } }, CWD);
  expect(startUpdate("casper-tool-1", write, withNetconan).rawInput).toEqual({ path: "configs/edge1.set", content: "<not shown: a device config netconan checks>" });
  const written = endUpdate("casper-tool-1", write, { isError: false, lines: { added: 2, removed: 1 }, display: { text: "", truncated: false, before: config } }, withNetconan);
  expect(content(written)).toEqual([{ type: "content", content: { type: "text", text: "Changed configs/edge1.set (+2 −1): not shown, netconan checks this device config only as the AI reads it" } }]);
  // An edit: neither its replacements at the start nor its patch's context lines at the end.
  const edit = stepFacts({ toolName: "edit", input: { path: "configs/edge1.set" }, args: { path: "configs/edge1.set", edits: [{ oldText: "edge1", newText: "edge2" }] } }, CWD);
  const patch = "--- configs/edge1.set\n+++ configs/edge1.set\n@@ -1,2 +1,2 @@\n-set system host-name edge1\n+set system host-name edge2\n set services custom-app token Zq8LeakyToken\n";
  const started = startUpdate("casper-tool-2", edit, withNetconan);
  const ended = endUpdate("casper-tool-2", edit, { isError: false, lines: { added: 1, removed: 1 }, diff: patch, display: { text: "", truncated: false } }, withNetconan);
  expect(started.content).toBeUndefined();
  expect(JSON.stringify([written, started, ended])).not.toContain("Zq8LeakyToken");
  // Without netconan the same diff is shown, and with it a file that is no device config is too.
  expect(content(endUpdate("casper-tool-3", edit, { isError: false, diff: patch, display: { text: "", truncated: false } }, rules))[0]).toMatchObject({ type: "diff" });
  const code = stepFacts({ toolName: "write", input: { path: "src/a.js" }, args: { path: "src/a.js", content: "x\n" } }, CWD);
  expect(content(endUpdate("casper-tool-4", code, { isError: false, display: { text: "", truncated: false, before: null } }, withNetconan))[0]).toMatchObject({ type: "diff" });
  expect(onlyNetconanChecks("configs/edge1.set", { netconan: false })).toBe(false);
  expect(onlyNetconanChecks("configs/edge1.set", { netconan: true, configs: false })).toBe(false);
});

test("grep's matches are grouped by file; find's and ls's paths are listed; a limit notice marks them truncated", () => {
  expect(grepShape("src/a.js:3: const sum = 1\nsrc/a.js-4- context\nsrc/a.js:9: sum()\nlib/b.js:1: sum\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]", false)).toEqual({
    shape: "matches", total: 3, truncated: true,
    files: [{ path: "src/a.js", matches: [{ lineNumber: 3, line: "const sum = 1" }, { lineNumber: 9, line: "sum()" }] }, { path: "lib/b.js", matches: [{ lineNumber: 1, line: "sum" }] }],
  });
  expect(grepShape("No matches found", false)).toEqual({ shape: "matches", files: [], total: 0, truncated: false });
  expect(pathsShape("src/\nsum.js\nREADME.md", false)).toEqual({ shape: "paths", paths: ["src/", "sum.js", "README.md"], total: 3, truncated: false });
  expect(pathsShape("(empty directory)", false)).toEqual({ shape: "paths", paths: [], total: 0, truncated: false });
  expect(pathsShape("a.js\n\n[1000 results limit reached]", false)).toMatchObject({ paths: ["a.js"], truncated: true });
});

test("a read shows its lines in a fence with where it started and the file's length; a picture says so", () => {
  expect(readShape("a\nb\nc", {}, "/p/x.js", false)).toEqual({ path: "/p/x.js", offset: 1, lines: 3, totalLines: 3, truncated: false });
  expect(readShape("a\nb\n\n[Showing lines 5-6 of 40. Use offset=7 to continue.]", { offset: 5 }, "/p/x.js", false)).toEqual({ path: "/p/x.js", offset: 5, lines: 2, totalLines: 40, truncated: true });
  expect(readShape("a\n\n[3 more lines in file. Use offset=3 to continue.]", { offset: 2, limit: 1 }, "/p/x.js", false)).toEqual({ path: "/p/x.js", offset: 2, lines: 1, totalLines: 5, truncated: true });
  expect(readShape("Read image file [image/png]", {}, "/p/x.png", false)).toEqual({ path: "/p/x.png", offset: 1, truncated: false, image: true });
  const facts = stepFacts({ toolName: "read", input: { path: "sum.js" }, args: { path: "sum.js", offset: 2 } }, CWD);
  expect(startUpdate("casper-tool-7", facts, rules).locations).toEqual([{ path: path.join(CWD, "sum.js"), line: 2 }]);
  const end = endUpdate("casper-tool-7", facts, { isError: false, display: { text: "return a + b;\n}", truncated: false } }, rules);
  expect(content(end)[0]!.content.text).toBe("```text\nreturn a + b;\n}\n```");
  // A read the scrubber changed (what the model got had a secret hidden) is not shown.
  const scrubbed = endUpdate("casper-tool-7", facts, { isError: false, display: { text: "password: <secret hidden>", truncated: false } }, rules);
  expect(content(scrubbed)[0]!.content.text).toBe("Read sum.js: not shown, it holds a secret");
});

test("web_search shows its sources and web_fetch its page, from their JSON results", () => {
  const search = JSON.stringify({ isError: false, summary: "Complete result.", truncated: false, data: { source: "web_search", provider: "DuckDuckGo", query: "node assert docs",
    results: [{ title: "Assert | Node.js", url: "https://nodejs.org/api/assert.html", snippet: "The node:assert module" }] } });
  expect(webShape("web_search", search)).toEqual({ query: "node assert docs", provider: "DuckDuckGo", truncated: false,
    sources: [{ url: "https://nodejs.org/api/assert.html", title: "Assert | Node.js", snippet: "The node:assert module" }] });
  const facts = stepFacts({ toolName: "web_search", input: { query: "node assert docs" }, args: { query: "node assert docs" } }, CWD);
  const end = endUpdate("casper-tool-8", facts, { isError: false, display: { text: search, truncated: false } }, rules);
  expect(end.rawOutput).toMatchObject({ sources: [{ url: "https://nodejs.org/api/assert.html" }] });
  expect(content(end)[0]!.content.text).toBe("- Assert | Node.js <https://nodejs.org/api/assert.html>");
  const fetch = JSON.stringify({ data: { source: "web_fetch", url: "https://example.com", finalUrl: "https://example.com/", status: 200, title: "Example", truncated: false, text: "Example Domain" } });
  expect(webShape("web_fetch", fetch)).toEqual({ url: "https://example.com/", statusCode: 200, title: "Example", truncated: false, text: "Example Domain" });
  expect(webShape("web_fetch", "not json")).toBeUndefined();
});

test("a shell step ends with its output fenced and its exit code; a failed step always carries its error text", () => {
  const facts = stepFacts({ toolName: "bash", input: { command: "node -e 'process.exit(3)'" }, description: "Exit with three", args: { command: "node -e 'process.exit(3)'", description: "Exit with three" } }, CWD);
  expect(startUpdate("casper-tool-9", facts, rules)).toMatchObject({ kind: "execute", _meta: { casper: { tool: "bash", description: "Exit with three" } } });
  const end = endUpdate("casper-tool-9", facts, { isError: true, display: { text: "5\n\nCommand exited with code 3", truncated: false, exitCode: 3 } }, rules);
  expect(end).toMatchObject({ status: "failed", rawOutput: { exitCode: 3, truncated: false } });
  expect(content(end)[0]!.content.text).toBe("```text\n5\n\nCommand exited with code 3\n```");
  const failed = endUpdate("casper-tool-10", stepFacts({ toolName: "grep", input: { pattern: "x" }, args: { pattern: "x" } }, CWD), { isError: true, display: { text: "Path not found: nope", truncated: false } }, rules);
  expect(content(failed)[0]!.content.text).toBe("Path not found: nope");
  const silent = endUpdate("casper-tool-11", stepFacts({ toolName: "read", input: { path: "a" }, args: { path: "a" } }, CWD), { isError: true }, rules);
  expect(content(silent)[0]!.content.text).toBe("read failed.");
});

test("cuts are made at whole lines: a long argument, and the head and tail of an output the runtime cut", () => {
  const long = `${"line\n".repeat(20)}`;
  const cut = cutAtLine(long, 23);
  expect(cut.cut).toBe(true);
  expect(cut.text).toBe("line\nline\nline\nline\n[... 80 more bytes not shown]");
  expect(cutAtLine("short", 23)).toEqual({ text: "short", cut: false });
  expect(wholeTail("first line\nhalf a sk-abc\n[...output truncated...]\ndef0123456789 tail\nlast line")).toBe("first line\n[...output truncated...]\nlast line");
  expect(fence("a ``` b")).toBe("````text\na ``` b\n````");
});

test("rawInput is the model's arguments, hidden; the tool name is in _meta.casper.tool, and a shell command is the one Casper keeps", () => {
  const value = "my-own-secret-value-42";
  const map = mapper([value]);
  const [start] = map.runtime({ type: "tool_start", toolName: "bash", toolCallId: "call_1", input: { command: "curl -H 'x: <secret hidden>' example.com" },
    args: { command: `curl -H 'x: ${value}' example.com`, timeout: 30, [value]: "a key the model named" } });
  expect(start).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "casper-tool-1", rawInput: { command: "curl -H 'x: <secret hidden>' example.com", timeout: 30 },
    _meta: { casper: { tool: "bash" } } });
  expect(start!.rawInput).not.toHaveProperty("tool");
  expect(JSON.stringify(start)).not.toContain(value);
  const [end] = map.runtime({ type: "tool_end", toolName: "bash", toolCallId: "call_1", isError: false, display: { text: `printed ${value}\n`, truncated: false, exitCode: 0 } });
  expect(end).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "casper-tool-1", status: "completed", rawOutput: { exitCode: 0 } });
  expect(JSON.stringify(end)).not.toContain(value);
});

test("an MCP call names its server and tool in _meta.casper.mcp", () => {
  const map = new UpdateMapper((text) => text, { cwd: () => CWD, holdsSecret: () => false,
    mcpTool: (name, args) => name === "call_capability" && args.id === "mcp:acp-app:present" ? { server: "acp-app", tool: "present" } : undefined });
  const [start] = map.runtime({ type: "tool_start", toolName: "call_capability", toolCallId: "c", input: {}, args: { id: "mcp:acp-app:present", arguments: {} } });
  expect(start).toMatchObject({ title: "call_capability", kind: "other", _meta: { casper: { tool: "call_capability", mcp: { server: "acp-app", tool: "present" } } } });
});

test("A running edit gives a box its hidden diffs, bash and write give none, an ended step gives nothing, and an edit holding a secret gives none", () => {
  const value = "my-own-secret-value-42";
  const map = mapper([value]);
  const file = path.join(CWD, "src/sum.js");
  map.runtime({ type: "tool_start", toolName: "edit", toolCallId: "call_edit", input: { path: "src/sum.js" },
    args: { path: "src/sum.js", edits: [{ oldText: "a - b", newText: `a + b // ${value}` }] } });
  // The diffs as the start showed them: hidden, with the edit's file.
  expect(map.step("call_edit")).toEqual({ id: "casper-tool-1", diffs: [{ type: "diff", path: file, oldText: "a - b", newText: "a + b // <secret hidden>" }], locations: [{ path: file }] });
  // A copy: changing what a box got changes nothing the next box gets.
  map.step("call_edit")!.diffs.length = 0;
  expect(map.step("call_edit")!.diffs).toHaveLength(1);
  // A shell step has no diff and no file; a write has its file but no diff.
  map.runtime({ type: "tool_start", toolName: "bash", toolCallId: "call_bash", input: { command: "ls" }, args: { command: "ls" } });
  expect(map.step("call_bash")).toEqual({ id: "casper-tool-2", diffs: [] });
  map.runtime({ type: "tool_start", toolName: "write", toolCallId: "call_write", input: { path: "notes.txt" }, args: { path: "notes.txt", content: "new\n" } });
  expect(map.step("call_write")).toEqual({ id: "casper-tool-3", diffs: [], locations: [{ path: path.join(CWD, "notes.txt") }] });
  // The ask tool's step is still found by its tool.
  map.runtime({ type: "tool_start", toolName: "ask", toolCallId: "call_ask", input: {}, args: {} });
  expect(map.runningStep("ask")).toBe("casper-tool-4");
  // An ended step gives nothing, and an id never seen gives nothing.
  map.runtime({ type: "tool_end", toolName: "edit", toolCallId: "call_edit", isError: false, display: { text: "ok", truncated: false } });
  expect(map.step("call_edit")).toBeUndefined();
  expect(map.step("call_other")).toBeUndefined();
  // An edit whose text holds a secret by the file's own rules starts with no diff, so its box gets none.
  map.runtime({ type: "tool_start", toolName: "edit", toolCallId: "call_config", input: { path: "configs/r1.cfg" },
    args: { path: "configs/r1.cfg", edits: [{ oldText: "hostname r1", newText: "snmp-server community s3cr3t-c0mmunity RO" }] } });
  expect(map.step("call_config")).toEqual({ id: "casper-tool-5", diffs: [], locations: [{ path: path.join(CWD, "configs/r1.cfg") }] });
  expect(JSON.stringify(map.step("call_config"))).not.toContain("s3cr3t-c0mmunity");
});
