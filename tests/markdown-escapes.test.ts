import { expect, test } from "bun:test";
import { intentLine } from "../src/app/events";
import { stepTitle } from "../src/runtime/observation";
import { markdownTheme, unescapeCodeSpans } from "../src/tui/format";
import { StreamingMarkdown } from "../src/tui/markdown-stream";

/** A v0.4.3 session showed `casper\_check` and `\~/.casper/config.yaml` with their backslashes: the AI escapes Markdown
 * inside inline code, where Markdown keeps every backslash. */

const rendered = (text: string, color = false) => {
  const markdown = new StreamingMarkdown(color, markdownTheme(color), { hang: true });
  markdown.setText(text);
  return markdown.render(100).map((line) => Bun.stripANSI(line)).join("\n");
};

test("an answer's inline code shows casper_check and ~/.casper/config.yaml, not their escapes; prose already did", () => {
  expect(rendered("I ran `casper\\_check` · set `sandbox: on` in `\\~/.casper/config.yaml`.")).toBe("● I ran casper_check · set sandbox: on in ~/.casper/config.yaml.");
  expect(rendered("Running casper\\_check in \\~/x.")).toBe("● Running casper_check in ~/x.");
  // With colour on the same words reach the screen.
  expect(rendered("`casper\\_check`", true)).toBe("● casper_check");
});

test("code keeps the backslashes it means: a regex in inline code and everything in a fenced block", () => {
  expect(unescapeCodeSpans("match `a\\.b\\*` and `x\\_y`")).toBe("match `a\\.b\\*` and `x_y`");
  const fenced = "```bash\nls \\~/x \\_y\n```";
  expect(unescapeCodeSpans(fenced)).toBe(fenced);
  expect(rendered(fenced)).toContain("ls \\~/x \\_y");
});

test("the AI's words shown as plain text drop Markdown's escapes: a step's title and the status row's line", () => {
  expect(stepTitle("bash", { command: "npm test", description: "Run casper\\_check on \\~/.casper" })).toBe("Run casper_check on ~/.casper");
  expect(intentLine("Running the configured casper\\_check in \\~/x.")).toBe("Running the configured casper_check in ~/x");
});
