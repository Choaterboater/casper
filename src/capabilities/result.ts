import { isRecord } from "../mcp/config";
import { formatTerminalJSON } from "../tui/json";

/** One list that was cut to fit: where it is, how many items are shown, and how many there were. */
export interface CutList { path: string; shown: number; total: number }

export interface BoundedCapabilityResult {
  isError: boolean;
  /** MCP only: true when the server answered, false when Casper never sent the call, "unknown" when it may have run. */
  executed?: boolean | "unknown";
  summary: string;
  truncated: boolean;
  originalBytes: number;
  /** MCP only: the server's next-page token, kept even when the rest is cut to a preview. */
  nextCursor?: { path: string; value: string };
  /** Each list that was cut. */
  lists?: CutList[];
  /** MCP only: text blocks that repeated structuredContent were left out. */
  duplicateTextDropped?: true;
  data?: unknown;
  preview?: string;
}

/** A call Casper refused or stopped before anything was sent. It did not run. */
export class NotExecutedError extends Error {
  constructor(readonly reason: string) {
    super(`Not executed (${reason})`);
    this.name = "NotExecutedError";
  }
}

/** A call that was sent but whose outcome is unknown (timeout, lost connection, server error). */
export class OutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeUnknownError";
  }
}

/**
 * The result the model sees for a failed capability call. It never says "Complete result": a refusal
 * reads "Not executed (…)." and a call that may have run says so. Errors that are neither known kind
 * are reported as "may have run", the safe side.
 */
export function capabilityErrorResult(error: unknown): BoundedCapabilityResult {
  const message = typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message : String(error ?? "Capability failed");
  const sentence = (text: string) => /[.!?]$/.test(text) ? text : `${text}.`;
  let executed: boolean | "unknown" = "unknown";
  let summary = sentence(message.slice(0, 2048) || "Capability failed");
  if (error instanceof NotExecutedError) executed = false;
  else if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError") {
    // An abort that reaches here was raised before anything was sent (sent calls become OutcomeUnknownError).
    executed = false;
    summary = "Not executed (cancelled).";
  }
  const result: BoundedCapabilityResult = { isError: true, executed, summary, truncated: false, originalBytes: 0 };
  result.originalBytes = Buffer.byteLength(message);
  return result;
}

export interface BoundOptions {
  /** An MCP tools/call result: adds `executed`, the next-page cursor, and drops text that repeats structuredContent. */
  mcp?: boolean;
}

const CURSOR_KEYS = ["next_cursor", "nextCursor", "next_page_token", "nextPageToken", "next", "cursor"];
const CURSOR_HOMES = ["_pagination", "pagination", "meta", "links"];
const MAX_CURSOR_BYTES = 2048;
const MAX_LIST_REPORTS = 10;
const MAX_RESHAPES = 6;

function decodeJSON(text: string): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

/** Key-order-independent deep equality for decoded JSON. */
function sameJSON(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJSON(item, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJSON(a[key], b[key]));
}

function pathKey(parent: string, key: string): string {
  const safe = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : undefined;
  if (!parent) return safe ?? `[${JSON.stringify(key)}]`;
  return safe ? `${parent}.${safe}` : `${parent}[${JSON.stringify(key)}]`;
}

/** The first continuation token in one container: top level first, then under _pagination/pagination/meta/links. */
function cursorIn(container: unknown, base: string): { path: string; value: string } | undefined {
  if (!isRecord(container)) return undefined;
  const places: [Record<string, unknown>, string][] = [[container, base]];
  for (const home of CURSOR_HOMES) {
    const inner = container[home];
    if (isRecord(inner)) places.push([inner, pathKey(base, home)]);
  }
  for (const [place, at] of places) {
    for (const key of CURSOR_KEYS) {
      const value = place[key];
      if (typeof value === "string" && value && Buffer.byteLength(value) <= MAX_CURSOR_BYTES) return { path: pathKey(at, key), value };
    }
  }
  return undefined;
}

/** Look for the next-page token on the original result, before anything is cut. */
function findCursor(value: unknown): { path: string; value: string } | undefined {
  if (!isRecord(value)) return undefined;
  const structured = cursorIn(value.structuredContent, "structuredContent");
  if (structured) return structured;
  if (!Array.isArray(value.content)) return undefined;
  for (const [index, block] of value.content.entries()) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    const decoded = decodeJSON(block.text);
    if (!decoded.ok) continue;
    const found = cursorIn(decoded.value, `content[${index}].data`);
    if (found) return found;
  }
  return undefined;
}

