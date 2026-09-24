import type { Field, Plan } from "./types";

const FIELDS: readonly Field[] = ["serial", "site", "role", "primaryIp4"];
const show = (value: string | null) => value ?? "-";

/** Human-readable dry-run plan; one line per device, then a summary. */
export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  for (const device of plan.create) lines.push(`+ create ${device.name} (site ${show(device.site)}, role ${show(device.role)})`);
  for (const update of plan.update) {
    const changes = FIELDS.filter((field) => update.changes[field]).map((field) => `${field} ${show(update.changes[field]!.from)} -> ${show(update.changes[field]!.to)}`);
    lines.push(`~ update ${update.name}: ${changes.join("; ")}`);
  }
  for (const name of plan.onlyInNetbox) lines.push(`? only in NetBox: ${name}`);
  lines.push(`Plan: ${plan.create.length} to create, ${plan.update.length} to update, ${plan.unchanged.length} unchanged, ${plan.onlyInNetbox.length} only in NetBox. Dry run: no changes made.`);
  return `${lines.join("\n")}\n`;
}
