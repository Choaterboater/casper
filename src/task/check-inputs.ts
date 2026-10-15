import path from "node:path";
import { readProjectText } from "../platform/files";
import { splitShell } from "../sandbox/remote";

const INTERPRETERS = new Set(["sh", "bash", "zsh", "node", "bun", "deno", "tsx", "ts-node", "python", "python3", "ruby", "perl", "php", "pwsh", "powershell"]);
const CONFIG_OPTIONS = new Set(["--config", "-c", "--config-file", "--configFile", "--project", "-p"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Literal files a check runs or names as settings, including package scripts. Not a shell evaluator:
 * dynamic script paths are left for the comparison's explicit cannot-run result, never expanded. */
export async function checkInputs(root: string, command: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  let scripts: Record<string, unknown> = {};
  try { scripts = JSON.parse(await readProjectText(root, "package.json", 1024 * 1024) ?? "{}").scripts ?? {}; } catch { /* no readable package scripts */ }
  const found = new Set<string>();
  const visited = new Set<string>();
  const visit = (text: string, depth: number) => {
    if (depth > 8) throw new Error("check input wrappers are nested too deeply to resolve safely");
    if (visited.has(text)) return;
    visited.add(text);
    for (const { words } of splitShell(text, platform === "win32").segments) {
      let at = 0;
      while (words[at] && (/^[A-Za-z_]\w*=/.test(words[at]!) || ["env", "exec", "npx", "bunx"].includes(words[at]!))) at++;
      const name = words[at];
      if (!name) continue;
      const base = path.posix.basename(name.replaceAll("\\", "/")).replace(/\.exe$/i, "");
      const windowsPaths = platform === "win32" || base === "bun";
      const add = (file: string) => found.add(windowsPaths ? file.replaceAll("\\", "/") : file);
      // A literal shell -c command still names inputs; changing cwd must not let an
      // absolute script hidden in that wrapper run against the live workspace.
      if (SHELLS.has(base)) {
        const option = words.findIndex((word, index) => index > at && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word));
        if (option > at && words[option + 1]) { visit(words[option + 1]!, depth + 1); continue; }
      }
      const manager = ["npm", "pnpm", "yarn", "bun"].includes(base);
      const run = words[at + 1];
      const script = manager ? ["run", "run-script"].includes(run ?? "") ? words[at + 2] : base !== "bun" ? run : undefined : undefined;
      if (script && typeof scripts[script] === "string") {
        for (const key of [`pre${script}`, script, `post${script}`]) if (typeof scripts[key] === "string") visit(scripts[key] as string, depth + 1);
      }
      // An absolute interpreter path is the installed runner, not an input to copy.
      if (!INTERPRETERS.has(base) && /[\\/]/.test(name)) add(name);
      if (INTERPRETERS.has(base) && !(script && typeof scripts[script] === "string")) {
        let index = at + 1;
        if (["bun", "deno"].includes(base) && words[index] === "test") {
          for (const word of words.slice(index + 1)) if (!word.startsWith("-")) add(word);
        } else {
          if (["bun", "deno"].includes(base) && words[index] === "run") index++;
          while (words[index]?.startsWith("-") && !["-c", "-e", "-m"].includes(words[index]!)) index++;
          if (words[index] && !words[index]!.startsWith("-")) add(words[index]!);
        }
      }
      for (let index = at + 1; index < words.length; index++) {
        const word = words[index]!;
        const option = /^(--?[\w-]+)=(.+)$/.exec(word);
        if (option && CONFIG_OPTIONS.has(option[1]!)) add(option[2]!);
        else if (CONFIG_OPTIONS.has(word) && !(INTERPRETERS.has(base) && word === "-c") && words[index + 1]) add(words[++index]!);
      }
    }
  };
  visit(command, 0);
  return [...found];
}