/**
 * Drop text blocks that only repeat structuredContent: the whole value, its FastMCP `result` wrapper,
 * the Python SDK's one-block-per-item list fan-out, or a primitive `result` as plain text.
 * Different text (a summary line, a table) and non-text blocks are kept.
 */
function dropDuplicateText(content: unknown[], structured: unknown): { content: unknown[]; dropped: boolean } {
  const wrapped = isRecord(structured) && Object.hasOwn(structured, "result") ? structured.result : undefined;
  const texts = content.map((block, index) => ({ block, index }))
    .filter((item): item is { block: { type: "text"; text: string }; index: number } =>
      isRecord(item.block) && item.block.type === "text" && typeof item.block.text === "string");
  if (!texts.length) return { content, dropped: false };
  const drop = new Set<number>();
  // Python SDK 2.x: a list return becomes one text block per element.
  if (Array.isArray(wrapped) && texts.length === wrapped.length && texts.length > 1 && texts.every(({ block }, i) => {
    const decoded = decodeJSON(block.text);
    const item = wrapped[i];
    return (decoded.ok && sameJSON(decoded.value, item)) || (typeof item === "string" && block.text === item);
  })) {
    for (const { index } of texts) drop.add(index);
  }
  for (const { block, index } of texts) {
    const decoded = decodeJSON(block.text);
    if (decoded.ok && (sameJSON(decoded.value, structured) || (wrapped !== undefined && sameJSON(decoded.value, wrapped)))) drop.add(index);
    else if (!decoded.ok && wrapped !== undefined && wrapped !== null && typeof wrapped !== "object" && block.text === String(wrapped)) drop.add(index);
  }
  if (!drop.size) return { content, dropped: false };
  return { content: content.filter((_, index) => !drop.has(index)), dropped: true };
}

/**
 * Bound a result so that the entire serialized envelope, not just its data, fits maxBytes.
 *
 * Each list is cut on its own to maxItems (a list that was cut is reported in `lists`). When the
 * envelope is still too big, the per-list limit is halved (50, 25, 12, 6, 3, 1) and only when one
 * item per list still does not fit is the result cut to a preview. A result that is a single text
 * block previews its own text. For MCP results, the next-page cursor is found on the original value
 * and always kept, and text that repeats structuredContent is dropped first.
 */
