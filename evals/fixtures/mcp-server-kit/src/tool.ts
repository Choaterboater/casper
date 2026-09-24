import type { ToolResult } from "./result";
import type { InputSchema } from "./validate";

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** Path → file contents. */
export type Workspace = ReadonlyMap<string, string>;

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly annotations: ToolAnnotations;
  call(args: unknown, workspace: Workspace): ToolResult;
}
