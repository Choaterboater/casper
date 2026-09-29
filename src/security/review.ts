import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parentsStayInside } from "../platform/files";
import { terminalText } from "../tui/format";
import type { SecurityFinding } from "./types";

/**
 * Host-side checks for the optional model review (the review runner itself is wired later, after the
 * shell sandbox and the wider secret scrub). A model finding is shown only when it names a real file:line
 * inside the repo and a concrete example input. Everything else is counted as "not shown". Model findings
 * are always labelled as such and are never counted as tool results.
 */

export interface ModelFinding { file: string; line: number; input: string; why: string }

export const MODEL_FINDING_LABEL = "(model finding, not checked by a tool)";

/** Inputs that name no concrete value. */
const PLACEHOLDER = /^(?:<[^>]*>|\.\.\.|…|n\/?a|none|null|undefined|todo|tbd|example|any|anything|input|user input|some input|malicious input|payload|x|foo|bar|test|value|string)$/i;

export function isConcreteInput(input: unknown): input is string {
  if (typeof input !== "string") return false;
  const trimmed = input.trim();
  return trimmed.length >= 3 && !PLACEHOLDER.test(trimmed.replace(/^["'`]|["'`]$/g, "").trim());
}

async function lineCount(file: string): Promise<number> {
  const text = await readFile(file, "utf8");
  return text.length ? text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0) : 0;
}

/**
 * Keeps a model finding only when its file resolves inside the root with no link out, the line exists,
 * the input is concrete and a reason is given. Returns the kept findings and how many were dropped.
 */
export async function validateModelFindings(root: string, raw: unknown): Promise<{ kept: ModelFinding[]; dropped: number }> {
  const items = Array.isArray(raw) ? raw : [];
  const realRoot = await realpath(root);
  const kept: ModelFinding[] = [];
  let dropped = 0;
  for (const item of items) {
    const candidate = item as Partial<ModelFinding> | null;
    const ok = await (async () => {
      if (!candidate || typeof candidate.file !== "string" || !candidate.file.trim()) return false;
      if (typeof candidate.line !== "number" || !Number.isInteger(candidate.line) || candidate.line < 1) return false;
      if (!isConcreteInput(candidate.input) || typeof candidate.why !== "string" || !candidate.why.trim()) return false;
      const relative = path.isAbsolute(candidate.file) ? path.relative(realRoot, candidate.file) : path.normalize(candidate.file);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
      if (!(await parentsStayInside(realRoot, relative))) return false;
      const full = path.join(realRoot, relative);
      const details = await lstat(full).catch(() => undefined);
      if (!details?.isFile()) return false;
      const resolved = await realpath(full).catch(() => undefined);
      if (!resolved || !resolved.startsWith(`${realRoot}${path.sep}`)) return false;
      if (candidate.line > await lineCount(full).catch(() => 0)) return false;
      candidate.file = relative.split(path.sep).join("/");
      return true;
    })();
    if (ok) kept.push({ file: candidate!.file!, line: candidate!.line!, input: candidate!.input!.trim(), why: candidate!.why!.trim() });
    else dropped++;
  }
  return { kept, dropped };
}

export function formatModelFinding(finding: ModelFinding): string {
  return `${terminalText(finding.file)}:${finding.line}  ${terminalText(finding.why)} Example input: ${terminalText(finding.input)}  ${MODEL_FINDING_LABEL}`;
}

export function droppedLine(dropped: number): string | undefined {
  if (!dropped) return undefined;
  return `${dropped} model finding${dropped === 1 ? "" : "s"} not shown: no file:line or no example input.`;
}

/** Files the model review must never read until the secret scrub covers them. */
const PRIVATE_NAME = /^(\.env(\..*)?|\.envrc|\.netrc|\.pgpass|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn)|credentials(\..*)?|secrets?\.(json|ya?ml|toml|env)|.*\.tfvars|terraform\.tfstate(\.backup)?)$/i;

/** Whether the model review may read this repo file. Files gitleaks flagged are always denied. */
export function reviewMayRead(relative: string, toolFindings: readonly SecurityFinding[] = []): boolean {
  const name = path.posix.basename(relative.split(path.sep).join("/"));
  if (PRIVATE_NAME.test(name)) return false;
  return !toolFindings.some((finding) => finding.tool === "gitleaks" && finding.file === relative.split(path.sep).join("/"));
}
