import { spawn } from "node:child_process";

/** An editor configured by the person, not by the project or the model. Its flags (e.g. --wait) are kept. */
export async function editPlanFile(file: string): Promise<void> {
  const editor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (!editor) throw new Error("Set VISUAL or EDITOR to edit Markdown; Change the plan still works.");
  await new Promise<void>((resolve, reject) => {
    const arg = process.platform === "win32" ? '"%CASPER_PLAN_FILE%"' : '"$CASPER_PLAN_FILE"';
    const child = spawn(`${editor} ${arg}`, { shell: true, stdio: "inherit", env: { ...process.env, CASPER_PLAN_FILE: file } });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Editor ${signal ? `stopped (${signal})` : `exited with ${code}`}; plan was not accepted.`)));
  });
}
