/** Network diagrams (type "network"): devices placed in tiers by kind and link, from the internet at the top to access
 * points and end devices at the bottom, a group's devices together in a framed run; links routed at right angles
 * through the gaps between tiers, a device's links sharing one bus, each link with its port label. The page draws it
 * as inline SVG with Casper's own device icons (nothing is loaded), and drawio.ts places draw.io's network shapes the
 * same way. */

import { DEVICE_KINDS, type DeviceKind, type GraphEdge, type GraphNode, type VisualizationGraph } from "./types";

export type Point = [number, number];
export interface Box { x: number; y: number; width: number; height: number }

export interface NetworkNode extends Box {
  id: string;
  /** Undefined: a plain box, for something that isn't a device. */
  kind?: DeviceKind;
  tier: number;
  group?: string;
  /** Where the device's icon is: draw.io puts its shape here. */
  icon: Box;
  label: string[];
  note: string[];
}

export interface NetworkLink {
  from: string;
  to: string;
  label?: string;
  /** Right angles only, from the `from` device to the `to` device. */
  points: Point[];
  labelAt?: { x: number; y: number; anchor: "start" | "middle" | "end" };
}

export interface NetworkFrame extends Box { label: string }

export interface NetworkLayout { nodes: NetworkNode[]; links: NetworkLink[]; frames: NetworkFrame[]; width: number; height: number }

export const ICON = { width: 64, height: 44 } as const;
const NODE_WIDTH = 150, GAP_X = 26, DUMMY_WIDTH = 12, MARGIN = 32, LANE = 10, GAP_Y = 44, PARALLEL = 8;
const LABEL = { chars: 22, lines: 3, height: 15 } as const;
const NOTE = { chars: 26, lines: 2, height: 13 } as const;
const FRAME = { pad: 10, title: 18 } as const;

/** The tier a kind starts at; links push a device lower, never higher. */
const BASE_TIER: Record<DeviceKind, number> = {
  internet: 0, router: 1, firewall: 1, "core-switch": 2, gateway: 3, server: 3, switch: 3, "access-point": 4, device: 4,
};
/** Kinds that come in side-by-side pairs (an HA pair, a cluster): a link between two of one such kind keeps them level. */
const PEER_KINDS = new Set<DeviceKind>(["internet", "router", "firewall", "gateway", "core-switch", "server"]);

export const KIND_NAMES: Record<DeviceKind, string> = {
  internet: "Internet", router: "Router", firewall: "Firewall", gateway: "Gateway or controller", "core-switch": "Core switch",
  switch: "Switch", "access-point": "Access point", server: "Server", device: "Device",
};

/** Words in lines of at most `chars`, at most `lines` lines, the last cut with "…" when there is more. */
function wrap(text: string, chars: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (let word of text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean)) {
    while (word.length > chars) { if (line) { out.push(line); line = ""; } out.push(word.slice(0, chars)); word = word.slice(chars); }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= chars) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  if (out.length <= lines) return out;
  const kept = out.slice(0, lines);
  kept[lines - 1] = `${kept[lines - 1]!.slice(0, chars - 1)}…`;
  return kept;
}

const rank = (node: GraphNode) => node.kind === undefined ? undefined : BASE_TIER[node.kind];

/** A device's whole label and note, wrapped as the page wraps them but never cut: for draw.io, where the text is edited. */
export const deviceText = (node: GraphNode): string[] =>
  [...wrap(node.label, LABEL.chars, Infinity), ...(node.note ? wrap(node.note, NOTE.chars, Infinity) : [])];

/** Each device's tier: at least its kind's, and below every device above it on a link. A link between peers keeps
 * them level; a link that would make a loop doesn't decide tiers (it is still drawn). Tiers no device uses are left
 * out. */
