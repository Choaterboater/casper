import { spanningTree, type VisualizationGraph, type VisualizationProvider, type VisualizationResult, type VisualizationType } from "./types";

/** Mermaid text output. Always available; no external process or network. */
export class MermaidProvider implements VisualizationProvider {
  readonly name = "mermaid";

  supports(_type: VisualizationType): boolean { return true; }

  async render(graph: VisualizationGraph): Promise<VisualizationResult> {
    const { content, lossiness } = graph.type === "mindmap" ? renderMindmap(graph) : renderFlowchart(graph);
    return { provider: this.name, format: "mmd", mimeType: "text/vnd.mermaid", content, lossiness };
  }
}

/** Quoted flowchart label: Mermaid entity codes for characters that break its parser. */
function quote(text: string): string {
  return `"${text.replace(/\s+/g, " ").replace(/#/g, "#35;").replace(/"/g, "#quot;")}"`;
}

/** Edge labels are pipe-delimited and cannot use the quoted-text form. */
function edgeLabel(text: string): string {
  return text.replace(/\s+/g, " ").replace(/#/g, "#35;").replace(/\|/g, "#124;").replace(/"/g, "#quot;");
}

/** Mindmap lines are unquoted; drop shape/comment characters instead of encoding. */
function mindmapText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").replace(/[()[\]{}%<>"`]/g, "").trim();
  return cleaned || "unnamed";
}

/** Front-matter title as a JSON (hence YAML) string so colons and quotes cannot break parsing. */
function frontMatter(title: string): string[] {
  return ["---", `title: ${JSON.stringify(title.replace(/\s+/g, " "))}`, "---"];
}

function renderFlowchart(graph: VisualizationGraph): { content: string; lossiness: string[] } {
  const direction = graph.type === "architecture" || graph.type === "dependency-graph" ? "LR" : "TD";
  const alias = new Map(graph.nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = [...frontMatter(graph.title), `flowchart ${direction}`];
  const grouped = new Map<string | undefined, typeof graph.nodes>();
  for (const node of graph.nodes) {
    const list = grouped.get(node.group) ?? [];
    list.push(node);
    grouped.set(node.group, list);
  }
  const lossiness: string[] = [];
  let groupIndex = 0;
  for (const [group, nodes] of grouped) {
    const indent = group === undefined ? "  " : "    ";
    if (group !== undefined) lines.push(`  subgraph g${groupIndex++} [${quote(group)}]`);
    for (const node of nodes) lines.push(`${indent}${alias.get(node.id)}[${quote(node.label)}]`);
    if (group !== undefined) lines.push("  end");
  }
  for (const edge of graph.edges) {
    const arrow = edge.label ? `-->|${edgeLabel(edge.label)}|` : "-->";
    lines.push(`  ${alias.get(edge.from)} ${arrow} ${alias.get(edge.to)}`);
  }
  if (graph.nodes.some((node) => node.note)) lossiness.push("Node notes are not drawn in Mermaid flowcharts.");
  return { content: lines.join("\n") + "\n", lossiness };
}

function renderMindmap(graph: VisualizationGraph): { content: string; lossiness: string[] } {
  const tree = spanningTree(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const lines = [...frontMatter(graph.title), "mindmap"];
  const lossiness: string[] = [];
  const emit = (id: string, depth: number) => {
    const indent = "  ".repeat(depth + 1);
    const label = id === tree.rootId && tree.syntheticRoot ? graph.title : byId.get(id)!.label;
    lines.push(depth === 0 ? `${indent}root((${mindmapText(label)}))` : `${indent}${mindmapText(label)}`);
    for (const child of tree.children.get(id) ?? []) emit(child, depth + 1);
  };
  emit(tree.rootId, 0);
  if (tree.syntheticRoot) lossiness.push("No single root node; the title is used as a synthetic root.");
  if (tree.crossEdges.length) {
    lossiness.push(`${tree.crossEdges.length} cross edge(s) cannot be drawn in a mindmap; listed as comments.`);
    for (const edge of tree.crossEdges) {
      lines.push(`%% cross edge: ${mindmapText(byId.get(edge.from)!.label)} -> ${mindmapText(byId.get(edge.to)!.label)}${edge.label ? ` (${mindmapText(edge.label)})` : ""}`);
    }
  }
  if (graph.nodes.some((node) => node.group)) lossiness.push("Groups are not represented in mindmaps.");
  if (graph.nodes.some((node) => node.note)) lossiness.push("Node notes are not drawn in Mermaid mindmaps.");
  if (graph.nodes.some((node) => /[()[\]{}%<>"`]/.test(node.label))) lossiness.push("Shape and comment characters were removed from mindmap labels.");
  return { content: lines.join("\n") + "\n", lossiness };
}
