import { ICON, deviceText, layoutNetwork, type Box, type NetworkNode, type Point } from "./network";
import type { DeviceKind, VisualizationGraph, VisualizationProvider, VisualizationResult, VisualizationType } from "./types";

/** Box size and gaps of the layered layout, in draw.io units (pixels at 100%). */
const NODE = { width: 160, height: 60 } as const;
const GAP = { along: 80, across: 40 } as const;
/** Fill colours for groups, in order of first appearance; a group past the last reuses them from the start. */
const GROUP_FILLS = ["#dae8fc", "#d5e8d4", "#ffe6cc", "#e1d5e7", "#fff2cc", "#f8cecc", "#f5f5f5"] as const;
const GROUP_STROKES = ["#6c8ebf", "#82b366", "#d79b00", "#9673a6", "#d6b656", "#b85450", "#666666"] as const;

/** draw.io's own network shapes (its Cisco library) for each kind of device, with each shape's proportions. */
const DEVICE_SHAPES: Record<DeviceKind, { shape: string; width: number; height: number }> = {
  internet: { shape: "storage.cloud", width: 186, height: 106 },
  router: { shape: "routers.router", width: 78, height: 53 },
  firewall: { shape: "security.firewall", width: 29, height: 67 },
  gateway: { shape: "wireless.wlan_controller", width: 101, height: 56 },
  "core-switch": { shape: "switches.layer_3_switch", width: 64, height: 64 },
  switch: { shape: "switches.workgroup_switch", width: 101, height: 50 },
  "access-point": { shape: "misc.access_point", width: 75, height: 34 },
  server: { shape: "servers.file_server", width: 43, height: 58 },
  device: { shape: "computers_and_peripherals.pc", width: 78, height: 70 },
};

/**
 * draw.io (diagrams.net) file output: an uncompressed `.drawio` mxfile that draw.io opens and edits as it is.
 * Casper places the boxes itself in layers (top-down, or left-to-right for architecture and dependency graphs)
 * so the file opens laid out; nothing is fetched or started.
 */
export class DrawioProvider implements VisualizationProvider {
  readonly name = "drawio";

  supports(_type: VisualizationType): boolean { return true; }

  async render(graph: VisualizationGraph): Promise<VisualizationResult> {
    if (graph.type === "network") return network(graph);
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
    const content = file(graph.title, cells);
    const lossiness: string[] = [];
    if (groups.length) lossiness.push("Groups are drawn as box colours (named in each box's tooltip), not as containers.");
    if (graph.nodes.some((node) => node.note)) lossiness.push("Node notes are box tooltips in draw.io, not drawn text.");
    return { provider: this.name, format: "drawio", mimeType: "application/vnd.jgraph.mxfile", content, lossiness };
  }
}

function file(title: string, cells: string[]): string {
  return [
    '<mxfile host="Casper" type="device">',
    `  <diagram id="casper" name="${xml(title)}">`,
    '    <mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" math="0" shadow="0">',
    "      <root>",
    ...cells.map((cell) => `        ${cell}`),
    "      </root>",
    "    </mxGraphModel>",
    "  </diagram>",
    "</mxfile>",
  ].join("\n") + "\n";
}

const number = (value: number) => String(Math.round(value * 100) / 100);
const FRAME_FILL = "#f6f8fa";
const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** A network diagram in the page's layout (network.ts): draw.io's network shapes where the page draws its icons, each
 * keeping the shape's proportions, the whole label and note under it, and links that leave and enter where the page's
 * do, through the same bends. Frames first and devices last, so a device's label hides the line under it. */
