import { MAX_OUTPUT_CHARS, toolError, toolText } from "../result";
import type { Tool } from "../tool";
import { validate, type InputSchema } from "../validate";

const inputSchema: InputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Literal text to find (not a regular expression).", minLength: 1 },
    limit: { type: "integer", description: "Maximum matches to return (1-50).", minimum: 1, maximum: 50, default: 10 },
    caseSensitive: { type: "boolean", description: "Match case exactly. Default false.", default: false },
  },
  required: ["query"],
  additionalProperties: false,
};

export const searchFiles: Tool = {
  name: "search_files",
  description: "Find lines containing literal text across workspace files. Returns `path:line: text`, at most `limit` matches.",
  inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  call(args, workspace) {
    const problem = validate(inputSchema, args);
    if (problem) return toolError(problem);
    const { query, limit = 10, caseSensitive = false } = args as { query: string; limit?: number; caseSensitive?: boolean };
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: string[] = [];
    for (const path of [...workspace.keys()].sort()) {
      workspace.get(path)!.split(/\r?\n/).forEach((line, index) => {
        if ((caseSensitive ? line : line.toLowerCase()).includes(needle)) matches.push(`${path}:${index + 1}: ${line}`);
      });
    }
    if (!matches.length) return toolText(`No matches for ${JSON.stringify(query)}`);
    const lines: string[] = [];
    let used = 0;
    const reserve = 60;
    for (const match of matches.slice(0, limit)) {
      const line = match.length > 200 ? `${match.slice(0, 199)}…` : match;
      if (used + line.length + 1 > MAX_OUTPUT_CHARS - reserve) break;
      lines.push(line);
      used += line.length + 1;
    }
    const omitted = matches.length - lines.length;
    if (omitted > 0) lines.push(`… truncated (${omitted} more matches)`);
    return toolText(lines.join("\n"));
  },
};
