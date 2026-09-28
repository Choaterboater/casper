/** Git commands a model's bash call may not run: each can set aside or throw away the user's uncommitted
 * work (the user may run them). Reads each command in a shell line (split on ; && || | and newlines).
 * A lexical check, not a sandbox: an alias, a script or `sh -c` can still get past it. */
export function blockedGitCommand(command: string): string | undefined {
  for (const segment of command.split(/;|&&|\|\||\||\n/)) {
    const match = /^\(?\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:sudo|command|exec|env|time)\s+)*git((?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*)\s+([\w-]+)(.*)$/.exec(segment.trim());
    if (!match) continue;
    const [, , sub, rest = ""] = match;
    const args = rest.trim().split(/\s+/).filter(Boolean);
    const has = (...flags: string[]) => args.some((arg) => flags.includes(arg) || flags.some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`)));
    let blocked = false;
    switch (sub) {
      case "stash": blocked = !["list", "show"].includes(args[0] ?? ""); break;
      case "reset": blocked = has("--hard", "--merge", "--keep"); break;
      case "checkout": blocked = has("--", ".", "-f", "--force", "-p", "--patch") || args.some((arg) => arg.startsWith(":")); break;
      case "restore": blocked = !(args.length && args.every((arg) => arg === "--staged" || arg === "-S" || !arg.startsWith("-")) && has("--staged", "-S") && !has("--worktree", "-W")); break;
      case "switch": blocked = has("--discard-changes", "-f", "--force"); break;
      case "clean": blocked = !has("-n", "--dry-run"); break;
    }
    if (blocked) return `git ${sub}${args.length ? ` ${args.join(" ")}` : ""}`;
  }
  return undefined;
}
