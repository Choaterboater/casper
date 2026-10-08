import { expect, test } from "bun:test";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { markdownTheme } from "../src/tui/format";
import { stablePrefixEnd, StreamingMarkdown } from "../src/tui/markdown-stream";
import { Transcript } from "../src/tui/transcript";

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
  "Nested:\n\n````md\ncode\n```\n\nmore code\n````\n\nDone.",
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

const plain = (lines: string[]) => lines;

test("fences inside list items and blockquotes keep the language title and the container indent; code has no side border", () => {
  const listed = plain(once("1. Install deps:\n   ```bash\n   npm install\n   ```\n2. Run it.", 40, false));
  expect(listed[0]).toBe("1. Install deps:");
  expect(listed[1]).toMatch(/^ {3}── bash ─+$/);
  expect(listed[2]).toBe("   npm install");
  expect(listed[3]).toMatch(/^ {3}─+$/);
  expect(listed[4]).toBe("2. Run it.");
  const first = plain(once("- ```sh\n  ls\n  ```", 40, false));
  expect(first[0]).toMatch(/^- ── sh ─+$/);
  expect(first[1]).toBe("  ls");
  const quoted = plain(once("> ```sh\n> ls\n> ```", 40, false));
  expect(quoted[0]).toMatch(/^│ ── sh ─+$/);
  expect(quoted[1]).toBe("│ ls");
  expect(quoted[2]).toMatch(/^│ ─+$/);
  for (const lines of [listed, first, quoted]) for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
  // Colour keeps the container's own styling outside the box.
  const colored = once("> ```sh\n> ls\n> ```", 40, true).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
  expect(plain(colored)).toEqual(quoted);
});

test("streaming a list or quote with a nested fence matches the one-shot render at every cut", () => {
  const docs = [
    "1. x\n\n   ```py\n   y\n   ```\n\n2. z\n",
    "- a\n- b\n\n  continued para\n\n- c\n",
    "1. Step:\n\n   ```sh\n   a\n\n   b\n   ```\n\nDone.\n",
    "> ```sh\n> ls\n>\n> pwd\n> ```\n\nAfter.\n",
  ];
  for (const color of [false, true]) {
    for (const doc of docs) {
      for (let cut = 1; cut < doc.length; cut++) {
        const live = new StreamingMarkdown(color, markdownTheme(color));
        live.setText(doc.slice(0, cut));
        expect(live.render(60)).toEqual(once(doc.slice(0, cut), 60, color));
        live.setText(doc);
        expect(live.render(60)).toEqual(once(doc, 60, color));
      }
    }
  }
});

test("a fenced block's title line spans the width; a long code line is cut at the edge only, every character kept", () => {
  const source = `const x = 1; // ${"word ".repeat(30)}END`;
  for (const width of [40, 80, 200]) {
    for (const doc of [`\`\`\`ts\n${source}\n\`\`\``, `1. Step:\n   \`\`\`ts\n   ${source}\n   \`\`\``]) {
      const lines = once(doc, width, false);
      const top = lines.findIndex(line => line.includes("── ts "));
      const margin = lines[top]!.indexOf("──");
      expect(visibleWidth(lines[top]!)).toBe(width);
      // No border, no indent added, no space dropped: the rows put together are the line as written.
      const rows = lines.slice(top + 1, -1).map(line => line.slice(margin));
      expect(rows.join("")).toBe(source);
      for (const row of rows.slice(0, -1)) expect(visibleWidth(row)).toBe(width - margin);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  }
});

test("a long code line with emoji or CJK characters is cut between characters, never wider than the screen", () => {
  const sources = [
    "console.log(`Deployment finished for ${service.name} in ${region} after ${attempts} attempts 🚀 see ${url}`);",
    `a${"中文字".repeat(12)}`,
    `${"✅ ok ".repeat(20)}END`,
  ];
  for (const source of sources) {
    for (let width = 10; width <= 120; width++) {
      const lines = once(`\`\`\`ts\n${source}\n\`\`\``, width, false);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      // Every character is kept: the rows put together are the line as written.
      expect(lines.slice(1, -1).join("")).toBe(source);
    }
  }
});

test("the transcript holds every block row to the screen width, also for a fence nested deeper than a narrow screen", () => {
  const doc = "> > > ```sh\n> > > ls -la\n> > > ```\n\n- a\n  - b\n    - c\n      ```sh\n      ls -la\n      ```\n";
  for (let width = 4; width <= 14; width++) {
    const transcript = new Transcript();
    const live = new StreamingMarkdown(false, markdownTheme(false));
    live.setText(doc);
    transcript.preview = live;
    const committed = new StreamingMarkdown(false, markdownTheme(false));
    committed.setText(doc);
    transcript.commit(committed);
    const lines = transcript.render(width);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

test("a star between words or digits prints as a star, while emphasis still works", () => {
  const text = once("So 2*3==6 and a*b stays, but *this* and **that** are styled; `x*y` too.", 80, false).join("\n");
  expect(text).toContain("2*3==6");
  expect(text).toContain("a*b");
  expect(text).toContain("x*y");
  expect(text).not.toContain("*this*");
  expect(text).not.toContain("**that**");
});
