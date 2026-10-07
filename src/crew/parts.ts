/**
 * The parts builders landed in this task, so a reviewer can be given one by number (the delegate tool's `of`) and the
 * lead never has to relay a diff. Only a part that landed has a number: a kept, failed or empty builder has none.
 * The record lives inside the task's delegate tool, so it starts empty in the next task.
 */
import { redactPreview } from "../tui/format";

/** How much of a part's diff a reviewer is handed. */
export const PART_EXCERPT_BYTES = 24 * 1024;

interface Part {
  goal: string;
  files: string[];
  stat: string;
  excerpt: string;
  /** Reviews started (a review that did not run is given back). */
  started: number;
  /** A fix changed the part, so one more review is allowed. */
  refreshed: boolean;
  reviewed: boolean;
  report?: string;
}

export type PartReview = { context: string } | { refusal: string };

/** A diff as text: hunks of text files as they are, binary files by name only, cut at a line near the limit. */
function excerptOf(patch: Buffer): string {
  const sections = patch.toString("utf8").split(/^(?=diff --git )/m).filter(Boolean);
  const text = sections.map((section) => {
    if (!/^(?:GIT binary patch|Binary files .* differ)$/m.test(section)) return section;
    const named = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
    const name = !named ? "a file" : named[1] === named[2] ? named[2] : `${named[1]} -> ${named[2]}`;
    return `${name} (binary file, not shown)\n`;
  }).join("");
  if (Buffer.byteLength(text) <= PART_EXCERPT_BYTES) return text;
  const head = Buffer.from(text).subarray(0, PART_EXCERPT_BYTES).toString("utf8");
  const whole = head.slice(0, head.lastIndexOf("\n") + 1) || head;
  return `${whole}[The diff is cut here to ${PART_EXCERPT_BYTES / 1024} KiB; read the files for the rest.]\n`;
}

export class PartRecord {
  private readonly parts: Part[] = [];

  /** A part landed in the folder; its number (1, 2, ...) is what the lead gives the reviewer. */
  landed(input: { goal: string; files: string[]; stat: string; patch: Buffer }): number {
    this.parts.push({ goal: input.goal, files: [...input.files], stat: input.stat, excerpt: excerptOf(input.patch),
      started: 0, refreshed: false, reviewed: false });
    return this.parts.length;
  }

  /** What the reviewer is given for part `n`, or why it can't have one. Counts as a review started: give it back
   * with `release` when the reviewer never ran. */
  reviewContext(n: number): PartReview {
    const part = this.parts[n - 1];
    if (!part) return { refusal: `Part ${n} has no review to give: only a part a builder landed has a number, and a kept or failed builder's work has none. Read it in its copy, or look at the files yourself.` };
    if (part.started >= (part.refreshed ? 2 : 1)) return { refusal: `Part ${n} was already reviewed (one review per part, and one more after a fix). Check the rest yourself.` };
    part.started++;
    const goal = redactPreview(part.goal).replace(/\s+/g, " ").trim().slice(0, 500);
    return { context: [
      `Part ${n}, landed in the project folder by a builder in this task (not committed).`,
      `The builder's job: ${goal}`,
      `Files: ${part.files.slice(0, 40).join(", ")}${part.files.length > 40 ? ` and ${part.files.length - 40} more` : ""}`,
      part.stat.trim().slice(0, 4096),
      "The change as applied (a diff; review it, and read the files for the code around it):",
      part.excerpt,
    ].filter(Boolean).join("\n") };
  }

  /** A review that did not run (turned away before it started) is not counted. */
  release(n: number): void {
    const part = this.parts[n - 1];
    if (part && part.started > 0) part.started--;
  }

  /** The reviewer finished: this part counts as reviewed, and its report is kept. */
  markReviewed(n: number, text: string): void {
    const part = this.parts[n - 1];
    if (!part) return;
    part.reviewed = true;
    part.report = text;
  }

  /** The numbers of landed parts no reviewer finished. */
  unreviewed(): number[] {
    return this.parts.flatMap((part, index) => part.reviewed ? [] : [index + 1]);
  }

  /** A fix changed part `n`: its diff is the new one, and one more review is allowed. */
  refreshExcerpt(n: number, patch: Buffer): void {
    const part = this.parts[n - 1];
    if (!part) return;
    part.excerpt = excerptOf(patch);
    part.refreshed = true;
    part.reviewed = false;
  }
}
