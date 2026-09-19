import { isRecord } from "../mcp/config";

export interface BoundedCapabilityResult {
  isError: boolean;
  truncated: boolean;
  originalBytes: number;
  data?: unknown;
  preview?: string;
  summary: string;
}

/** The entire serialized envelope, not just its text field, fits maxBytes. */
export function boundCapabilityResult(value: unknown, maxBytes = 16_384, maxItems = 50): BoundedCapabilityResult {
  if (maxBytes < 512 || maxItems < 1) throw new Error("Invalid capability result budget");
  const source = JSON.stringify(value) ?? "null";
  const originalBytes = Buffer.byteLength(source);
  let truncated = false;
  let remaining = maxItems;
  const shape = (item: unknown, depth = 0): unknown => {
    if (depth > 16) { truncated = true; return "[depth limit]"; }
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      for (const child of item) {
        if (remaining-- <= 0) { truncated = true; break; }
        result.push(shape(child, depth + 1));
      }
      return result;
    }
    if (!isRecord(item)) return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, shape(child, depth + 1)]));
  };
  // Decode only protocol content blocks, never similarly shaped application data.
  const normalizeContent = (block: unknown): unknown => {
    if (!isRecord(block)) return block;
    if (block.type === "image" || block.type === "audio") {
      truncated = true;
      const { data, ...metadata } = block;
      return { ...metadata, omitted: "binary MCP content is not exposed" };
    }
    if (block.type === "resource" && isRecord(block.resource) && typeof block.resource.blob === "string") {
      truncated = true;
      const { blob, ...resource } = block.resource;
      return { ...block, resource, omitted: "binary MCP content is not exposed" };
    }
    if (block.type === "text" && typeof block.text === "string") {
      try {
        const { text, ...metadata } = block;
        return { ...metadata, type: "json", data: JSON.parse(text) };
      } catch { /* ordinary text */ }
    }
    return block;
  };
  const data = shape(isRecord(value) && Array.isArray(value.content)
    ? { ...value, content: value.content.map(normalizeContent) }
    : value);
  const result: BoundedCapabilityResult = {
    isError: isRecord(value) && value.isError === true, truncated, originalBytes, data,
    summary: truncated ? "Result truncated; use narrower arguments or provider read pagination. No raw artifact retained." : "Complete result.",
  };
  if (Buffer.byteLength(JSON.stringify(result)) <= maxBytes) return result;
  result.truncated = true;
  result.summary = "Result truncated by byte budget; preview only. No raw artifact retained; do not replay consequential calls.";
  delete result.data;
  const preview = JSON.stringify(data) ?? "null";
  let low = 0;
  let high = preview.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    result.preview = preview.slice(0, middle);
    if (Buffer.byteLength(JSON.stringify(result)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Avoid ending a preview halfway through a UTF-16 surrogate pair.
  if (low && /[\uD800-\uDBFF]/.test(preview[low - 1]!)) low--;
  result.preview = preview.slice(0, low);
  return result;
}
