/** A diagram as a page Casper makes from it, with no model: the diagram's Mermaid text, drawn in the browser by Mermaid
 * from jsDelivr (a source the policy of every page allows) at Mermaid's strict security level, so nothing in a label
 * runs as HTML. A network diagram is drawn by Casper instead, as SVG with nothing loaded (network.ts). The page is
 * served and opened like the AI's own pages (src/pages). */

import { networkPage } from "./network";
import type { VisualizationGraph } from "./types";

/** Mermaid 11, pinned to its major version. */
export const MERMAID_MODULE = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** diagram-<title>, within the 40 characters of a-z, 0-9 and - a page name may have. */
export function diagramPageName(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `diagram${slug ? `-${slug}` : ""}`.slice(0, 40).replace(/-+$/, "");
}

/** The page for any diagram: a network diagram is drawn by Casper itself (network.ts), any other by Mermaid. */
export function diagramPageFor(graph: VisualizationGraph, mermaid: string, files: readonly string[] = []): string {
  return graph.type === "network" ? networkPage(graph, files) : diagramPage(graph, mermaid, files);
}

/** The page: the diagram's title, the diagram, and where its editable copies were saved. */
export function diagramPage(graph: VisualizationGraph, mermaid: string, files: readonly string[] = []): string {
  const title = escape(graph.title);
  const copies = files.length ? ` Editable copies: ${files.map((file) => `<code>${escape(file)}</code>`).join(", ")}.` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f2328; background: #f6f8fa; }
  header { padding: 16px 24px; background: #fff; border-bottom: 1px solid #d0d7de; }
  h1 { margin: 0; font-size: 18px; font-weight: 600; }
  main { padding: 24px; overflow: auto; }
  pre.mermaid { margin: 0; padding: 24px; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; }
  footer { padding: 0 24px 24px; color: #57606a; font-size: 12px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<header><h1>${title}</h1></header>
<main><pre class="mermaid">${escape(mermaid)}</pre></main>
<footer>Drawn by Casper from the diagram tool.${copies}</footer>
<script type="module">
import mermaid from "${MERMAID_MODULE}";
mermaid.initialize({ startOnLoad: true, securityLevel: "strict" });
</script>
</body>
</html>
`;
}