function tiersOf(graph: VisualizationGraph): Map<string, number> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const below = new Map<string, string[]>(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    const a = byId.get(edge.from)!, b = byId.get(edge.to)!;
    if (a === b || (a.kind !== undefined && a.kind === b.kind && PEER_KINDS.has(a.kind))) continue;
    const ra = rank(a), rb = rank(b);
    const upper = ra !== undefined && rb !== undefined && ra !== rb ? (ra < rb ? a : b) : a;
    below.get(upper.id)!.push(upper === a ? b.id : a.id);
  }
  const state = new Map<string, "open" | "done">();
  const dag = new Map<string, string[]>(graph.nodes.map((node) => [node.id, []]));
  const visit = (id: string) => {
    state.set(id, "open");
    for (const next of below.get(id)!) {
      if (state.get(next) === "open") continue;
      dag.get(id)!.push(next);
      if (!state.has(next)) visit(next);
    }
    state.set(id, "done");
  };
  for (const node of graph.nodes) if (!state.has(node.id)) visit(node.id);
  const tier = new Map(graph.nodes.map((node) => [node.id, rank(node) ?? 0]));
  const incoming = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const nexts of dag.values()) for (const next of nexts) incoming.set(next, incoming.get(next)! + 1);
  const queue = graph.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of dag.get(id)!) {
      tier.set(next, Math.max(tier.get(next)!, tier.get(id)! + 1));
      incoming.set(next, incoming.get(next)! - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  const used = [...new Set(tier.values())].sort((a, b) => a - b);
  return new Map([...tier].map(([id, value]) => [id, used.indexOf(value)]));
}

/** A device, or a slot where one device's links pass through a row on their way further down. */
interface Item { key: string; node?: GraphNode; row: number; width: number; x: number; up: string[]; down: string[] }

const blockOf = (item: Item) => item.node?.group !== undefined ? `group:${item.node.group}` : `item:${item.key}`;

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** A row with its blocks (a group, or an item on its own) in order of `score`, a group's devices kept together in the
 * order they had. */
function orderRow(row: Item[], score: (item: Item) => number): Item[] {
  const blocks = new Map<string, Item[]>();
  for (const item of row) blocks.set(blockOf(item), [...blocks.get(blockOf(item)) ?? [], item]);
  return [...blocks.values()]
    .map((members, first) => ({ members, first, score: mean(members.map(score)) }))
    .sort((a, b) => a.score - b.score || a.first - b.first)
    .flatMap((block) => block.members);
}

interface Arranged { rows: Item[][]; items: Map<string, Item>; chains: Array<string[] | undefined> }

/** The devices in their rows, with a slot wherever a device's links pass through a row (one per device and row, so its
 * links share one line down), each row ordered by where its links go in the rows next to it. */
function arrange(graph: VisualizationGraph, rowOf: Map<string, number>, before: Map<string, number>): Arranged {
  const rows: Item[][] = Array.from({ length: Math.max(...rowOf.values()) + 1 }, () => []);
  const items = new Map<string, Item>();
  const add = (item: Item) => { items.set(item.key, item); rows[item.row]!.push(item); return item; };
  const given = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const start = (node: GraphNode) => before.get(node.id) ?? given.get(node.id)!;
  for (const node of [...graph.nodes].sort((a, b) => start(a) - start(b))) {
    add({ key: `n:${node.id}`, node, row: rowOf.get(node.id)!, width: NODE_WIDTH, x: 0, up: [], down: [] });
  }
  const join = (a: Item, b: Item) => { if (!a.down.includes(b.key)) a.down.push(b.key); if (!b.up.includes(a.key)) b.up.push(a.key); };
  const chains = graph.edges.map((edge) => {
    const [a, b] = [rowOf.get(edge.from)!, rowOf.get(edge.to)!];
    if (a === b) return undefined;
    const [upper, lower] = a < b ? [edge.from, edge.to] : [edge.to, edge.from];
    const keys = [`n:${upper}`];
    for (let row = Math.min(a, b) + 1; row < Math.max(a, b); row++) {
      const key = `d:${upper}:${row}`;
      if (!items.has(key)) add({ key, row, width: DUMMY_WIDTH, x: 0, up: [], down: [] });
      keys.push(key);
    }
    keys.push(`n:${lower}`);
    for (let k = 1; k < keys.length; k++) join(items.get(keys[k - 1]!)!, items.get(keys[k]!)!);
    return keys;
  });
  // Where an item is across its row, from 0 to 1, so rows of different lengths compare.
  const at = new Map<string, number>();
  const place = (r: number, row: Item[]) => { rows[r] = row; row.forEach((item, i) => at.set(item.key, (i + 0.5) / row.length)); };
  rows.forEach((row, r) => place(r, row));
  rows.forEach((row, r) => place(r, orderRow(row, (item) => at.get(item.key)!)));
  const sweep = (r: number, side: "up" | "down") =>
    place(r, orderRow(rows[r]!, (item) => item[side].length ? mean(item[side].map((key) => at.get(key)!)) : at.get(item.key)!));
  for (let pass = 0; pass < 5; pass++) {
    for (let r = 1; r < rows.length; r++) sweep(r, "up");
    if (pass < 4) for (let r = rows.length - 2; r >= 0; r--) sweep(r, "down");
  }
  return { rows, items, chains };
}

/** Devices a row holds before its tier wraps onto another row below it. */
const ROW_DEVICES = 8;

/** Each device's row: its tier's, or for a tier of more than ROW_DEVICES devices, one of the fewest rows below each
 * other that hold it, about as full as each other. A group, or a run of devices of one kind, stays whole where it fits:
 * the biggest go first, each into the emptiest row, and the rows keep the order their devices had. */
function wrapRows(rows: Item[][]): Map<string, number> {
  const rowOf = new Map<string, number>();
  let next = 0;
  for (const row of rows) {
    const devices = row.filter((item) => item.node);
    if (devices.length <= ROW_DEVICES) { for (const item of devices) rowOf.set(item.node!.id, next); next++; continue; }
    const together = (a: GraphNode, b: GraphNode) => a.group !== undefined ? a.group === b.group : b.group === undefined && a.kind === b.kind;
    const runs: Item[][] = [];
    for (const item of devices) {
      const last = runs.at(-1);
      if (last && together(last[0]!.node!, item.node!)) last.push(item);
      else runs.push([item]);
    }
    const blocks = runs.flatMap((run) => {
      const size = Math.ceil(run.length / Math.ceil(run.length / ROW_DEVICES));
      return Array.from({ length: Math.ceil(run.length / size) }, (_, part) => run.slice(part * size, (part + 1) * size));
    }).sort((a, b) => b.length - a.length);
    const load = (line: Item[][]) => line.reduce((sum, block) => sum + block.length, 0);
    let lines: Item[][][] = [];
    for (let count = Math.ceil(devices.length / ROW_DEVICES); ; count++) {
      lines = Array.from({ length: count }, () => []);
      const placed = blocks.every((block) => {
        const line = lines.reduce((best, line) => load(line) < load(best) ? line : best);
        line.push(block);
        return load(line) <= ROW_DEVICES;
      });
      if (placed) break;
    }
    const position = new Map(devices.map((item, i) => [item.key, i]));
    const where = (line: Item[][]) => mean(line.flat().map((item) => position.get(item.key)!));
    for (const line of lines.filter((line) => line.length).sort((a, b) => where(a) - where(b))) {
      for (const item of line.flat()) rowOf.set(item.node!.id, next);
      next++;
    }
  }
  return rowOf;
}

/** Places a row's blocks (a group, or an item on its own) left to right in order, as near as they can all be to where
 * their items want to be (least squares), a group's items side by side, with room between blocks for group frames. */
function pack(row: Item[], wanted: number[]): void {
  const blocks: Array<{ items: Item[]; offsets: number[]; target: number; before: number }> = [];
  let edge = 0;
  for (let index = 0; index < row.length;) {
    const items = [row[index]!];
    while (index + items.length < row.length && blockOf(row[index + items.length]!) === blockOf(items[0]!)) items.push(row[index + items.length]!);
    const offsets: number[] = [];
    let width = -GAP_X;
    for (const item of items) { offsets.push(width + GAP_X); width += item.width + GAP_X; }
    if (index) {
      const previous = row[index - 1]!;
      edge += GAP_X + (items[0]!.node?.group !== undefined || previous.node?.group !== undefined ? 2 * FRAME.pad : 0);
    }
    blocks.push({ items, offsets, target: mean(items.map((_, k) => wanted[index + k]! - offsets[k]!)), before: edge });
    edge += width;
    index += items.length;
  }
  // Pool adjacent violators: each block wants its target less the room the blocks before it take; a block that would
  // then sit left of the one before joins it, and the pool goes to its members' weighted mean.
  const pools: Array<{ value: number; weight: number; size: number }> = [];
  for (const block of blocks) {
    pools.push({ value: block.target - block.before, weight: block.items.length, size: 1 });
    while (pools.length > 1 && pools.at(-2)!.value > pools.at(-1)!.value) {
      const last = pools.pop()!, into = pools.at(-1)!;
      into.value = (into.value * into.weight + last.value * last.weight) / (into.weight + last.weight);
      into.weight += last.weight;
      into.size += last.size;
    }
  }
  let next = 0;
  for (const pool of pools) {
    for (const block of blocks.slice(next, next + pool.size)) block.items.forEach((item, k) => { item.x = pool.value + block.before + block.offsets[k]!; });
    next += pool.size;
  }
}

const height = (node: GraphNode) => ICON.height + 6 + wrap(node.label, LABEL.chars, LABEL.lines).length * LABEL.height
  + (node.note ? wrap(node.note, NOTE.chars, NOTE.lines).length * NOTE.height : 0) + 4;

export function layoutNetwork(graph: VisualizationGraph): NetworkLayout {
  const tiers = tiersOf(graph);
  // Arranged by tier first; a tier too wide to read wraps onto more rows, and those are arranged again.
  const first = arrange(graph, tiers, new Map());
  const rowOf = wrapRows(first.rows);
  const wrapped = Math.max(...rowOf.values()) + 1 > first.rows.length;
  const before = new Map(first.rows.flatMap((row) => row.flatMap((item, i) => item.node ? [[item.node.id, i] as const] : [])));
  const { rows, items, chains } = wrapped ? arrange(graph, rowOf, before) : first;
  const rowOfNode = (id: string) => items.get(`n:${id}`)!.row;

  // Across: packed rows, then each row moved under the links it hangs from (and over the ones below it).
  const centre = (key: string) => { const item = items.get(key)!; return item.x + item.width / 2; };
  for (const row of rows) pack(row, row.map(() => 0));
  for (let pass = 0; pass < 8; pass++) {
    const down = pass % 2 === 0;
    const order = rows.map((_, r) => r);
    for (const r of down ? order.slice(1) : order.reverse().slice(1)) {
      const row = rows[r]!;
      const wanted = row.map((item) => { const others = down ? item.up : item.down; return others.length ? mean(others.map(centre)) - item.width / 2 : item.x; });
      pack(row, wanted);
    }
  }
  const left = Math.min(...[...items.values()].map((item) => item.x - (item.node?.group !== undefined ? FRAME.pad : 0)));
  for (const item of items.values()) item.x = Math.round(item.x - left + MARGIN);

  // Where each link leaves a device: links between the same two devices side by side, the rest from the device's
  // centre, so a device's links down share one line. Links into a device from above meet its top side by side, in the
  // order they come from.
  const pairs = new Map<string, number[]>();
  graph.edges.forEach((edge, i) => { const key = [edge.from, edge.to].sort().join("\n"); pairs.set(key, [...pairs.get(key) ?? [], i]); });
  const offset = (i: number) => { const edge = graph.edges[i]!; const same = pairs.get([edge.from, edge.to].sort().join("\n"))!; return (same.indexOf(i) - (same.length - 1) / 2) * PARALLEL; };
  const exit = (key: string, i: number) => centre(key) + (key.startsWith("n:") ? offset(i) : 0);
  const entering = new Map<string, number[]>();
  chains.forEach((keys, i) => { if (keys) entering.set(keys.at(-1)!, [...entering.get(keys.at(-1)!) ?? [], i]); });
  const entry = new Map<number, { x: number; side: "start" | "end"; level: number }>();
  for (const [key, list] of entering) {
    const from = (i: number) => exit(chains[i]!.at(-2)!, i);
    list.sort((p, q) => from(p) - from(q) || p - q);
    const step = list.length > 1 ? Math.min(12, (ICON.width - 16) / (list.length - 1)) : 0;
    // Their port labels: the left half's to the left of their lines, the rest to the right, the innermost lowest.
    const half = Math.floor(list.length / 2);
    list.forEach((i, j) => entry.set(i, {
      x: Math.round(centre(key) + (j - (list.length - 1) / 2) * step),
      side: j < half ? "end" : "start", level: j < half ? half - 1 - j : j - half,
    }));
  }
  const anchor = (keys: string[], k: number, i: number) => k === keys.length - 1 ? entry.get(i)!.x : exit(keys[k]!, i);

  // Lanes: in each gap, every bus (an upper item's links down) gets a height of its own unless it doesn't overlap another.
  const gaps = rows.map(() => [] as Array<{ key: string; from: number; to: number; lane: number }>);
  const bus = (gap: number, key: string, xs: number[]) => {
    const span = { from: Math.min(...xs), to: Math.max(...xs) };
    const existing = gaps[gap]!.find((entry) => entry.key === key);
    if (existing) { existing.from = Math.min(existing.from, span.from); existing.to = Math.max(existing.to, span.to); }
    else gaps[gap]!.push({ key, ...span, lane: 0 });
  };
  chains.forEach((keys, i) => {
    if (!keys) return;
    for (let k = 1; k < keys.length; k++) {
      const x = anchor(keys, k - 1, i);
      bus(items.get(keys[k - 1]!)!.row, `${keys[k - 1]}@${x}`, [x, anchor(keys, k, i)]);
    }
  });
  const peers = graph.edges.map((edge, i) => {
    if (chains[i] || edge.from === edge.to) return undefined;
    const r = rowOfNode(edge.from);
    const row = rows[r]!.filter((item) => item.node);
    const [a, b] = [`n:${edge.from}`, `n:${edge.to}`].sort((p, q) => centre(p) - centre(q)) as [string, string];
    const beside = Math.abs(row.findIndex((item) => item.key === a) - row.findIndex((item) => item.key === b)) === 1;
    if (!beside) bus(r, `peer:${i}`, [exit(a, i), exit(b, i)]);
    return { a, b, beside };
  });
  for (const gap of gaps) {
    const ends: number[] = [];
    for (const entry of gap.sort((p, q) => p.from - q.from || p.to - q.to)) {
      let lane = ends.findIndex((end) => end + 12 <= entry.from);
      if (lane < 0) { lane = ends.length; ends.push(0); }
      ends[lane] = entry.to;
      entry.lane = lane;
    }
  }

  // Down: each row's band (with room for frame titles), then the gap with its lanes.
  const framed = rows.map((row) => row.some((item) => item.node?.group !== undefined));
  const top: number[] = [], nodesTop: number[] = [], bottom: number[] = [];
  const laneCount = (r: number) => gaps[r]!.length ? Math.max(...gaps[r]!.map((entry) => entry.lane)) + 1 : 0;
  rows.forEach((row, r) => {
    top[r] = r ? bottom[r - 1]! + GAP_Y + Math.max(0, laneCount(r - 1) - 1) * LANE : MARGIN;
    nodesTop[r] = top[r]! + (framed[r] ? FRAME.title + FRAME.pad : 0);
    bottom[r] = nodesTop[r]! + Math.max(...row.filter((item) => item.node).map((item) => height(item.node!)), 0) + (framed[r] ? FRAME.pad : 0);
  });
  const laneY = (gap: number, key: string) => bottom[gap]! + GAP_Y / 2 + gaps[gap]!.find((entry) => entry.key === key)!.lane * LANE;

  const nodes: NetworkNode[] = graph.nodes.map((node) => {
    const item = items.get(`n:${node.id}`)!;
    const y = nodesTop[item.row]!;
    return {
      id: node.id, ...(node.kind ? { kind: node.kind } : {}), tier: tiers.get(node.id)!, ...(node.group !== undefined ? { group: node.group } : {}),
      x: item.x, y, width: NODE_WIDTH, height: height(node),
      icon: { x: item.x + (NODE_WIDTH - ICON.width) / 2, y, width: ICON.width, height: ICON.height },
      label: wrap(node.label, LABEL.chars, LABEL.lines), note: node.note ? wrap(node.note, NOTE.chars, NOTE.lines) : [],
    };
  });
  const boxOf = new Map(nodes.map((node) => [`n:${node.id}`, node]));

  // Each route runs from the upper device (the left one in a row) to the other; the port label sits just above the
  // device a link comes down into.
  const route = (edge: GraphEdge, i: number): { start: string; points: Point[]; labelAt: NetworkLink["labelAt"] } => {
    const keys = chains[i];
    if (keys) {
      const upper = boxOf.get(keys[0]!)!, lower = boxOf.get(keys.at(-1)!)!;
      const points: Point[] = [[anchor(keys, 0, i), upper.y + upper.height]];
      for (let k = 1; k < keys.length; k++) {
        const x = anchor(keys, k - 1, i);
        const y = laneY(items.get(keys[k - 1]!)!.row, `${keys[k - 1]}@${x}`);
        points.push([x, y], [anchor(keys, k, i), y]);
      }
      const { x, side, level } = entry.get(i)!;
      points.push([x, lower.y]);
      return { start: upper.id, points: simplify(points), labelAt: { x: side === "start" ? x + 5 : x - 5, y: lower.y - 6 - level * 11, anchor: side } };
    }
    const peer = peers[i];
    if (!peer) {
      // A device linked to itself: a small loop beside its icon.
      const node = boxOf.get(`n:${edge.from}`)!;
      const [x, y] = [node.icon.x + ICON.width, node.icon.y + ICON.height / 2];
      return { start: node.id, points: [[x, y - 6], [x + 14, y - 6], [x + 14, y + 6], [x, y + 6]], labelAt: { x: x + 18, y: y + 4, anchor: "start" } };
    }
    const a = boxOf.get(peer.a)!, b = boxOf.get(peer.b)!;
    if (peer.beside) {
      const y = a.icon.y + ICON.height / 2 + offset(i);
      return { start: a.id, points: [[a.icon.x + ICON.width, y], [b.icon.x, y]], labelAt: { x: Math.round((a.icon.x + ICON.width + b.icon.x) / 2), y: y - 5, anchor: "middle" } };
    }
    const y = laneY(rowOfNode(a.id), `peer:${i}`);
    const [ax, bx] = [exit(peer.a, i), exit(peer.b, i)];
    return { start: a.id, points: [[ax, a.y + a.height], [ax, y], [bx, y], [bx, b.y + b.height]], labelAt: { x: Math.round((ax + bx) / 2), y: y - 4, anchor: "middle" } };
  };
  const links: NetworkLink[] = graph.edges.map((edge, i) => {
    const { start, points, labelAt } = route(edge, i);
    return {
      from: edge.from, to: edge.to, ...(edge.label !== undefined ? { label: edge.label } : {}),
      points: start === edge.from ? points : [...points].reverse(), labelAt,
    };
  });

  const frames: NetworkFrame[] = [];
  rows.forEach((row, r) => {
    let run: NetworkNode[] = [];
    const close = () => {
      if (run.length) frames.push({ label: run[0]!.group!, x: run[0]!.x - FRAME.pad, y: top[r]!, width: run.at(-1)!.x + NODE_WIDTH - run[0]!.x + 2 * FRAME.pad, height: bottom[r]! - top[r]! });
      run = [];
    };
    for (const item of row) {
      const node = item.node ? boxOf.get(item.key) : undefined;
      if (node?.group !== undefined && run.length && run[0]!.group === node.group) run.push(node);
      else { close(); if (node?.group !== undefined) run = [node]; }
    }
    close();
  });
  const below = laneCount(rows.length - 1) ? GAP_Y + laneCount(rows.length - 1) * LANE : 0;
  const width = Math.max(...[...items.values()].map((item) => item.x + item.width), ...frames.map((frame) => frame.x + frame.width)) + MARGIN;
  return { nodes, links, frames, width, height: bottom.at(-1)! + below + MARGIN };
}

/** Drops repeated points and the middle of three in a straight line. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out.at(-1);
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    const before = out.at(-2);
    if (before && last && ((before[0] === last[0] && last[0] === point[0]) || (before[1] === last[1] && last[1] === point[1]))) out[out.length - 1] = point;
    else out.push(point);
  }
  return out;
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const number = (value: number) => String(Math.round(value * 10) / 10);

/** Casper's own device icons, each in a 64 by 44 box. */
const ICONS: Record<DeviceKind, string> = {
  internet: '<path d="M17 37h31a10 10 0 0 0 1-20 14 14 0 0 0-27-4 10 10 0 0 0-5 24z" fill="#dbe9f9" stroke="#3b78c4" stroke-width="2.5"/>',
  router: '<ellipse cx="32" cy="29" rx="25" ry="9" fill="#1d4f91"/><rect x="7" y="16" width="50" height="13" fill="#2463b4"/><ellipse cx="32" cy="16" rx="25" ry="9" fill="#3b82d6"/><path d="M21 12l7 3m15-3l-7 3m-15 6l7-3m15 3l-7-3" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  firewall: '<rect x="10" y="5" width="44" height="34" rx="2" fill="#c8553d"/><path d="M10 13.5h44M10 22h44M10 30.5h44M21 5v8.5M32 5v8.5M43 5v8.5M16 13.5V22M27 13.5V22M38 13.5V22M49 13.5V22M21 22v8.5M32 22v8.5M43 22v8.5M16 30.5V39M27 30.5V39M38 30.5V39M49 30.5V39" stroke="#fff" stroke-width="1.4"/>',
  gateway: '<rect x="7" y="21" width="50" height="17" rx="3" fill="#7a3fb5"/><circle cx="15" cy="29.5" r="2" fill="#fff"/><circle cx="22" cy="29.5" r="2" fill="#fff"/><path d="M36 29.5h14" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><path d="M24 12a11 11 0 0 1 16 0M27.5 16a6 6 0 0 1 9 0" stroke="#7a3fb5" stroke-width="2.4" fill="none" stroke-linecap="round"/>',
  "core-switch": '<path d="M4 16l8-9h48l-8 9z" fill="#2f6fb5"/><path d="M52 16l8-9v19l-8 9z" fill="#0a3d6b"/><rect x="4" y="16" width="48" height="19" fill="#0b4f8a"/><path d="M11 22h14m-4-3l4 3-4 3M45 29H31m4-3l-4 3 4 3" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  switch: '<path d="M4 17l7-7h49l-7 7z" fill="#6aa8fa"/><path d="M53 17l7-7v15l-7 7z" fill="#1f5fc4"/><rect x="4" y="17" width="49" height="15" fill="#2f81f7"/><path d="M11 22h13m-3.5-2.5l3.5 2.5-3.5 2.5M46 27H33m3.5-2.5L33 27l3.5 2.5" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  "access-point": '<rect x="14" y="27" width="36" height="11" rx="5.5" fill="#2da44e"/><circle cx="32" cy="32.5" r="2" fill="#fff"/><path d="M19 17a18 18 0 0 1 26 0M24.5 21.5a10 10 0 0 1 15 0" stroke="#2da44e" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
  server: '<rect x="21" y="3" width="22" height="38" rx="2" fill="#57606a"/><path d="M25 10h14M25 16h14M25 22h14" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="32" cy="33" r="2.4" fill="#2da44e"/>',
  device: '<rect x="12" y="5" width="40" height="27" rx="2" fill="#57606a"/><rect x="15" y="8" width="34" height="21" fill="#d0d7de"/><path d="M32 32v5M24 39h16" stroke="#57606a" stroke-width="3" stroke-linecap="round"/>',
};

/** Right angles as an SVG path: a start, then horizontal and vertical moves. */
const pathOf = (points: Point[]) => `M${number(points[0]![0])} ${number(points[0]![1])}${points.slice(1).map((point, i) => point[0] === points[i]![0] ? ` V${number(point[1])}` : ` H${number(point[0])}`).join("")}`;

/** The diagram as SVG: frames, links, devices, then port labels on top. */
export function networkSvg(graph: VisualizationGraph, layout: NetworkLayout = layoutNetwork(graph)): string {
  const short = (text: string) => text.length > 26 ? `${text.slice(0, 25)}…` : text;
  const frames = layout.frames.map((frame) => `<g class="frame"><rect x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}" rx="10"/><text class="frame-label" x="${frame.x + 10}" y="${frame.y + 14}">${escape(frame.label)}</text></g>`);
  const links = layout.links.map((link) => `<path class="link" d="${pathOf(link.points)}"><title>${escape(`${link.from} – ${link.to}${link.label ? `: ${link.label}` : ""}`)}</title></path>`);
  const ports = layout.links.flatMap((link) => link.label && link.labelAt
    ? [`<text class="port" x="${number(link.labelAt.x)}" y="${number(link.labelAt.y)}" text-anchor="${link.labelAt.anchor}">${escape(short(link.label))}<title>${escape(link.label)}</title></text>`] : []);
  const devices = layout.nodes.map((node) => {
    const node_ = graph.nodes.find((entry) => entry.id === node.id)!;
    const centre = node.x + node.width / 2;
    const icon = node.kind ? `<use href="#icon-${node.kind}" x="${node.icon.x}" y="${node.icon.y}" width="${ICON.width}" height="${ICON.height}"/>`
      : `<rect class="plain" x="${node.icon.x}" y="${node.icon.y + 4}" width="${ICON.width}" height="${ICON.height - 8}" rx="8"/>`;
    const firstLine = node.y + ICON.height + 6 + 11;
    const label = node.label.map((line, i) => `<tspan x="${centre}" y="${firstLine + i * LABEL.height}">${escape(line)}</tspan>`).join("");
    const note = node.note.length ? `<text class="note" text-anchor="middle">${node.note.map((line, i) => `<tspan x="${centre}" y="${firstLine + node.label.length * LABEL.height + i * NOTE.height}">${escape(line)}</tspan>`).join("")}</text>` : "";
    const title = [node_.label, node.kind ? KIND_NAMES[node.kind] : undefined, node_.note].filter(Boolean).join(" · ");
    return `<g class="device" data-kind="${node.kind ?? "plain"}"><title>${escape(title)}</title>${icon}<text class="label" text-anchor="middle">${label}</text>${note}</g>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="img" aria-label="${escape(graph.title)}">`,
    "<style>.link{fill:none;stroke:#57606a;stroke-width:1.6}.frame rect{fill:#f6f8fa;stroke:#d0d7de}.frame-label{font:600 11px system-ui,sans-serif;fill:#57606a}"
      + ".label{font:600 12px system-ui,sans-serif;fill:#1f2328}.note{font:11px system-ui,sans-serif;fill:#57606a}"
      + ".port{font:10px ui-monospace,Menlo,monospace;fill:#0b4f8a;paint-order:stroke;stroke:#fff;stroke-width:3px}.plain{fill:#eaeef2;stroke:#8c959f}</style>",
    `<defs>${DEVICE_KINDS.map((kind) => `<symbol id="icon-${kind}" viewBox="0 0 64 44">${ICONS[kind]}</symbol>`).join("")}</defs>`,
    ...frames, ...links, ...devices, ...ports,
    "</svg>",
  ].join("\n");
}

/** The page for a network diagram: the drawing, a legend of the kinds in it, and where the editable copies are. */
export function networkPage(graph: VisualizationGraph, files: readonly string[] = []): string {
  const title = escape(graph.title);
  const used = DEVICE_KINDS.filter((kind) => graph.nodes.some((node) => node.kind === kind));
  const legend = used.map((kind) => `<span class="item"><svg viewBox="0 0 64 44" width="32" height="22" aria-hidden="true"><use href="#icon-${kind}"/></svg>${KIND_NAMES[kind]}</span>`).join("");
  const copies = files.length ? ` Editable copies (draw.io has the same layout): ${files.map((file) => `<code>${escape(file)}</code>`).join(", ")}.` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f2328; background: #f6f8fa; }
  header { display: flex; align-items: center; gap: 12px; padding: 12px 24px; background: #fff; border-bottom: 1px solid #d0d7de; }
  h1 { margin: 0; font-size: 18px; font-weight: 600; flex: 1; }
  button { font: inherit; padding: 4px 12px; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; cursor: pointer; }
  button[aria-pressed="true"] { background: #ddf4ff; border-color: #54aeff; }
  main { padding: 24px; overflow: auto; }
  main > svg { display: block; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; }
  main.fit > svg { max-width: 100%; height: auto; }
  .legend { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 0 24px 12px; color: #57606a; font-size: 12px; }
  .legend .item { display: inline-flex; align-items: center; gap: 6px; }
  footer { padding: 0 24px 24px; color: #57606a; font-size: 12px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<header><h1>${title}</h1><button type="button" data-zoom="fit" aria-pressed="true">Fit</button><button type="button" data-zoom="full" aria-pressed="false">Full size</button></header>
<main class="fit">
${networkSvg(graph)}
</main>
<section class="legend" aria-label="Legend">${legend}</section>
<footer>Drawn by Casper from the diagram tool.${copies}</footer>
<script>
  const main = document.querySelector("main");
  for (const button of document.querySelectorAll("[data-zoom]")) button.addEventListener("click", () => {
    main.classList.toggle("fit", button.dataset.zoom === "fit");
    for (const other of document.querySelectorAll("[data-zoom]")) other.setAttribute("aria-pressed", String(other === button));
  });
</script>
</body>
</html>
`;
}
