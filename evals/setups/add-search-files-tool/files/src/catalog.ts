import { readFile } from "./tools/read-file";
import type { Tool } from "./tool";

export const tools: readonly Tool[] = [readFile];

export function findTool(name: string): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}
