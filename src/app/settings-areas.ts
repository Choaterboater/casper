/** Short tab names fit together at 80 columns; full names explain each area. */
export const SETTINGS_AREAS = [
  { name: "Tools & browser", tab: "+ Tools", labels: ["Web lookups", "Browser tool", "Browser clicks", "GitHub tool", "Untrusted-text reader", "Built-in skills", "Packs", "Starter templates"] },
  { name: "Pages, pictures & diagrams", tab: "◇ Pages", labels: ["Diagram tool", "Pages the AI makes", "Pictures the AI makes", "Open pages in the browser", "Show the AI the pages"] },
  { name: "Commands & checks", tab: "> Checks", labels: ["Routine commands", "Slow commands", "Stalled commands", "Page checks", "Playwright tests", "Compose files", "Helpers that build"] },
  { name: "Models & cost", tab: "$ Models", labels: ["Spend notes", "Spend pause", "Prompt cache", "Lean guidance", "Compact at", "Hide old tool output", "Local models", "Side questions with ?"] },
  { name: "Display", tab: "◐ Display", labels: ["Work shown", "Reasoning headline", "Theme", "Updates", "Notifications", "Suggestions"] },
  { name: "MCP & network", tab: "↔ MCP", labels: ["Network server updates", "My MCP servers", "My language servers"] },
  { name: "Privacy & sign-ins", tab: "* Privacy", labels: ["Send Casper's name to OpenRouter", "Sign-ins from other tools", "Private ssh passwords"] },
] as const;

export function settingsArea(label: string): number {
  if (label.startsWith("Sandbox for MCP server ")) return 5;
  const index = SETTINGS_AREAS.findIndex(area => (area.labels as readonly string[]).includes(label));
  if (index < 0) throw new Error(`No settings area for ${label}`);
  return index;
}

export function groupedSettings<T extends { label: string }>(rows: readonly T[]): T[] {
  return SETTINGS_AREAS.flatMap((_, index) => rows.filter(row => settingsArea(row.label) === index));
}
