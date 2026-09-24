import { expect, test } from "bun:test";
import { findTool, tools } from "../src/catalog";

const workspace = new Map([
  ["src/app.ts", "import { router } from './router';\nconst TODO = 1;\n// todo: tidy\n"],
  ["README.md", "# Demo\nTODO: write docs\n"],
  ["src/router.ts", "export const router = {};\r\n// nothing to do here\r\n"],
]);
const tool = () => {
  const found = findTool("search_files");
  expect(found).toBeDefined();
  return found!;
};
const text = (result: { content: readonly { text: string }[] }) => result.content.map((part) => part.text).join("");

test("search_files is registered in alphabetical catalog order", () => {
  expect(tools.map((entry) => entry.name)).toEqual(["read_file", "search_files"]);
});

test("schema: required non-empty query, bounded integer limit, boolean caseSensitive, no extras", () => {
  const schema = tool().inputSchema as unknown as { type: string; required: string[]; additionalProperties: boolean;
    properties: Record<string, { type: string; minLength?: number; minimum?: number; maximum?: number; description?: string }> };
  expect(schema.type).toBe("object");
  expect(schema.required).toEqual(["query"]);
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties).sort()).toEqual(["caseSensitive", "limit", "query"]);
  expect(schema.properties.query).toMatchObject({ type: "string", minLength: 1 });
  expect(schema.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 50 });
  expect(schema.properties.caseSensitive).toMatchObject({ type: "boolean" });
  for (const property of Object.values(schema.properties)) expect(property.description?.length ?? 0).toBeGreaterThan(0);
  expect(tool().description.length).toBeGreaterThan(10);
});

test("annotations mark it read-only, non-destructive, idempotent and closed-world", () => {
  expect(tool().annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});

test("matches are path:line: text, files in path order, case-insensitive by default", () => {
  const result = tool().call({ query: "todo" }, workspace);
  expect(result.isError).toBeUndefined();
  expect(text(result).split("\n")).toEqual([
    "README.md:2: TODO: write docs",
    "src/app.ts:2: const TODO = 1;",
    "src/app.ts:3: // todo: tidy",
  ]);
});

test("caseSensitive narrows matches and CRLF files report clean lines", () => {
  expect(text(tool().call({ query: "todo", caseSensitive: true }, workspace))).toBe("src/app.ts:3: // todo: tidy");
  expect(text(tool().call({ query: "nothing" }, workspace))).toBe("src/router.ts:2: // nothing to do here");
});

test("the query is literal text, not a regular expression", () => {
  const files = new Map([["a.txt", "a.b\naxb\n(x)"]]);
  expect(text(tool().call({ query: "a.b" }, files))).toBe("a.txt:1: a.b");
  expect(text(tool().call({ query: "(x)" }, files))).toBe("a.txt:3: (x)");
});

test("no matches is a normal result that names the query", () => {
  const result = tool().call({ query: "zebra" }, workspace);
  expect(result.isError).toBeUndefined();
  expect(text(result)).toContain("zebra");
});

test("limit caps matches (default 10) and says how many were left out", () => {
  const many = new Map([["log.txt", Array.from({ length: 30 }, (_, index) => `hit ${index}`).join("\n")]]);
  const defaults = text(tool().call({ query: "hit" }, many)).split("\n");
  expect(defaults).toHaveLength(11);
  expect(defaults[9]).toBe("log.txt:10: hit 9");
  expect(defaults[10]).toBe("… truncated (20 more matches)");
  const limited = text(tool().call({ query: "hit", limit: 3 }, many)).split("\n");
  expect(limited).toEqual(["log.txt:1: hit 0", "log.txt:2: hit 1", "log.txt:3: hit 2", "… truncated (27 more matches)"]);
});

test("total output never exceeds 4000 characters, even with long lines", () => {
  const long = new Map([["wide.txt", Array.from({ length: 60 }, () => `needle ${"x".repeat(5000)}`).join("\n")]]);
  const output = text(tool().call({ query: "needle", limit: 50 }, long));
  expect(output.length).toBeLessThanOrEqual(4000);
  expect(output).toContain("truncated");
  expect(output.split("\n")[0]!.startsWith("wide.txt:1: needle")).toBe(true);
});

test("invalid arguments are tool errors starting with 'Invalid arguments', never exceptions", () => {
  for (const args of [{}, { query: "" }, { query: 3 }, { query: "a", limit: 0 }, { query: "a", limit: 51 }, { query: "a", limit: 2.5 },
    { query: "a", caseSensitive: "yes" }, { query: "a", extra: true }, null, "query"]) {
    const result = tool().call(args, workspace);
    expect(result.isError).toBe(true);
    expect(text(result).startsWith("Invalid arguments")).toBe(true);
  }
});
