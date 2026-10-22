import { expect, test } from "bun:test";
import { DrawioProvider } from "../src/visualize/drawio";
import { MermaidProvider } from "../src/visualize/mermaid";
import { layoutNetwork, networkPage, type NetworkLayout } from "../src/visualize/network";
import { diagramPageFor } from "../src/visualize/page";
import { DEVICE_KINDS, parseVisualizationGraph, type VisualizationGraph } from "../src/visualize/types";

/** A placeholder campus: no real site, host or address. */
const NETWORK = parseVisualizationGraph({
  type: "network", title: "Example campus",
  nodes: [
    { id: "isp", label: "ISP", kind: "internet" },
    { id: "fw1", label: "fw-1", kind: "firewall", group: "Edge" },
    { id: "fw2", label: "fw-2", kind: "firewall", group: "Edge" },
    { id: "core", label: "core-1", kind: "core-switch", note: "192.0.2.1" },
    { id: "gw1", label: "gw-1", kind: "gateway", group: "Gateways" },
    { id: "sw1", label: "sw-floor-1", kind: "switch", group: "Floors" },
    { id: "gw2", label: "gw-2", kind: "gateway", group: "Gateways" },
    { id: "sw2", label: "sw-floor-2", kind: "switch", group: "Floors" },
    { id: "sw3", label: "sw-floor-3 </text><script>alert(1)</script>", kind: "switch", group: "Floors" },
    { id: "sw3b", label: "sw-floor-3b", kind: "switch" },
    { id: "ap1", label: "ap-1", kind: "access-point" },
    { id: "srv", label: "srv-1", kind: "server" },
    { id: "cam", label: "cam-1", kind: "device" },
  ],
  edges: [
    { from: "isp", to: "fw1", label: "wan 1" }, { from: "isp", to: "fw1", label: "wan 2" },
    { from: "fw1", to: "fw2", label: "ha" },
    { from: "fw1", to: "core", label: "1/1/49" },
    { from: "core", to: "gw1", label: "1/1/50 10G" }, { from: "core", to: "gw2", label: "1/1/51 10G" }, { from: "gw1", to: "gw2", label: "cluster" },
    { from: "core", to: "sw1", label: "1/1/1" }, { from: "core", to: "sw2", label: "1/1/2" }, { from: "core", to: "sw3", label: "1/1/3" },
    { from: "sw3", to: "sw3b", label: "1/1/48" },
    { from: "ap1", to: "sw1", label: "1/1/10" },
    { from: "core", to: "srv", label: "1/1/40" },
    { from: "core", to: "cam", label: "1/1/41" },
  ],
});

const box = (layout: NetworkLayout, id: string) => layout.nodes.find((node) => node.id === id)!;
const tier = (layout: NetworkLayout, id: string) => box(layout, id).tier;
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Whether a horizontal or vertical segment passes through the inside of a box. */
function crosses(from: [number, number], to: [number, number], rect: { x: number; y: number; width: number; height: number }): boolean {
  const [x1, y1] = from, [x2, y2] = to;
  if (x1 === x2) return x1 > rect.x && x1 < rect.x + rect.width && Math.max(y1, y2) > rect.y && Math.min(y1, y2) < rect.y + rect.height;
  return y1 > rect.y && y1 < rect.y + rect.height && Math.max(x1, x2) > rect.x && Math.min(x1, x2) < rect.x + rect.width;
}

test("a network graph takes a kind for each device; an unknown kind is refused with the list", () => {
  expect(NETWORK.nodes.find((node) => node.id === "core")?.kind).toBe("core-switch");
  expect(DEVICE_KINDS).toEqual(["internet", "router", "firewall", "gateway", "core-switch", "switch", "access-point", "server", "device"]);
  expect(() => parseVisualizationGraph({ type: "network", title: "x", nodes: [{ id: "a", label: "a", kind: "toaster" }] }))
    .toThrow(`Invalid graph: node a kind must be one of ${DEVICE_KINDS.join(", ")}`);
});

