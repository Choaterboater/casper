import type { Inventory } from "./inventory";
import { toolError, toolText, type ToolResult } from "./result";
import type { Tool } from "./tool";
import { deviceTools } from "./tools";
import { validate, type InputSchema } from "./validate";

export interface RouterTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputSchema | Record<string, unknown>;
  readonly annotations: Tool["annotations"];
}

const findSchema: InputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Words that must all appear in the tool name or description.", minLength: 1 },
    include_schema: { type: "boolean", description: "Include each tool's input schema." },
  },
  required: ["query"],
  additionalProperties: false,
};

const invokeSchema = (confirm: boolean) => ({
  type: "object",
  properties: {
    name: { type: "string", description: "Device tool name from find_tool." },
    arguments: { type: "object", description: "Arguments for the device tool." },
    ...(confirm ? { confirm: { type: "boolean", description: "Must be true: this may change device configuration." } } : {}),
  },
  required: confirm ? ["name", "arguments", "confirm"] : ["name", "arguments"],
  additionalProperties: false,
});

export const routerTools: readonly RouterTool[] = [
  { name: "find_tool", description: "Search the device tools by keyword.", inputSchema: findSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "invoke_read_tool", description: "Run a read-only device tool found with find_tool.", inputSchema: invokeSchema(false),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "invoke_tool", description: "Run any device tool; requires confirm: true.", inputSchema: invokeSchema(true),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
];

function score(tool: Tool, words: string[]): number {
  const name = tool.name.toLowerCase();
  const text = `${name} ${tool.description.toLowerCase()}`;
  if (!words.every((word) => text.includes(word))) return 0;
  return 1 + words.filter((word) => name.includes(word)).length;
}

export function createRouter(inventory: Inventory, tools: readonly Tool[] = deviceTools) {
  const find = (name: string) => tools.find((tool) => tool.name === name);
  const dispatch = (args: Record<string, unknown>, readOnly: boolean): ToolResult => {
    if (typeof args.name !== "string") return toolError("Invalid arguments: name is required");
    const tool = find(args.name);
    if (!tool) return toolError(`Unknown tool: ${args.name}. Use find_tool.`);
    if (readOnly && !tool.annotations.readOnlyHint) return toolError(`${tool.name} is not a read-only tool; use invoke_tool with confirm: true.`);
    if (args.arguments === null || typeof args.arguments !== "object" || Array.isArray(args.arguments)) return toolError("Invalid arguments: arguments must be an object");
    return tool.call(args.arguments, inventory);
  };
  return {
    listTools: () => routerTools,
    callTool(name: string, args: unknown): ToolResult {
      const record = (args ?? {}) as Record<string, unknown>;
      if (name === "find_tool") {
        const problem = validate(findSchema, args);
        if (problem) return toolError(problem);
        const words = String(record.query).toLowerCase().split(/\s+/).filter(Boolean);
        const found = tools.map((tool) => ({ tool, score: score(tool, words) })).filter((entry) => entry.score > 0)
          .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
          .map(({ tool }) => ({ name: tool.name, description: tool.description, readOnly: tool.annotations.readOnlyHint, ...(record.include_schema ? { inputSchema: tool.inputSchema } : {}) }));
        return toolText(JSON.stringify(found));
      }
      if (name === "invoke_read_tool") return dispatch(record, true);
      if (name === "invoke_tool") {
        if (record.confirm !== true) return toolError("invoke_tool needs confirm: true");
        return dispatch(record, false);
      }
      return toolError(`Unknown tool: ${name}`);
    },
  };
}
