/**
 * The parts builders landed in this task, so a reviewer can be given one by number (the delegate tool's `of`) and the
 * lead never has to relay a diff. Only a part that landed has a number: a kept, failed or empty builder has none.
 * The record lives inside the task's delegate tool, so it starts empty in the next task.
 */
import { redactPreview } from "../tui/format";
import type { PartNotReviewed } from "../task/result";

/** How much of a part's diff a reviewer is handed. */
export const PART_EXCERPT_BYTES = 24 * 1024;
/** How much of a reviewer's report a fix builder is handed. */
export const PART_REPORT_BYTES = 8 * 1024;

/** What a fix builder is told, ahead of the report. */
const FIX_RULE = "Fix only these findings: check each one is real before you edit, and do not widen the change. If a finding is not real, say so in your report.";

interface Part {
  goal: string;
  files: string[];
  /** The stat of the part's first change. */
  stat: string;
  /** The stat of the fix's own change, once a fix landed. */
  fixStat?: string;
  excerpt: string;
  /** Bumped by each fix that lands: a review belongs to the version it started with, and each version gets one. */
  version: number;
  /** Reviews started on this version (a review that did not run is given back). */
  started: number;
  reviewed: boolean;
  /** Why the last review of this version did not finish (a timeout, a failure, a cutoff), in plain words. */
  notFinished?: string;
  /** The one fix round this part gets was started. */
  fixed: boolean;
  report?: string;
}

/** What a fix builder is given, and the [crew] line that says a builder is fixing the part. */
export type PartReview = { context: string; said: string } | { refusal: string };
/** A review's context, the version of the part it was made from (hand it back to `markReviewed` and `release`), and
 * the [crew] line that says a reviewer is checking it. */
export type ReviewStart = { context: string; version: number; said: string } | { refusal: string };

/** In plain words, why a reviewer that did not end `completed` leaves its part "not reviewed". */
const NOT_FINISHED: Record<string, string> = {
  timed_out: "the reviewer timed out", failed: "the reviewer failed", limited: "the reviewer was cut off", cancelled: "the reviewer was stopped",
};

/** Problems a reviewer's report lists: its top-level numbered or bulleted lines. Undefined when it lists none (it may
 * be prose), so no number is guessed. */