test("devices fall into tiers by kind and link: the internet on top, peers side by side, a daisy-chained switch one tier lower", () => {
  const layout = layoutNetwork(NETWORK);
  expect(tier(layout, "isp")).toBeLessThan(tier(layout, "fw1"));
  expect(tier(layout, "fw2")).toBe(tier(layout, "fw1"));
  expect(tier(layout, "fw1")).toBeLessThan(tier(layout, "core"));
  for (const id of ["gw1", "gw2", "sw1", "sw2", "sw3", "srv"]) expect({ id, tier: tier(layout, id) }).toEqual({ id, tier: tier(layout, "core") + 1 });
  for (const id of ["sw3b", "ap1", "cam"]) expect({ id, tier: tier(layout, id) }).toEqual({ id, tier: tier(layout, "core") + 2 });
  // A group's devices sit together in their row, framed and named.
  const row = layout.nodes.filter((node) => node.tier === tier(layout, "sw1")).sort((a, b) => a.x - b.x).map((node) => node.group ?? "-");
  for (const group of ["Gateways", "Floors"]) {
    const at = row.flatMap((name, index) => name === group ? [index] : []);
    expect({ group, together: at.at(-1)! - at[0]! + 1 === at.length }).toEqual({ group, together: true });
  }
  expect(layout.frames.map((frame) => frame.label).sort()).toEqual(["Edge", "Floors", "Gateways"]);
});

/** No two devices overlap, and every link runs at right angles without passing through a device it doesn't join. */
function expectTidy(layout: NetworkLayout, graph: VisualizationGraph): void {
  for (const [index, a] of layout.nodes.entries()) for (const b of layout.nodes.slice(index + 1)) expect({ a: a.id, b: b.id, overlap: overlaps(a, b) }).toEqual({ a: a.id, b: b.id, overlap: false });
  expect(layout.links).toHaveLength(graph.edges.length);
  for (const link of layout.links) {
    expect(link.points.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < link.points.length; i++) {
      const [x1, y1] = link.points[i - 1]!, [x2, y2] = link.points[i]!;
      expect({ link: `${link.from}-${link.to}`, square: x1 === x2 || y1 === y2 }).toEqual({ link: `${link.from}-${link.to}`, square: true });
      for (const node of layout.nodes) {
        if (node.id === link.from || node.id === link.to) continue;
        expect({ link: `${link.from}-${link.to}`, through: node.id, crosses: crosses(link.points[i - 1]!, link.points[i]!, node) })
          .toEqual({ link: `${link.from}-${link.to}`, through: node.id, crosses: false });
      }
    }
  }
}

test("links run at right angles between devices, never through one, with parallel links apart and every port label kept", () => {
  const layout = layoutNetwork(NETWORK);
  expectTidy(layout, NETWORK);
  // The two WAN links reach the firewall apart, each with its own label.
  const wan = layout.links.filter((link) => link.from === "isp");
  expect(new Set(wan.map((link) => link.points.at(-1)![0])).size).toBe(2);
  expect(layout.links.map((link) => link.label)).toEqual(NETWORK.edges.map((edge) => edge.label));
});

test("a tier of more than eight devices wraps onto rows below it, about as full as each other, each group whole and side by side", () => {
  const groups: Array<[string, number]> = [["Floors", 8], ["Services", 4], ["Gateways", 2], ["Closets", 2]];
  const wide = parseVisualizationGraph({
    type: "network", title: "Example wide tier",
    nodes: [
      { id: "core", label: "core-1", kind: "core-switch" },
      ...groups.flatMap(([group, count]) => Array.from({ length: count }, (_, i) => ({ id: `${group}${i}`, label: `${group.toLowerCase()}-${i + 1}`, kind: "switch", group }))),
      ...[1, 2, 3].map((i) => ({ id: `srv${i}`, label: `srv-${i}`, kind: "server" })),
    ],
    edges: [...groups.flatMap(([group, count]) => Array.from({ length: count }, (_, i) => ({ from: "core", to: `${group}${i}`, label: `1/1/${i + 1}` }))),
      ...[1, 2, 3].map((i) => ({ from: "core", to: `srv${i}`, label: `1/2/${i}` }))],
  });
  const layout = layoutNetwork(wide);
  const below = layout.nodes.filter((node) => node.id !== "core");
  expect(new Set(below.map((node) => node.tier))).toEqual(new Set([tier(layout, "core") + 1]));
  const rows = new Map<number, typeof below>();
  for (const node of below) rows.set(node.y, [...rows.get(node.y) ?? [], node]);
  expect(rows.size).toBe(3);
  for (const row of rows.values()) expect(row.length).toBeLessThanOrEqual(8);
  for (const [group] of groups) {
    const members = below.filter((node) => node.group === group).sort((a, b) => a.x - b.x);
    expect({ group, rows: new Set(members.map((node) => node.y)).size }).toEqual({ group, rows: 1 });
    const row = rows.get(members[0]!.y)!.sort((a, b) => a.x - b.x);
    const at = row.findIndex((node) => node.id === members[0]!.id);
    expect({ group, together: row.slice(at, at + members.length).every((node) => node.group === group) }).toEqual({ group, together: true });
  }
  expect(layout.frames.map((frame) => frame.label).sort()).toEqual(["Closets", "Floors", "Gateways", "Services"]);
  expectTidy(layout, wide);
});

