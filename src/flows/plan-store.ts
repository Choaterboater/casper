import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isOutside } from "../platform/inside";
import { extractPlan, planMarkdown, type ParsedPlan } from "./plan";

export interface SavedPlan { file: string; request: string; plan: ParsedPlan }

/** State stays in the project, even when someone replaced .casper with a symlink. */
async function directory(root: string): Promise<string> {
  const base = await realpath(root);
  for (const name of [".casper", ".casper/plans"]) {
    const dir = path.join(base, name);
    await mkdir(dir, { recursive: true });
    if (isOutside(path.relative(base, await realpath(dir)))) throw new Error("Plan folder leaves the project.");
  }
  const plans = path.join(base, ".casper/plans");
  try { await writeFile(path.join(plans, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return plans;
}

export async function savePlan(root: string, request: string, plan: ParsedPlan): Promise<SavedPlan> {
  const dir = await directory(root);
  const slug = (plan.title ?? request).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "plan";
  const stem = `${new Date().toISOString().slice(0, 10)}-${slug}`;
  for (let n = 0; ; n++) {
    const file = path.join(dir, `${stem}${n ? `-${n + 1}` : ""}.md`);
    try {
      await writeFile(file, markdown(request, plan), { flag: "wx", mode: 0o600 });
      return { file, request, plan };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}
function markdown(request: string, plan: ParsedPlan): string {
  return `> Request: ${JSON.stringify(request)}\n\n${planMarkdown(plan)}\n`;
}
export async function readPlan(root: string, file: string): Promise<SavedPlan> {
  const dir = await directory(root);
  if (path.dirname(file) !== dir || (await lstat(file)).isSymbolicLink()) throw new Error("Not a saved plan file.");
  const text = await readFile(file, "utf8");
  const first = /^> Request: (.+)\r?\n/.exec(text);
  let request = "";
  try { const value: unknown = JSON.parse(first?.[1] ?? '""'); if (typeof value === "string") request = value; } catch { /* User may remove the metadata. */ }
  const plan = extractPlan(first ? text.slice(first[0].length) : text);
  return { file, request: request || plan.title || plan.goal?.join(" ") || "Build this plan", plan };
}
export async function updatePlan(root: string, saved: SavedPlan): Promise<void> {
  await readPlan(root, saved.file); // Refuse symlinks and paths from outside this store.
  await writeFile(saved.file, markdown(saved.request, saved.plan), { mode: 0o600 });
}
export async function recentPlans(root: string): Promise<SavedPlan[]> {
  const dir = await directory(root);
  const found = await Promise.all((await readdir(dir)).filter(name => /^\d{4}-\d\d-\d\d-[a-z0-9-]+\.md$/.test(name)).map(async name => {
    try { const file = path.join(dir, name); return { saved: await readPlan(root, file), time: (await lstat(file)).mtimeMs }; } catch { return undefined; }
  }));
  return found.filter(item => item !== undefined).sort((a, b) => b.time - a.time).slice(0, 10).map(item => item.saved);
}

export interface PlanQuestion { question: string; options: { label: string; description?: string }[] }
/** Questions are an answer format, not an exception to the planning tool gate. */
export function planQuestions(text: string): PlanQuestion[] | undefined {
  try {
    const data = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (!Array.isArray(data.questions) || data.questions.length < 1 || data.questions.length > 3) return undefined;
    if (!data.questions.every((q: PlanQuestion) => typeof q?.question === "string" && q.question.trim() && q.question.length <= 300
      && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4
      && q.options.every(o => typeof o?.label === "string" && o.label.trim() && o.label.length <= 150 && (o.description === undefined || typeof o.description === "string")))) return undefined;
    return data.questions;
  } catch { return undefined; }
}
export async function wantsSpec(root: string, request: string): Promise<boolean> {
  if (/\b(?:make|build|create|design)\b[^.!?\n]{0,80}\b(?:app|application|site|website|game)\b/i.test(request)) return true;
  const names = await readdir(root);
  return names.every(name => [".git", ".casper", ".pi", ".DS_Store"].includes(name));
}
