import { readFile } from "./tools/read-file";
import { searchFiles } from "./tools/search-files";
import type { Tool } from "./tool";

export const tools: readonly Tool[] = [readFile, searchFiles];

export function findTool(name: string): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}