test("links into one device meet it apart with their port labels either side; a link to itself, a plain box and a lone device draw too", () => {
  const graph = parseVisualizationGraph({
    type: "network", title: "Example closet",
    nodes: [
      { id: "a", label: "sw-a", kind: "switch" }, { id: "b", label: "sw-b", kind: "switch" },
      { id: "ap", label: "ap-1", kind: "access-point" }, { id: "box", label: "patch panel" },
    ],
    edges: [{ from: "a", to: "ap", label: "1/1/10" }, { from: "b", to: "ap", label: "1/1/11" }, { from: "a", to: "a", label: "loopback" }, { from: "b", to: "box" }],
  });
  const layout = layoutNetwork(graph);
  expectTidy(layout, graph);
  const into = layout.links.filter((link) => link.to === "ap");
  expect(new Set(into.map((link) => link.points.at(-1)![0])).size).toBe(2);
  expect(into.map((link) => link.labelAt?.anchor).sort()).toEqual(["end", "start"]);
  const html = networkPage(graph);
  expect(html).toContain('data-kind="plain"');
  expect(html).toContain(">loopback<");
  const lone = layoutNetwork(parseVisualizationGraph({ type: "network", title: "One", nodes: [{ id: "a", label: "a", kind: "router" }] }));
  expect({ nodes: lone.nodes.length, links: lone.links.length, frames: lone.frames.length }).toEqual({ nodes: 1, links: 0, frames: 0 });
});

test("a network diagram's Mermaid text draws its links without arrows", async () => {
  const { content } = await new MermaidProvider().render(NETWORK);
  expect(content).toContain("flowchart TD");
  expect(content).toContain("---|1/1/49|");
  expect(content).not.toContain("-->");
});

test("the page is a drawing of its own: device icons, port labels, group frames and a legend, nothing loaded and nothing in a label run", () => {
  const html = networkPage(NETWORK, ["/home/user/.casper/visualizations/example/a.drawio.drawio"]);
  expect(html).toContain("<svg");
  for (const kind of DEVICE_KINDS) expect(html).toContain(`<symbol id="icon-${kind}"`);
  expect(html).toContain('data-kind="core-switch"');
  expect(html).toContain(">1/1/49<");
  expect(html).toContain(">Floors<");
  expect(html).toContain('<section class="legend"');
  expect(html).toContain("Core switch");
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).not.toMatch(/<script[^>]*\ssrc=/);
  expect(html).not.toContain("https://");
  // Every link is drawn with straight horizontal and vertical moves only.
  for (const [, d] of html.matchAll(/<path class="link" d="([^"]+)"/g)) expect(d).toMatch(/^M[\d.]+ [\d.]+(?: [HV][\d.]+)+$/);
  expect(html).toContain("a.drawio.drawio");
  // A network graph gets this page; any other graph keeps the Mermaid page.
  expect(diagramPageFor(NETWORK, "flowchart TD", [])).toBe(networkPage(NETWORK, []));
  const flow: VisualizationGraph = { ...NETWORK, type: "flowchart" };
  expect(diagramPageFor(flow, "flowchart TD", [])).toContain("mermaid");
});

test("the draw.io file has the same layout in draw.io's network shapes, with square links that keep their bends", async () => {
  const { content } = await new DrawioProvider().render(NETWORK);
  for (const shape of ["storage.cloud", "security.firewall", "switches.layer_3_switch", "switches.workgroup_switch", "wireless.wlan_controller", "misc.access_point", "servers.file_server", "computers_and_peripherals.pc"]) {
    expect(content).toContain(`shape=mxgraph.cisco.${shape};`);
  }
  expect(content).toContain("edgeStyle=orthogonalEdgeStyle");
  expect(content).toContain("endArrow=none");
  expect(content).toContain('<Array as="points">');
  expect(content).toContain('value="1/1/49"');
  // Each shape keeps draw.io's proportions, centred where the page draws the device's icon.
  const core = box(layoutNetwork(NETWORK), "core");
  const cell = content.match(/value="core-1[^"]*" style="[^"]*layer_3_switch;[^"]*" vertex="1" parent="1"><mxGeometry x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
  expect(cell).not.toBeNull();
  const [x, y, width, height] = cell!.slice(1).map(Number) as [number, number, number, number];
  expect(x + width / 2).toBeCloseTo(core.icon.x + core.icon.width / 2, 0);
  expect(y + height / 2).toBeCloseTo(core.icon.y + core.icon.height / 2, 0);
  expect(content).toContain('value="core-1&#10;192.0.2.1"');
});
