import { expect, test } from "bun:test";
import { markdownTheme } from "../src/tui/format";
import { stablePrefixEnd, StreamingMarkdown } from "../src/tui/markdown-stream";

const DOCS = [
  "Here is a plan:\n\n* first *item*\n* second **item** with `code`\n\n```ts\nconst x = 1;\n```\n\nDone.",
  "Para one.\n\nPara two with **bold**.\n\n- a\n- b\n\n> quote\n\nDone.",
  "# Title\n\nText.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter.",
  "Loose list:\n\n- one\n\n- two\n\nEnd.",
  "> quote\n>\n> more\n\nAfter.",
  "Before.\n\n$$x^2$$\n\nAfter.",
  "Before.\n\n$$\nx^2\n\ny^2\n$$\n\nAfter.",
  "Para.\n\n    code\n\nAfter.",
  "Before.\n\n    code\n\n    more\n\nAfter.",
  "See [text][id].\n\n[id]: http://example.com\n\nAfter.",
  "```ts\nconst x = 1;\n```\n\nDone now.",
  "Before.\n\n---\n\nAfter.",
  "- a\n  - b\n\n- c\n\nEnd.",
  "Setext\n====\n\nNext.",
  "See [link](http://x).\n\nNext paragraph.",
  "<div>\n\nhello\n\n</div>\n\nAfter.",
  "Before.\n\n```ts\nconst xs = [1];\n```\n\nAfter the fence.",
  "Open fence stays one block:\n\n```ts\nconst x = 1;\n",
  "No break yet, just a growing paragraph with **bold**.",
];

function once(text: string, width: number, color: boolean): string[] {
  const markdown = new StreamingMarkdown(color, markdownTheme(color));
  markdown.setText(text);
  return markdown.render(width);
}

test("a safe prefix stops before an open fence, indented continuation, or unresolved reference", () => {
  expect(stablePrefixEnd("Para.\n\nNext")).toBe("Para.\n\n".length);
  expect(stablePrefixEnd("Para.\n\n")).toBe(0);
  expect(stablePrefixEnd("Before.\n\n```ts\nconst x = 1;\n")).toBe("Before.\n\n".length);
  expect(stablePrefixEnd("Before.\n\n    code\n\n    more")).toBe("Before.\n\n".length);
  const linked = "See [text][id].\n\n[id]: http://example.com\n\nAfter.";
  expect(stablePrefixEnd(linked)).toBe(linked.indexOf("After."));
  expect(stablePrefixEnd("See [text][id].\n\nLater.")).toBe(0);
  expect(stablePrefixEnd("Before.\n\n```ts\nconst xs = [1];\n```\n\nAfter.")).toBeGreaterThan("Before.\n\n".length);
  expect(stablePrefixEnd("No break yet")).toBe(0);
});

test("chunked streaming matches a one-shot render, including color and a later width change", () => {
  for (const color of [false, true]) {
    for (const width of [40, 72]) {
      for (const doc of DOCS) {
        const live = new StreamingMarkdown(color, markdownTheme(color));
        for (let end = 1; end <= doc.length; end += 7) {
          const partial = doc.slice(0, end);
          live.setText(partial);
          expect(live.render(width)).toEqual(once(partial, width, color));
        }
        live.setText(doc);
        expect(live.render(width)).toEqual(once(doc, width, color));
        expect(live.render(width + 11)).toEqual(once(doc, width + 11, color));
      }
    }
  }
});