function network(graph: VisualizationGraph): VisualizationResult {
  const layout = layoutNetwork(graph);
  const shapes = new Map<string, Box>(layout.nodes.map((node) => {
    if (!node.kind) return [node.id, { x: node.icon.x, y: node.icon.y + 4, width: ICON.width, height: ICON.height - 8 }];
    const { width, height } = DEVICE_SHAPES[node.kind];
    const scale = Math.min(ICON.width / width, ICON.height / height);
    const size = { width: width * scale, height: height * scale };
    return [node.id, { x: node.icon.x + (ICON.width - size.width) / 2, y: node.icon.y + (ICON.height - size.height) / 2, ...size }];
  }));
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const id = new Map(graph.nodes.map((node, index) => [node.id, `n${index}`]));
  const geometry = (box: Box) => `<mxGeometry x="${number(box.x)}" y="${number(box.y)}" width="${number(box.width)}" height="${number(box.height)}" as="geometry"/>`;
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  layout.frames.forEach((frame, index) => {
    cells.push(`<mxCell id="f${index}" value="${xml(frame.label)}" style="rounded=1;absoluteArcSize=1;arcSize=20;html=0;fillColor=${FRAME_FILL};strokeColor=#d0d7de;verticalAlign=top;align=left;spacingLeft=8;fontSize=11;fontStyle=1;fontColor=#57606a;" vertex="1" parent="1">${geometry(frame)}</mxCell>`);
  });
  // Where a link meets a device's shape, as draw.io's exit or entry point, from the side the page's line meets it.
  const side = (node: NetworkNode, [x, y]: Point): { at: Point; fx: number; fy: number } => {
    const shape = shapes.get(node.id)!;
    if (y <= node.y) return { at: [x, shape.y], fx: clamp((x - shape.x) / shape.width), fy: 0 };
    if (y >= node.y + node.height) return { at: [x, shape.y + shape.height], fx: clamp((x - shape.x) / shape.width), fy: 1 };
    const fy = clamp((y - shape.y) / shape.height);
    return x < node.icon.x + ICON.width / 2 ? { at: [shape.x, y], fx: 0, fy } : { at: [shape.x + shape.width, y], fx: 1, fy };
  };
  // Text over a frame gets the frame's fill behind it, elsewhere white, so the lines under it don't show through.
  const behind = ([x, y]: Point) => layout.frames.some((frame) => x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height) ? FRAME_FILL : "#ffffff";
  layout.links.forEach((link, index) => {
    const exit = side(byId.get(link.from)!, link.points[0]!), entry = side(byId.get(link.to)!, link.points.at(-1)!);
    const bends = link.points.slice(1, -1);
    // The port label sits where the page puts it, beside the line it names or on a line between two devices in a row:
    // draw.io places an edge's label by how far along the edge it is.
    const label = link.labelAt;
    const at = label ? along([exit.at, ...bends, entry.at], label.anchor === "middle" ? [label.x, label.y] : [label.x, label.y - 3]) : 0;
    const beside = label?.anchor === "start" ? "align=left;spacingLeft=4;" : label?.anchor === "end" ? "align=right;spacingRight=4;" : "";
    const style = "edgeStyle=orthogonalEdgeStyle;rounded=0;html=0;endArrow=none;startArrow=none;strokeColor=#57606a;strokeWidth=1.5;"
      + `fontSize=10;fontFamily=Courier New;fontColor=#0b4f8a;labelBackgroundColor=${label ? behind([label.x, label.y]) : "#ffffff"};${beside}`
      + `exitX=${number(exit.fx)};exitY=${number(exit.fy)};exitPerimeter=0;entryX=${number(entry.fx)};entryY=${number(entry.fy)};entryPerimeter=0;`;
    const points = bends.length ? `<Array as="points">${bends.map(([x, y]) => `<mxPoint x="${number(x)}" y="${number(y)}"/>`).join("")}</Array>` : "";
    cells.push(`<mxCell id="e${index}" value="${xml(link.label ?? "")}" style="${style}" edge="1" parent="1" source="${id.get(link.from)}" target="${id.get(link.to)}"><mxGeometry x="${number(at)}" relative="1" as="geometry">${points}</mxGeometry></mxCell>`);
  });
  for (const node of graph.nodes) {
    const placed = byId.get(node.id)!;
    const look = node.kind
      ? `sketch=0;pointerEvents=1;dashed=0;fillColor=#036897;strokeColor=#ffffff;strokeWidth=2;outlineConnect=0;shape=mxgraph.cisco.${DEVICE_SHAPES[node.kind].shape};`
      : "rounded=1;fillColor=#eaeef2;strokeColor=#8c959f;";
    const style = `html=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;fontSize=11;labelBackgroundColor=${node.group !== undefined ? FRAME_FILL : "#ffffff"};${look}`;
    cells.push(`<mxCell id="${id.get(node.id)}" value="${xml(deviceText(node).join("\n"))}" style="${style}" vertex="1" parent="1">${geometry(shapes.get(placed.id)!)}</mxCell>`);
  }
  const lossiness = layout.frames.length ? ["Groups are frames drawn behind their devices, not containers: moving a frame doesn't move its devices."] : [];
  return { provider: "drawio", format: "drawio", mimeType: "application/vnd.jgraph.mxfile", content: file(graph.title, cells), lossiness };
}

/** How far along a right-angled path its point nearest `target` is, from -1 (its start) to 1 (its end): draw.io's
 * measure for where an edge's label sits. */
function along(path: Point[], [tx, ty]: Point): number {
  let total = 0, best = Infinity, at = 0;
  for (let i = 1; i < path.length; i++) {
    const [x1, y1] = path[i - 1]!, [x2, y2] = path[i]!;
    const length = Math.hypot(x2 - x1, y2 - y1);
    const t = length ? clamp(((tx - x1) * (x2 - x1) + (ty - y1) * (y2 - y1)) / length ** 2) : 0;
    const distance = Math.hypot(x1 + t * (x2 - x1) - tx, y1 + t * (y2 - y1) - ty);
    if (distance < best) { best = distance; at = total + t * length; }
    total += length;
  }
  return total ? (2 * at) / total - 1 : 0;
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