function problemCount(report: string | undefined): number | undefined {
  const count = (report ?? "").split("\n").filter((line) => /^(?:\d+[.)]|[-*\u2022])\s+\S/.test(line)).length;
  return count || undefined;
}

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
      version: 0, started: 0, reviewed: false, fixed: false });
    return this.parts.length;
  }

  /** What the reviewer is given for part `n`, or why it can't have one. Counts as a review started: give it back
   * with `release` when the reviewer never ran. */
  reviewContext(n: number): ReviewStart {
    const part = this.parts[n - 1];
    if (!part) return { refusal: `Part ${n} has no review to give: only a part a builder landed has a number, and a kept or failed builder's work has none. Read it in its copy, or look at the files yourself.` };
    if (part.started >= 1) return { refusal: `Part ${n} was already reviewed (one review per part, and one more after a fix). Check the rest yourself.` };
    part.started++;
    const goal = redactPreview(part.goal).replace(/\s+/g, " ").trim().slice(0, 500);
    return { context: [
      `Part ${n}, landed in the project folder by a builder in this task (not committed).`,
      `The builder's job: ${goal}`,
      `Files: ${part.files.slice(0, 40).join(", ")}${part.files.length > 40 ? ` and ${part.files.length - 40} more` : ""}`,
      part.fixStat === undefined ? part.stat.trim().slice(0, 4096)
        : `The part's first change:\n${part.stat.trim().slice(0, 2048)}\nThe fix's own change:\n${part.fixStat.trim().slice(0, 2048)}`,
      "The change as applied (a diff; review it, and read the files for the code around it):",
      part.excerpt,
    ].filter(Boolean).join("\n"), version: part.version,
    said: `A reviewer is checking part ${n} (${part.files.length} file${part.files.length === 1 ? "" : "s"})` };
  }

  /** A review that did not run (turned away before it started) is not counted. */
  release(n: number, version: number): void {
    const part = this.parts[n - 1];
    if (part && part.version === version && part.started > 0) part.started--;
  }

  /** The reviewer finished: this part counts as reviewed, and its report is kept. A review of an older version (a
   * fix landed while it ran) says nothing about the part as it is now, so it is ignored. */
  markReviewed(n: number, text: string, version: number): void {
    const part = this.parts[n - 1];
    if (!part || part.version !== version) return;
    part.reviewed = true;
    part.notFinished = undefined;
    part.report = text;
  }

  /** The reviewer ended without finishing (status other than `completed`): the part stays not reviewed, and says why.
   * A review of an older version is ignored, as in `markReviewed`. */
  reviewFailed(n: number, status: string, version: number): void {
    const part = this.parts[n - 1];
    if (!part || part.version !== version || part.reviewed) return;
    part.notFinished = NOT_FINISHED[status] ?? "the reviewer did not finish";
  }

  /** The numbers of landed parts no reviewer finished. */
  unreviewed(): number[] {
    return this.parts.flatMap((part, index) => part.reviewed ? [] : [index + 1]);
  }

  /** The landed parts no reviewer finished, with the files and the reason (for the receipt and /crew). A part counts as
   * reviewed only when its reviewer ended `completed`; a timeout, a failure or a cutoff leaves it here. */
  notReviewed(): PartNotReviewed[] {
    return this.parts.flatMap((part, index) => part.reviewed ? []
      : [{ part: index + 1, files: [...part.files], why: part.notFinished ?? "no reviewer looked at it" }]);
  }

  /** What a fix builder is given for part `n` (the stored review, if any, and the fixer's rule), or why it can't have
   * one. The part's one fix round is spent: give it back with `releaseFix` when the builder never started. */
  fixContext(n: number): PartReview {
    const part = this.parts[n - 1];
    if (!part) return { refusal: `Part ${n} has nothing to fix: only a part a builder landed has a number, and a kept or failed builder's work has none. Fix it yourself.` };
    if (part.fixed) return { refusal: `Part ${n} already had its fix round (one fix round per part); fix the rest yourself.` };
    part.fixed = true;
    const report = part.report?.trim();
    const found = problemCount(report);
    return { said: report ? `The reviewer found ${found === undefined ? "problems" : `${found} problem${found === 1 ? "" : "s"}`}; a builder is fixing them` : `A builder is fixing part ${n}`,
      context: [
      `Part ${n}, landed in the project folder by a builder earlier in this task (not committed): ${part.files.slice(0, 40).join(", ")}`,
      FIX_RULE,
      report ? `The reviewer's report:\n${report.length > PART_REPORT_BYTES ? `${report.slice(0, PART_REPORT_BYTES)}\n[The report is cut here.]` : report}`
        : "No reviewer looked at this part; the findings are in the lead's context below.",
    ].join("\n\n") };
  }

  /** A fix that did not start is not counted. */
  releaseFix(n: number): void {
    const part = this.parts[n - 1];
    if (part) part.fixed = false;
  }

  /** A fix landed on part `n`: its diff is the new one, the part is a new version (the old report is dropped, and a
   * review that started on the old one no longer counts), and one review of it is allowed. Returns the files the fix
   * touched that the part had not (a note for the receipt; nothing is undone). */
  refreshExcerpt(n: number, patch: Buffer, change?: { files: string[]; stat: string }): string[] {
    const part = this.parts[n - 1];
    if (!part) return [];
    part.excerpt = `(The diff of the fix round, on top of the part's earlier change.)\n${excerptOf(patch)}`;
    part.version++;
    part.started = 0;
    part.reviewed = false;
    part.notFinished = undefined;
    part.report = undefined;
    if (!change) return [];
    const outside = change.files.filter((file) => !part.files.includes(file));
    part.files.push(...outside);
    part.fixStat = change.stat;
    return outside;
  }
}
