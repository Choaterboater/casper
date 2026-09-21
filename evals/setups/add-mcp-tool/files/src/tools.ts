/** MCP-shaped tool catalog: definitions only, no server and no transport. */
export interface JsonSchemaProperty {
  readonly type: "string" | "number" | "boolean";
  readonly description?: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
  execute(args: Readonly<Record<string, unknown>>): string;
}

function text(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`Missing required string argument: ${key}`);
  return value;
}

export const reverseText: ToolDefinition = {
  name: "reverse_text",
  description: "Return the input text reversed character by character.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "Text to reverse." } },
    required: ["text"],
    additionalProperties: false,
  },
  execute: (args) => [...text(args, "text")].reverse().join(""),
};

/** Catalog order is discovery order. */
export const tools: readonly ToolDefinition[] = [reverseText];

export function findTool(name: string): ToolDefinition | undefined {
  return tools.find((tool) => tool.name === name);
}
