import { expect, test } from "bun:test";
import { MermaidProvider } from "../src/visualize/mermaid";
import { diagramPage, diagramPageName, MERMAID_MODULE } from "../src/visualize/page";
import type { VisualizationGraph } from "../src/visualize/types";

const graph: VisualizationGraph = {
  type: "flowchart", title: "Example site: core & closets",
  nodes: [{ id: "core", label: "core-1 </pre><script>alert(1)</script>" }, { id: "sw1", label: "sw1 (192.0.2.11)", group: "Floor 1" }],
  edges: [{ from: "core", to: "sw1", label: "1/1/1 10G" }],
};
const unescape = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");

test("a diagram page is named after the diagram's title, in the names Casper serves pages under", () => {
  expect(diagramPageName("Example site: core & closets")).toBe("diagram-example-site-core-closets");
  expect(diagramPageName("A".repeat(80))).toHaveLength(40);
  expect(diagramPageName("A".repeat(80))).toMatch(/^diagram-a+$/);
  expect(diagramPageName("…")).toBe("diagram");
});

test("the page draws the terminal's Mermaid text with Mermaid from jsDelivr, strict, and nothing in a label runs", async () => {
  const html = diagramPage(graph, (await new MermaidProvider().render(graph)).content, ["/home/user/.casper/visualizations/example/a.drawio.drawio"]);
  expect(MERMAID_MODULE).toStartWith("https://cdn.jsdelivr.net/npm/mermaid@11");
  expect(html).toContain(`import mermaid from "${MERMAID_MODULE}";`);
  expect(html).toContain('securityLevel: "strict"');
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("<title>Example site: core &amp; closets</title>");
  // The text Mermaid reads from the page is exactly what the terminal shows.
  const text = html.slice(html.indexOf('<pre class="mermaid">') + '<pre class="mermaid">'.length, html.indexOf("</pre>"));
  expect(unescape(text)).toBe((await new MermaidProvider().render(graph)).content);
  // Where the editable copies are.
  expect(html).toContain("/home/user/.casper/visualizations/example/a.drawio.drawio");
  expect([...html.matchAll(/<script\b/g)]).toHaveLength(1);
});
