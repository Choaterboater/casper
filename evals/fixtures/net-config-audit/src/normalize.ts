import type { Vendor } from "./vendor";

function junos(lines: string[]): string[] {
  return lines
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.replace(/"\$9\$[^"]*"/g, '"$9$<masked>"'));
}

function aoscx(lines: string[]): string[] {
  const result: string[] = [];
  const stack: { indent: number; text: string }[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("!") || /^Current configuration:?$/.test(trimmed)) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    if (trimmed === "exit") continue;
    const path = [...stack.map((entry) => entry.text), trimmed].join(" > ");
    result.push(path);
    stack.push({ indent, text: trimmed });
  }
  return result;
}

export function normalizeConfig(vendor: Vendor, text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+$/, "")).filter((line) => line.trim() !== "");
  return vendor === "junos" ? junos(lines) : aoscx(lines);
}