export function boundCapabilityResult(value: unknown, maxBytes = 16_384, maxItems = 50, options: BoundOptions = {}): BoundedCapabilityResult {
  if (maxBytes < 512 || maxItems < 1) throw new Error("Invalid capability result budget");
  const source = JSON.stringify(value) ?? "null";
  const originalBytes = Buffer.byteLength(source);
  const isError = isRecord(value) && value.isError === true;
  const nextCursor = options.mcp ? findCursor(value) : undefined;
  let omitted = false;

  // Decode only protocol content blocks, never similarly shaped application data.
  const normalizeContent = (block: unknown): unknown => {
    if (!isRecord(block)) return block;
    if (block.type === "image" || block.type === "audio") {
      omitted = true;
      const { data: _data, ...metadata } = block;
      return { ...metadata, omitted: "binary MCP content is not exposed" };
    }
    if (block.type === "resource" && isRecord(block.resource) && typeof block.resource.blob === "string") {
      omitted = true;
      const { blob: _blob, ...resource } = block.resource;
      return { ...block, resource, omitted: "binary MCP content is not exposed" };
    }
    if (block.type === "text" && typeof block.text === "string") {
      const decoded = decodeJSON(block.text);
      if (decoded.ok) {
        const { text: _text, ...metadata } = block;
        return { ...metadata, type: "json", data: decoded.value };
      }
    }
    return block;
  };
  let duplicateTextDropped = false;
  let normalized = value;
  if (isRecord(value) && Array.isArray(value.content)) {
    let content: unknown[] = value.content;
    if (options.mcp && value.structuredContent !== undefined) {
      const deduplicated = dropDuplicateText(content, value.structuredContent);
      content = deduplicated.content;
      duplicateTextDropped = deduplicated.dropped;
    }
    normalized = { ...value, content: content.map(normalizeContent) };
  }

  // Shape with a per-list limit, recording each list that was cut.
  const shapeWith = (limit: number) => {
    const lists: CutList[] = [];
    let cutLists = 0;
    let depthCut = false;
    let longest = 0;
    const shape = (item: unknown, at: string, depth: number): unknown => {
      if (depth > 16) { depthCut = true; return "[depth limit]"; }
      if (Array.isArray(item)) {
        longest = Math.max(longest, item.length);
        if (item.length > limit) {
          cutLists++;
          if (lists.length < MAX_LIST_REPORTS) lists.push({ path: at || "(result)", shown: limit, total: item.length });
        }
        return item.slice(0, limit).map((child, index) => shape(child, `${at}[${index}]`, depth + 1));
      }
      if (!isRecord(item)) return item;
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, shape(child, pathKey(at, key), depth + 1)]));
    };
    const data = shape(normalized, "", 0);
    return { data, lists, cutLists, depthCut, longest };
  };

  const summaryFor = (shaped: { lists: CutList[]; cutLists: number; depthCut: boolean } | undefined): string => {
    if (isError) {
      const partial = !shaped || shaped.cutLists > 0 || shaped.depthCut || omitted;
      return `${options.mcp ? "The server said the call failed." : "The call failed."}${partial ? " Only part of the answer is shown." : ""}`;
    }
    const more = nextCursor ? " More: call again with next_cursor." : options.mcp ? " The server gave no next page; narrow the request." : " Narrow the request.";
    if (!shaped) return `Partial result: too big to show, first part only.${nextCursor ? " More: call again with next_cursor." : ""}`;
    if (shaped.cutLists) {
      const named = shaped.lists.slice(0, 3).map((list) => `${list.path} shows ${list.shown} of ${list.total}`);
      const rest = shaped.cutLists - named.length;
      return `Partial result: ${named.join(", ")}${rest > 0 ? ` and ${rest} more ${rest === 1 ? "list" : "lists"} cut` : ""}.${more}`;
    }
    if (shaped.depthCut) return "Partial result: deeply nested parts were left out.";
    if (omitted) return "Partial result: binary content was left out.";
    return "Complete result.";
  };

  const envelope = (shaped: ReturnType<typeof shapeWith> | undefined): BoundedCapabilityResult => {
    const result: BoundedCapabilityResult = {
      isError,
      ...(options.mcp ? { executed: true } : {}),
      summary: summaryFor(shaped),
      truncated: !shaped || shaped.cutLists > 0 || shaped.depthCut || omitted,
      originalBytes,
    };
    if (nextCursor) result.nextCursor = nextCursor;
    if (shaped?.lists.length) result.lists = shaped.lists;
    if (duplicateTextDropped) result.duplicateTextDropped = true;
    if (shaped) result.data = shaped.data;
    return result;
  };
  const fits = (result: BoundedCapabilityResult) => Buffer.byteLength(JSON.stringify(result)) <= maxBytes;

  let limit = maxItems;
  let shaped = shapeWith(limit);
  let result = envelope(shaped);
  for (let round = 0; !fits(result) && round < MAX_RESHAPES && limit > 1 && shaped.longest > Math.floor(limit / 2); round++) {
    limit = Math.max(1, Math.floor(limit / 2));
    shaped = shapeWith(limit);
    result = envelope(shaped);
  }
  if (fits(result)) return result;

  // Preview: the head of a lone text block itself (real newlines), otherwise the head of the JSON.
  result = envelope(undefined);
  const content = isRecord(normalized) && Array.isArray(normalized.content) ? normalized.content : undefined;
  const lone = content?.length === 1 && isRecord(content[0]) && content[0].type === "text" && typeof content[0].text === "string"
    && !(isRecord(normalized) && normalized.structuredContent !== undefined) ? content[0].text : undefined;
  const preview = lone ?? JSON.stringify(shaped.data) ?? "null";
  let low = 0;
  let high = preview.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    result.preview = preview.slice(0, middle);
    if (fits(result)) low = middle;
    else high = middle - 1;
  }
  // Avoid ending a preview halfway through a UTF-16 surrogate pair.
  if (low && /[\uD800-\uDBFF]/.test(preview[low - 1]!)) low--;
  result.preview = preview.slice(0, low);
  return result;
}

/** A tool observation bounded in its delivered encoding: terminal escaping can expand
 * otherwise bounded JSON, so the budget shrinks until the encoded text fits 16 KiB. */
export function boundedObservation(value: unknown, label = "Observation"): string {
  for (let budget = 16_384; budget >= 512; budget /= 2) {
    const text = formatTerminalJSON(boundCapabilityResult(value, budget));
    if (Buffer.byteLength(text) <= 16_384) return text;
  }
  throw new Error(`${label} exceeds the encoded result budget`);
}
