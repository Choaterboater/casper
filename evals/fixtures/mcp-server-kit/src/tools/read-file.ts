import { MAX_OUTPUT_CHARS, toolError, toolText } from "../result";
import type { Tool } from "../tool";
import { validate, type InputSchema } from "../validate";

const inputSchema: InputSchema = {
  type: "object",
  properties: { path: { type: "string", description: "Workspace path of the file.", minLength: 1 } },
  required: ["path"],
  additionalProperties: false,
};

export const readFile: Tool = {
  name: "read_file",
  description: "Read one workspace file. Output longer than 4000 characters is truncated.",
  inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  call(args, workspace) {
    const problem = validate(inputSchema, args);
    if (problem) return toolError(problem);
    const path = (args as { path: string }).path;
    const text = workspace.get(path);
    if (text === undefined) return toolError(`No such file: ${path}`);
    if (text.length <= MAX_OUTPUT_CHARS) return toolText(text);
    const marker = `\n… truncated (${text.length} characters total)`;
    return toolText(text.slice(0, MAX_OUTPUT_CHARS - marker.length) + marker);
  },
};
