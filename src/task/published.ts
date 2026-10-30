/**
 * What a task sent out that /undo can't take back: a git push (branches and tags), a GitHub release or pull request, a
 * package or image published. Read from the AI's successful shell commands and what they printed, never guessed beyond
 * them: Casper doesn't ask GitHub or a registry. The receipt says each on its Published row.
 */
import { splitShell } from "../sandbox/remote";

/** Said after the Published row's words. */
export const PUBLISHED_NOTE = "can't be undone with /undo";

const REF = /^\s*[+*=\-t ]?\s*(\[new tag\]|\[new branch\]|\[new reference\]|\[deleted\]|[0-9a-f]{4,}\.{2,3}[0-9a-f]{4,})\s+(\S+)(?:\s+->\s+(\S+))?/;

/** "example/sensor-lib" from a GitHub address, else the address without its scheme and .git. */
function repoName(url: string): string {
  const github = /github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url);
  if (github) return github[1]!;
  return url.replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]+@/, "").replace(/\.git\/?$/, "");
}

/** git's subcommand: the first word after `git` and its own options (`-C <dir>`, `-c <name=value>`). */
function gitSubcommand(words: readonly string[]): string | undefined {
  if (words[0] !== "git") return undefined;
  for (let at = 1; at < words.length; at++) {
    const word = words[at]!;
    if (word === "-C" || word === "-c" || word === "--git-dir" || word === "--work-tree") { at++; continue; }
    if (!word.startsWith("-")) return word;
  }
  return undefined;
}

/** The words after `name` in a segment, flags left out. */
function operands(words: readonly string[], from: number): string[] {
  return words.slice(from).filter((word) => !word.startsWith("-"));
}

export class Published {
  private readonly pushes = new Map<string, { branches: Set<string>; tags: Set<string>; deleted: Set<string> }>();
  private readonly other: string[] = [];

  private say(line: string): void { if (!this.other.includes(line) && this.other.length < 12) this.other.push(line); }

  /** One shell command the AI ran, and what it printed. */
  observe(command: string, output: string, failed: boolean): void {
    if (command.length > 16_384) return;
    const segments = splitShell(command).segments.map((segment) => segment.words);
    // A push says what it sent in its own output, even when a later part of the line failed. A dry run sends nothing.
    const pushes = segments.filter((words) => gitSubcommand(words) === "push" && !words.some((word) => word === "--dry-run" || word === "-n"));
    if (pushes.length) this.pushed(output, failed, pushes[0]!);
    for (const words of segments) {
      const [name, sub, verb] = words;
      if (name === "gh" && sub === "release" && ["create", "upload", "edit", "delete"].includes(verb ?? "")) {
        const tag = operands(words, 3)[0];
        const url = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\/tag\/\S+/.exec(output)?.[0];
        if (failed && !url) continue;
        const what = verb === "create" ? "created" : verb === "upload" ? "uploaded files to" : verb === "edit" ? "edited" : "deleted";
        this.say(`${what} GitHub release${tag ? ` ${tag}` : ""}`);
      } else if (name === "gh" && sub === "pr" && (verb === "create" || verb === "merge")) {
        const url = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(output);
        if (failed && !url) continue;
        const pr = url ? ` ${url[1]}#${url[2]}` : operands(words, 3)[0] ? ` ${operands(words, 3)[0]}` : "";
        this.say(verb === "create" ? `opened pull request${pr}` : `merged pull request${pr}`);
      } else if (failed) continue;
      else if (name === "gh" && sub === "repo" && verb === "create") this.say(`created GitHub repository${operands(words, 3)[0] ? ` ${operands(words, 3)[0]}` : ""}`);
      else if (["npm", "pnpm", "yarn"].includes(name ?? "") && sub === "publish") this.say("published to npm");
      else if (name === "cargo" && sub === "publish") this.say("published to crates.io");
      else if ((name === "twine" && sub === "upload") || ((name === "uv" || name === "poetry" || name === "flit") && sub === "publish")) this.say("published to PyPI");
      else if ((name === "docker" || name === "podman") && sub === "push") this.say(`pushed image${operands(words, 2)[0] ? ` ${operands(words, 2)[0]}` : ""}`);
    }
  }

  private pushed(output: string, failed: boolean, push: string[]): void {
    let repo: string | undefined;
    let found = false;
    for (const line of output.split(/\r?\n/)) {
      const to = /^To (\S+)/.exec(line.trim());
      if (to) { repo = repoName(to[1]!); continue; }
      const ref = REF.exec(line);
      if (!ref || /\[rejected\]|\(.*rejected.*\)/.test(line)) continue;
      const name = (ref[3] ?? ref[2]!).replace(/^refs\/(?:heads|tags)\//, "");
      const entry = this.entry(repo ?? "its remote");
      if (ref[1] === "[deleted]") entry.deleted.add(ref[2]!.replace(/^refs\/(?:heads|tags)\//, ""));
      else if (ref[1] === "[new tag]" || (ref[3] ?? ref[2]!).startsWith("refs/tags/")) entry.tags.add(name);
      else entry.branches.add(name);
      found = true;
    }
    if (found || failed || /Everything up-to-date/.test(output)) return;
    // A push that printed nothing Casper can read (quiet, or the output was cut): said from its words.
    const args = operands(push, push.indexOf("push") + 1);
    const entry = this.entry(args[0] ?? "its remote");
    for (const ref of args.slice(1)) entry.branches.add(ref.replace(/^.*:/, ""));
    if (push.includes("--tags")) entry.tags.add("all tags");
  }

  private entry(repo: string) {
    let entry = this.pushes.get(repo);
    if (!entry) this.pushes.set(repo, entry = { branches: new Set(), tags: new Set(), deleted: new Set() });
    return entry;
  }

  /** "pushed main and tag v0.3.5 to example/sensor-lib", "created GitHub release v0.3.5". */
  lines(): string[] {
    const pushes = [...this.pushes].map(([repo, { branches, tags, deleted }]) => {
      const named = (word: string, items: Set<string>) => items.size ? [`${word}${items.size > 1 ? "s" : ""} ${[...items].join(", ")}`] : [];
      const sent = [...branches, ...named("tag", tags)];
      const parts = [...sent.length ? [`pushed ${sent.join(" and ")}`] : [], ...deleted.size ? [`deleted ${[...deleted].join(", ")}`] : []];
      return `${parts.length ? parts.join(" and ") : "pushed"} ${sent.length || !deleted.size ? "to" : "on"} ${repo}`;
    });
    return [...pushes, ...this.other];
  }
}
