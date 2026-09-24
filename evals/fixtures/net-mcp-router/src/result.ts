export const MAX_OUTPUT_CHARS = 4000;

export interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: true;
}

export const toolText = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
export const toolError = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });
