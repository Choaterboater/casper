import { expect, test } from "bun:test";
import { DrawioProvider } from "../src/visualize/drawio";
import { parseVisualizationGraph, type VisualizationGraph } from "../src/visualize/types";

/** Well-formed XML for what draw.io reads: every tag closes in order, and attribute text has no raw `<`, `>`
 * or a `&` that starts no entity. */
function wellFormed(text: string): boolean {
  const stack: string[] = [];
  for (const [tag, close, name, attrs, selfClose] of text.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^<>]*?)(\/?)>/g)) {
    for (const [, value] of (attrs ?? "").matchAll(/="([^"]*)"/g)) if (/[<>]|&(?!(?:amp|lt|gt|quot|apos|#\d+);)/.test(value!)) return false;
    if (close) { if (stack.pop() !== name) return false; }
    else if (!selfClose) stack.push(name!);
    if (!tag) return false;
  }
  return stack.length === 0 && !/<(?![/A-Za-z])/.test(text);
}

/** Each box's place, whether it is a plain cell or a UserObject holding one. */
const cells = (content: string) => [...content.matchAll(/ id="(n\d+)".*?<mxGeometry x="(\d+)" y="(\d+)"/g)]
  .map(([, id, x, y]) => ({ id, x: Number(x), y: Number(y) }));

const network: VisualizationGraph = parseVisualizationGraph({
  type: "architecture", title: "Branch office <A&B>",
  nodes: [
    { id: "isp", label: "ISP", group: "WAN" },
    { id: "fw", label: "Firewall", group: "Edge", note: "HA pair\nactive/standby" },
    { id: "core", label: "Core \"switch\"", group: "LAN" },
    { id: "ap", label: "AP 1", group: "LAN" },
  ],
  edges: [{ from: "isp", to: "fw", label: "WAN & backup" }, { from: "fw", to: "core" }, { from: "core", to: "ap", label: "VLAN 10" }],
});

test("draw.io output is a well-formed mxfile with escaped labels, tooltips for notes and groups, and real edges", async () => {
  const result = await new DrawioProvider().render(network);
  expect([result.provider, result.format, result.mimeType]).toEqual(["drawio", "drawio", "application/vnd.jgraph.mxfile"]);
  expect(wellFormed(result.content)).toBe(true);
  expect(result.content).toStartWith('<mxfile host="Casper" type="device">');
  expect(result.content).toContain('name="Branch office &lt;A&amp;B&gt;"');
  expect(result.content).toContain('label="Core &quot;switch&quot;"');
  expect(result.content).toContain('tooltip="Group: Edge&#10;HA pair&#10;active/standby"');
  expect(result.content).toContain('value="WAN &amp; backup"');
  // Every edge joins two boxes that exist.
  const ids = new Set([...result.content.matchAll(/ id="(n\d+)"/g)].map(([, id]) => id));
  const ends = [...result.content.matchAll(/source="(\w+)" target="(\w+)"/g)];
  expect(ends).toHaveLength(3);
  for (const [, from, to] of ends) expect([ids.has(from), ids.has(to)]).toEqual([true, true]);
  // One colour per group, the same for both LAN boxes.
  const fills = [...result.content.matchAll(/fillColor=(#[0-9a-f]{6})/g)].map(([, fill]) => fill);
  expect(fills).toHaveLength(4);
  expect(new Set(fills).size).toBe(3);
  // Lines leave the right side and enter the left, so they run in the gaps between columns.
  expect(result.content).toContain("exitX=1;exitY=0.5;entryX=0;entryY=0.5;");
  expect(result.lossiness).toEqual([
    "Groups are drawn as box colours (named in each box's tooltip), not as containers.",
    "Node notes are box tooltips in draw.io, not drawn text.",
  ]);
});

test("architecture runs left to right and a flowchart top-down, one layer per step, siblings side by side and centred", async () => {
  const across = cells((await new DrawioProvider().render(network)).content);
  expect(across.map(({ x }) => x)).toEqual([0, 240, 480, 720]);
  expect(across.map(({ y }) => y)).toEqual([0, 0, 0, 0]);
  const flow = parseVisualizationGraph({
    type: "flowchart", title: "Login",
    nodes: [{ id: "a", label: "Start" }, { id: "b", label: "Password" }, { id: "c", label: "Passkey" }, { id: "d", label: "Done" }],
    edges: [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" }],
  });
  const down = cells((await new DrawioProvider().render(flow)).content);
  expect(down.map(({ x, y }) => [x, y])).toEqual([[100, 0], [0, 140], [200, 140], [100, 280]]);
});

test("a cycle with no start node, a self edge and an unconnected box still lay out and finish", async () => {
  const cycle = parseVisualizationGraph({
    type: "troubleshooting-tree", title: "Loop",
    nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "c", to: "c" }],
  });
  const result = await new DrawioProvider().render(cycle);
  expect(wellFormed(result.content)).toBe(true);
  expect(cells(result.content).map(({ x, y }) => [x, y])).toEqual([[0, 0], [100, 140], [200, 0]]);
});
