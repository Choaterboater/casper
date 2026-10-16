import type { VisualizationGraph, VisualizationProvider, VisualizationResult, VisualizationType } from "./types";

/** Box size and gaps of the layered layout, in draw.io units (pixels at 100%). */
const NODE = { width: 160, height: 60 } as const;
const GAP = { along: 80, across: 40 } as const;
/** Fill colours for groups, in order of first appearance; a group past the last reuses them from the start. */
const GROUP_FILLS = ["#dae8fc", "#d5e8d4", "#ffe6cc", "#e1d5e7", "#fff2cc", "#f8cecc", "#f5f5f5"] as const;
const GROUP_STROKES = ["#6c8ebf", "#82b366", "#d79b00", "#9673a6", "#d6b656", "#b85450", "#666666"] as const;

/**
 * draw.io (diagrams.net) file output: an uncompressed `.drawio` mxfile that draw.io opens and edits as it is.
 * Casper places the boxes itself in layers (top-down, or left-to-right for architecture and dependency graphs)
 * so the file opens laid out; nothing is fetched or started.
 */
export class DrawioProvider implements VisualizationProvider {
  readonly name = "drawio";

  supports(_type: VisualizationType): boolean { return true; }

  async render(graph: VisualizationGraph): Promise<VisualizationResult> {
    const across = graph.type === "architecture" || graph.type === "dependency-graph";
    const layers = layerOf(graph);
    const groups = [...new Set(graph.nodes.flatMap((node) => node.group === undefined ? [] : [node.group]))];
    const slots = new Map<number, number>();
    // Each layer is centred on the widest one, so a box's children sit around it rather than all below it.
    const counts = new Map<number, number>();
    for (const layer of layers.values()) counts.set(layer, (counts.get(layer) ?? 0) + 1);
    const widest = Math.max(...counts.values());
    const pitch = (across ? NODE.height : NODE.width) + GAP.across;
    const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
    const id = new Map(graph.nodes.map((node, index) => [node.id, `n${index}`]));
    for (const node of graph.nodes) {
      const layer = layers.get(node.id)!;
      const slot = slots.get(layer) ?? 0;
      slots.set(layer, slot + 1);
      const along = layer * ((across ? NODE.width : NODE.height) + GAP.along);
      const side = (slot + (widest - counts.get(layer)!) / 2) * pitch;
      const [x, y] = across ? [along, side] : [side, along];
      const colour = node.group === undefined ? undefined : groups.indexOf(node.group) % GROUP_FILLS.length;
      const style = `rounded=1;whiteSpace=wrap;html=0;${colour === undefined ? "" : `fillColor=${GROUP_FILLS[colour]};strokeColor=${GROUP_STROKES[colour]};`}`;
      const geometry = `<mxGeometry x="${x}" y="${y}" width="${NODE.width}" height="${NODE.height}" as="geometry"/>`;
      // A note or group becomes the box's tooltip (hover in draw.io), kept on a UserObject so the label stays plain.
      const tooltip = [node.group === undefined ? "" : `Group: ${node.group}`, node.note ?? ""].filter(Boolean).join("\n");
      cells.push(tooltip
        ? `<UserObject id="${id.get(node.id)}" label="${xml(node.label)}" tooltip="${xml(tooltip)}"><mxCell style="${style}" vertex="1" parent="1">${geometry}</mxCell></UserObject>`
        : `<mxCell id="${id.get(node.id)}" value="${xml(node.label)}" style="${style}" vertex="1" parent="1">${geometry}</mxCell>`);
    }
    // Lines leave a box on the side facing the next layer and enter the next box opposite, so they run in the gaps.
    const edgeStyle = `edgeStyle=orthogonalEdgeStyle;rounded=1;html=0;${across ? "exitX=1;exitY=0.5;entryX=0;entryY=0.5;" : "exitX=0.5;exitY=1;entryX=0.5;entryY=0;"}`;
    graph.edges.forEach((edge, index) => {
      cells.push(`<mxCell id="e${index}" value="${xml(edge.label ?? "")}" style="${edgeStyle}" edge="1" parent="1" source="${id.get(edge.from)}" target="${id.get(edge.to)}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
    });
    const content = [
      '<mxfile host="Casper" type="device">',
      `  <diagram id="casper" name="${xml(graph.title)}">`,
      '    <mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" math="0" shadow="0">',
      "      <root>",
      ...cells.map((cell) => `        ${cell}`),
      "      </root>",
      "    </mxGraphModel>",
      "  </diagram>",
      "</mxfile>",
    ].join("\n") + "\n";
    const lossiness: string[] = [];
    if (groups.length) lossiness.push("Groups are drawn as box colours (named in each box's tooltip), not as containers.");
    if (graph.nodes.some((node) => node.note)) lossiness.push("Node notes are box tooltips in draw.io, not drawn text.");
    return { provider: this.name, format: "drawio", mimeType: "application/vnd.jgraph.mxfile", content, lossiness };
  }
}

/** Each node's layer: its distance from a start node (no incoming edge), breadth first, so cycles still end.
 * Nodes no start reaches (all in a cycle) start from the first of them in input order. */
function layerOf(graph: VisualizationGraph): Map<string, number> {
  const next = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue;
    next.set(edge.from, [...next.get(edge.from) ?? [], edge.to]);
    incoming.add(edge.to);
  }
  const layers = new Map<string, number>();
  const walk = (starts: string[]) => {
    const queue = starts.filter((start) => !layers.has(start));
    for (const start of queue) layers.set(start, 0);
    for (let index = 0; index < queue.length; index++) {
      const here = queue[index]!;
      for (const there of next.get(here) ?? []) {
        if (layers.has(there)) continue;
        layers.set(there, layers.get(here)! + 1);
        queue.push(there);
      }
    }
  };
  walk(graph.nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id));
  for (const node of graph.nodes) if (!layers.has(node.id)) walk([node.id]);
  return layers;
}

/** Attribute text: XML's five special characters, and newlines kept as line breaks in draw.io labels. */
function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    .replace(/\r?\n/g, "&#10;");
}
